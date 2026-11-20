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

    const conversations = await pool.query(`SELECT u.id AS "userId",u.name,u.username,
      latest.message AS "lastMessage",latest.created_at AS "lastMessageAt",
      (SELECT COUNT(*)::int FROM chat_messages unread WHERE unread.user_id=u.id AND unread.sender_role='user' AND unread.read_by_admin=FALSE) AS "unreadCount"
      FROM users u LEFT JOIN LATERAL (SELECT message,created_at FROM chat_messages m WHERE m.user_id=u.id ORDER BY m.id DESC LIMIT 1) latest ON TRUE
      WHERE latest.message IS NOT NULL
      ORDER BY latest.created_at DESC NULLS LAST,u.id DESC`);
    return reply(res, 200, conversations.rows);
  } catch (error) {
    console.error('Admin chat conversations failed:', error);
    return reply(res, 503, { message: 'دریافت فهرست گفتگوها از پایگاه داده انجام نشد.' });
  }
}
