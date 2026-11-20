import type { Pool } from 'pg';

export const PRESENCE_TTL_SECONDS = 90;
export type MobileDatabase = Pick<Pool, 'query' | 'connect'>;

// Derive presence on every read so crashes and lost disconnect requests expire
// even when no background job is running on a serverless deployment.
const userFields = `
  u.id, u.name, u.username, u.plan, u.blocked,
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

export async function reportPresence(database: MobileDatabase, token: string, connected: boolean, sequence: number, cumulativeBytes?: number) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const session = await client.query<any>(
      `SELECT s.user_id, s.vpn_sequence, u.name, u.username, u.plan, u.blocked, u.subscription_started_at,
        u.subscription_expires_at,(u.subscription_expires_at>NOW()) AS subscription_time_active,
        u.subscription_quota_bytes, u.subscription_used_bytes
       FROM app_user_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token = $1 AND (s.expires_at IS NULL OR s.expires_at > NOW()) FOR UPDATE OF s,u`,
      [token],
    );
    const row = session.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { authorized: false, applied: false };
    }
    // A late heartbeat must not change connection state, but a newer cumulative
    // byte counter can still contain valid usage and should be accounted for.
    const stale = sequence <= Number(row.vpn_sequence);
    let used = BigInt(row.subscription_used_bytes || 0);
    const quota = BigInt(row.subscription_quota_bytes || 0);
    if (connected && cumulativeBytes !== undefined) {
      const prior = await client.query<any>('SELECT cumulative_bytes FROM mobile_usage_reports WHERE user_id=$1 AND token=$2 FOR UPDATE', [row.user_id, token]);
      const incoming = BigInt(cumulativeBytes);
      let delta = incoming;
      if (prior.rows[0]) {
        const previous = BigInt(prior.rows[0].cumulative_bytes);
        delta = incoming >= previous ? incoming - previous : stale ? 0n : incoming;
      }
      if (!stale || !prior.rows[0] || incoming > BigInt(prior.rows[0].cumulative_bytes)) {
        await client.query(`INSERT INTO mobile_usage_reports(user_id,token,sequence,cumulative_bytes) VALUES($1,$2,$3,$4)
          ON CONFLICT(user_id,token) DO UPDATE SET sequence=GREATEST(mobile_usage_reports.sequence,EXCLUDED.sequence),
          cumulative_bytes=CASE WHEN $5 THEN GREATEST(mobile_usage_reports.cumulative_bytes,EXCLUDED.cumulative_bytes)
            ELSE EXCLUDED.cumulative_bytes END,updated_at=NOW()`,
        [row.user_id,token,sequence,cumulativeBytes,stale]);
      }
      used = used + delta > quota ? quota : used + delta;
      if (delta > 0n) {
        await client.query('UPDATE users SET subscription_used_bytes=$1 WHERE id=$2', [used.toString(),row.user_id]);
        row.subscription_used_bytes = used.toString();
      }
    }
    if (stale) {
      await client.query('COMMIT');
      return { authorized: true, applied: false, subscription: subscriptionOf(row) };
    }
    const active = Boolean(row.subscription_time_active);
    if (connected && (row.blocked || !active || used >= quota)) {
      await client.query(`UPDATE app_user_sessions SET vpn_connected=FALSE,vpn_heartbeat_at=NULL,vpn_sequence=$2 WHERE token=$1`, [token,sequence]);
      await client.query('COMMIT');
      return { authorized: true, applied: false, denied: true, subscription: { ...subscriptionOf(row), canConnect: false } };
    }
    const canConnect = !row.blocked && active && used < quota;
    await client.query(
      `UPDATE app_user_sessions
       SET vpn_connected = $2, vpn_heartbeat_at = CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
           vpn_sequence = $3 WHERE token = $1`,
      [token, connected && canConnect, sequence],
    );
    if (connected) {
      await client.query('UPDATE users SET last_vpn_seen = clock_timestamp() WHERE id = $1', [row.user_id]);
    }
    await client.query('COMMIT');
    const subscription = subscriptionOf(row);
    return { authorized: true, applied: true, subscription, denied: connected && !subscription.canConnect };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function subscriptionOf(row: any) {
  const quota = BigInt(row.subscription_quota_bytes || 0), used = BigInt(row.subscription_used_bytes || 0);
  const timeActive = Boolean(row.subscription_time_active);
  const canConnect = Boolean(!row.blocked && timeActive && used < quota);
  return { id: row.user_id, name: row.name, username: row.username, plan: row.plan,
    subscriptionStartedAt: row.subscription_started_at, subscriptionExpiresAt: row.subscription_expires_at,
    subscriptionQuotaBytes: quota.toString(), subscriptionUsedBytes: used.toString(), blocked: Boolean(row.blocked),
    subscriptionTimeActive: timeActive, canConnect, exhausted: used >= quota };
}
