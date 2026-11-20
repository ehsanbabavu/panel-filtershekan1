import { initializeDatabase, pool } from '../../server/database.js';

function reply(res: any, status: number, body: unknown) {
  return res.status(status).json(body);
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return reply(res, 405, { message: 'روش درخواست پشتیبانی نمی‌شود.' });

  try {
    await initializeDatabase();
    const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
    const session = await pool.query('SELECT 1 FROM sessions WHERE token=$1 AND expires_at>NOW()', [token]);
    if (!session.rowCount) return reply(res, 401, { message: 'نشست شما منقضی شده است؛ دوباره وارد شوید.' });

    const result = await pool.query("SELECT COUNT(DISTINCT user_id)::int AS count FROM chat_messages WHERE sender_role='user' AND read_by_admin=FALSE AND user_id IS NOT NULL");
    return reply(res, 200, result.rows[0] || { count: 0 });
  } catch (error) {
    console.error('Admin unread chat count failed:', error);
    return reply(res, 503, { message: 'دریافت آمار گفتگوها از پایگاه داده انجام نشد.' });
  }
}
