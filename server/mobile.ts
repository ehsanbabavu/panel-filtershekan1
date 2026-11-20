import bcrypt from 'bcryptjs';
import { reportPresence, type MobileDatabase } from './presence.js';

function reply(res: any, status: number, body: unknown) {
  return res.status(status).json(body);
}

function bodyOf(req: any) {
  return typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
}

export async function handleMobileRequest(action: string, req: any, res: any, database: MobileDatabase) {
  const method = String(req.method || 'GET').toUpperCase();
  if (!['register', 'login', 'me', 'logout', 'presence'].includes(action)) {
    return reply(res, 404, { message: 'مسیر پیدا نشد.' });
  }

  if (action === 'register' && method === 'POST') {
    const body = bodyOf(req);
    const name = String(body.name || '').trim();
    const username = String(body.identity || '').trim().toLowerCase();
    const password = body.password;
    if (name.length < 2 || name.length > 80) {
      return reply(res, 400, { message: 'نام باید بین ۲ تا ۸۰ نویسه باشد.' });
    }
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);
    const validUsername = username.length <= 64 && /^[a-z0-9._+-]+$/.test(username);
    if (username.length < 3 || username.length > 254 || (!validEmail && !validUsername)) {
      return reply(res, 400, { message: 'ایمیل یا نام کاربری معتبر وارد کنید.' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return reply(res, 400, { message: 'رمز عبور باید حداقل ۸ نویسه باشد.' });
    }
    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const created = await database.query<{ id: string; name: string; username: string }>(
        `INSERT INTO users (name, username, status, plan, last_seen, password_hash)
         VALUES ($1, $2, 'آفلاین', 'آزمایشی', 'هنوز متصل نشده', $3)
         RETURNING id, name, username`,
        [name, username, passwordHash],
      );
      const user = created.rows[0];
      const token = crypto.randomUUID();
      await database.query('INSERT INTO app_user_sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
      return reply(res, 201, { token, ...user });
    } catch (error: any) {
      if (error?.code === '23505') return reply(res, 409, { message: 'این ایمیل یا نام کاربری قبلاً ثبت شده است.' });
      throw error;
    }
  }

  if (action === 'login' && method === 'POST') {
    const body = bodyOf(req);
    const username = String(body.identity || '').trim().toLowerCase();
    const password = body.password;
    const found = await database.query<{ id: string; name: string; username: string; password_hash: string | null }>(
      'SELECT id, name, username, password_hash FROM users WHERE username = $1', [username],
    );
    const user = found.rows[0];
    if (typeof password !== 'string' || !user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return reply(res, 401, { message: 'ایمیل/نام کاربری یا رمز عبور اشتباه است.' });
    }
    const token = crypto.randomUUID();
    await database.query('INSERT INTO app_user_sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
    return reply(res, 200, { token, id: user.id, name: user.name, username: user.username });
  }

  const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (action === 'presence' && method === 'POST') {
    if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
    const body = bodyOf(req);
    if (typeof body.connected !== 'boolean' || !Number.isSafeInteger(body.sequence) || body.sequence < 1) {
      return reply(res, 400, { message: 'وضعیت اتصال یا شماره گزارش معتبر نیست.' });
    }
    const result = await reportPresence(database, token, body.connected, body.sequence);
    if (!result.authorized) return reply(res, 401, { message: 'نشست شما منقضی شده است.' });
    return reply(res, 200, { success: true, applied: result.applied });
  }

  if (action === 'me' && method === 'GET') {
    if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
    const result = await database.query<{ id: string; name: string; username: string }>(
      `SELECT u.id, u.name, u.username FROM app_user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND (s.expires_at IS NULL OR s.expires_at > NOW())`, [token],
    );
    if (!result.rows[0]) return reply(res, 401, { message: 'نشست شما منقضی شده است.' });
    return reply(res, 200, result.rows[0]);
  }

  if (action === 'logout' && method === 'POST') {
    if (token) await database.query('DELETE FROM app_user_sessions WHERE token = $1', [token]);
    return reply(res, 200, { success: true });
  }

  return reply(res, 405, { message: 'روش درخواست پشتیبانی نمی‌شود.' });
}

export function createMobileHandler(database: MobileDatabase, initialize: () => Promise<void>) {
  return async (req: any, res: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    const url = new URL(req.originalUrl || req.url || '/', 'http://localhost');
    const action = String(req.query?.action || url.searchParams.get('action') || url.pathname.split('/')[3] || '').toLowerCase();
    try {
      await initialize();
      return await handleMobileRequest(action, req, res, database);
    } catch (error) {
      console.error('Mobile account API failed:', error);
      return reply(res, 503, { message: 'خطا در اتصال به پایگاه داده یا اجرای درخواست.' });
    }
  };
}
