import { initializeDatabase, pool } from '../../server/database.js';

function reply(res: any, status: number, body: unknown) {
  return res.status(status).json(body);
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return reply(res, 405, { message: 'روش درخواست پشتیبانی نمی‌شود.' });

  try {
    await initializeDatabase();
    const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
    const session = await pool.query('SELECT 1 FROM sessions WHERE token=$1 AND expires_at>NOW()', [token]);
    if (!session.rowCount) return reply(res, 401, { message: 'نشست شما منقضی شده است؛ دوباره وارد شوید.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const userId = Number(body.userId);
    if (!Number.isSafeInteger(userId) || userId < 1 || typeof body.blocked !== 'boolean') {
      return reply(res, 400, { message: 'شناسه کاربر یا وضعیت مسدودسازی معتبر نیست.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query('UPDATE users SET blocked=$2 WHERE id=$1 RETURNING id,blocked', [userId, body.blocked]);
      if (!updated.rows[0]) {
        await client.query('ROLLBACK');
        return reply(res, 404, { message: 'کاربر پیدا نشد.' });
      }
      if (body.blocked) {
        await client.query('UPDATE app_user_sessions SET vpn_connected=FALSE,vpn_heartbeat_at=NULL WHERE user_id=$1', [userId]);
      }
      await client.query('COMMIT');
      return reply(res, 200, { success: true, userId: String(userId), blocked: Boolean(updated.rows[0].blocked) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('User subscription access update failed:', error);
    return reply(res, 503, { message: 'ذخیره تغییر دسترسی در پایگاه داده انجام نشد.' });
  }
}
