import type { Pool } from 'pg';

export const PRESENCE_TTL_SECONDS = 90;
export type MobileDatabase = Pick<Pool, 'query' | 'connect'>;

// Derive presence on every read so crashes and lost disconnect requests expire
// even when no background job is running on a serverless deployment.
const userFields = `
  u.id, u.name, u.username, u.plan,
  CASE WHEN EXISTS (
    SELECT 1 FROM app_user_sessions s
    WHERE s.user_id = u.id
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND s.vpn_connected
      AND s.vpn_heartbeat_at > NOW() - INTERVAL '${PRESENCE_TTL_SECONDS} seconds'
  ) THEN 'آنلاین' ELSE 'آفلاین' END AS status,
  COALESCE(u.last_vpn_seen::text, 'هنوز متصل نشده') AS "lastSeen"
`;

export function selectUsers(database: Pick<Pool, 'query'>, id?: string) {
  return database.query(
    `SELECT ${userFields} FROM users u ${id ? 'WHERE u.id = $1' : 'ORDER BY u.id DESC'}`,
    id ? [id] : [],
  );
}

export async function reportPresence(database: MobileDatabase, token: string, connected: boolean, sequence: number) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const session = await client.query<{ user_id: string; vpn_sequence: string }>(
      `SELECT user_id, vpn_sequence FROM app_user_sessions
       WHERE token = $1 AND (expires_at IS NULL OR expires_at > NOW()) FOR UPDATE`,
      [token],
    );
    const row = session.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { authorized: false, applied: false };
    }
    // A delayed heartbeat must never undo a newer disconnect.
    if (sequence <= Number(row.vpn_sequence)) {
      await client.query('COMMIT');
      return { authorized: true, applied: false };
    }
    await client.query(
      `UPDATE app_user_sessions
       SET vpn_connected = $2, vpn_heartbeat_at = CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
           vpn_sequence = $3 WHERE token = $1`,
      [token, connected, sequence],
    );
    if (connected) {
      await client.query('UPDATE users SET last_vpn_seen = clock_timestamp() WHERE id = $1', [row.user_id]);
    }
    await client.query('COMMIT');
    return { authorized: true, applied: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
