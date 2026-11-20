import { initializeDatabase, pool } from '../server/database.js';

function reply(res: any, status: number, body: unknown) {
  return res.status(status).json(body);
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'PATCH'].includes(String(req.method))) return reply(res, 405, { message: 'روش درخواست پشتیبانی نمی‌شود.' });

  try {
    await initializeDatabase();
    const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
    const session = await pool.query('SELECT 1 FROM sessions WHERE token=$1 AND expires_at>NOW()', [token]);
    if (!session.rowCount) return reply(res, 401, { message: 'نشست شما منقضی شده است؛ دوباره وارد شوید.' });

    if (req.method === 'GET') {
    const subscriptions = await pool.query(`SELECT u.id AS "userId",u.name AS "userName",u.username,
      p.id AS "planId",p.name AS "planName",p.duration_days AS "durationDays",
      u.subscription_started_at AS "startedAt",u.subscription_expires_at AS "expiresAt",
      u.subscription_quota_bytes AS "quotaBytes",u.subscription_used_bytes AS "usedBytes",u.blocked,
      (u.subscription_expires_at>NOW() AND u.subscription_used_bytes<u.subscription_quota_bytes) AS active
      FROM users u LEFT JOIN subscription_plans p ON p.name=u.plan
      WHERE u.subscription_started_at IS NOT NULL
      ORDER BY u.subscription_started_at DESC,u.id DESC`);
    return reply(res, 200, subscriptions.rows);
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const userId = Number(body.userId), planId = Number(body.planId), durationDays = Number(body.durationDays), quotaBytes = Number(body.quotaBytes);
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(planId) || planId < 1 ||
        !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650 || !Number.isSafeInteger(quotaBytes) || quotaBytes < 1) {
      return reply(res, 400, { message: 'مشخصات اشتراک معتبر نیست.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const plan = (await client.query<any>('SELECT * FROM subscription_plans WHERE id=$1 AND active=true', [planId])).rows[0];
      if (!plan) { await client.query('ROLLBACK'); return reply(res, 404, { message: 'پلن فعال پیدا نشد.' }); }
      const user = (await client.query<any>('SELECT id,subscription_used_bytes FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      if (!user) { await client.query('ROLLBACK'); return reply(res, 404, { message: 'کاربر پیدا نشد.' }); }
      const usedBytes = String(user.subscription_used_bytes || 0);
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + durationDays * 86400000);
      await client.query("UPDATE user_subscriptions SET status='cancelled',used_bytes=$2 WHERE user_id=$1 AND status='active'", [userId, usedBytes]);
      const subscription = (await client.query<any>(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status)
        VALUES($1,$2,$3,$4,$5,$6,'active') RETURNING id,user_id AS "userId",plan_id AS "planId",started_at AS "startedAt",expires_at AS "expiresAt",quota_bytes AS "quotaBytes",used_bytes AS "usedBytes",status`,
      [userId, planId, startedAt, expiresAt, quotaBytes, usedBytes])).rows[0];
      await client.query(`UPDATE users SET plan=$2,subscription_started_at=$3,subscription_expires_at=$4,
        subscription_quota_bytes=$5,subscription_used_bytes=$6 WHERE id=$1`, [userId, plan.name, startedAt, expiresAt, quotaBytes, usedBytes]);
      await client.query('COMMIT');
      return reply(res, 200, { ...subscription, planName: plan.name, durationDays });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  } catch (error) {
    console.error('User subscriptions API failed:', error);
    return reply(res, 503, { message: 'دریافت اشتراک کاربران از پایگاه داده انجام نشد.' });
  }
}
