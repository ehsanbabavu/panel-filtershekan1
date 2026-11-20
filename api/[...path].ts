import bcrypt from 'bcryptjs';
import { initializeDatabase, pool } from '../server/database.js';
import { handleMobileRequest } from '../server/mobile.js';
import { selectUsers, type MobileDatabase } from '../server/presence.js';

function reply(res: any, status: number, data: unknown) {
  res.status(status).json(data);
}

export function createApiHandler(database: MobileDatabase, initialize: () => Promise<void>) {
return async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    await initialize();
    const pathname = new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();

    if (pathname === '/api/health' && method === 'GET') {
      await database.query('SELECT 1');
      return reply(res, 200, { status: 'ok', database: 'connected' });
    }

    if (pathname.startsWith('/api/mobile/')) {
      return await handleMobileRequest(pathname.split('/')[3].toLowerCase(), req, res, database);
    }

    if (pathname === '/api/login' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const username = body.username;
      const password = body.password;
      const found = await database.query<{ password_hash: string }>(
        'SELECT password_hash FROM admins WHERE username = $1',
        [username],
      );
      if (typeof password !== 'string' || !found.rows[0] || !(await bcrypt.compare(password, found.rows[0].password_hash))) {
        return reply(res, 401, { message: 'نام کاربری یا رمز عبور اشتباه است.' });
      }
      const token = crypto.randomUUID();
      await database.query(
        "INSERT INTO sessions (token, admin_username, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
        [token, username],
      );
      return reply(res, 200, { token, username });
    }

    if (pathname === '/api/subscriptions' && method === 'GET') {
      return reply(res, 200, [
        { name: 'حرفه‌ای', users: 128, price: '۲۹۹٬۰۰۰', color: 'violet', change: '+۱۲٪' },
        { name: 'پایه', users: 86, price: '۱۴۹٬۰۰۰', color: 'blue', change: '+۸٪' },
        { name: 'آزمایشی', users: 34, price: 'رایگان', color: 'amber', change: '+۳٪' },
      ]);
    }

    const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
    const session = await database.query(
      'SELECT 1 FROM sessions WHERE token = $1 AND expires_at > NOW()',
      [token],
    );
    if (!session.rowCount) return reply(res, 401, { message: 'نشست شما منقضی شده است؛ دوباره وارد شوید.' });

    if (pathname === '/api/users' && method === 'GET') {
      const users = await selectUsers(database);
      return reply(res, 200, users.rows);
    }

    if (pathname === '/api/users' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const name = String(body.name || '').trim();
      const username = String(body.username || '').trim().toLowerCase();
      const password = body.password;
      const plan = String(body.plan || 'آزمایشی');
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);
      const validUsername = username.length <= 64 && /^[a-z0-9._+-]+$/.test(username);
      if (name.length < 2 || name.length > 80) return reply(res, 400, { message: 'نام باید بین ۲ تا ۸۰ نویسه باشد.' });
      if (username.length < 3 || username.length > 254 || (!validEmail && !validUsername)) {
        return reply(res, 400, { message: 'ایمیل یا نام کاربری معتبر وارد کنید.' });
      }
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        return reply(res, 400, { message: 'رمز عبور باید حداقل ۸ نویسه باشد.' });
      }
      if (!['آزمایشی', 'پایه', 'حرفه‌ای'].includes(plan)) return reply(res, 400, { message: 'نوع اشتراک معتبر نیست.' });
      try {
        const passwordHash = await bcrypt.hash(password, 10);
        const created = await database.query(
          `INSERT INTO users (name, username, status, plan, last_seen, password_hash)
           VALUES ($1, $2, 'آفلاین', $3, 'هنوز متصل نشده', $4)
           RETURNING id, name, username, status, plan, last_seen AS "lastSeen"`,
          [name, username, plan, passwordHash],
        );
        return reply(res, 201, created.rows[0]);
      } catch (error: any) {
        if (error?.code === '23505') return reply(res, 409, { message: 'این ایمیل یا نام کاربری قبلاً ثبت شده است.' });
        throw error;
      }
    }

    if (pathname === '/api/users' && method === 'PATCH') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const id = String(req.query?.id || body.id || '');
      const name = String(body.name || '').trim();
      const username = String(body.username || '').trim().toLowerCase();
      const plan = String(body.plan || '');
      const password = typeof body.password === 'string' ? body.password : '';
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);
      const validUsername = username.length <= 64 && /^[a-z0-9._+-]+$/.test(username);
      if (!/^\d+$/.test(id)) return reply(res, 400, { message: 'شناسه کاربر معتبر نیست.' });
      if (name.length < 2 || name.length > 80) return reply(res, 400, { message: 'نام باید بین ۲ تا ۸۰ نویسه باشد.' });
      if (username.length < 3 || username.length > 254 || (!validEmail && !validUsername)) {
        return reply(res, 400, { message: 'ایمیل یا نام کاربری معتبر وارد کنید.' });
      }
      if (!['آزمایشی', 'پایه', 'حرفه‌ای'].includes(plan)) return reply(res, 400, { message: 'نوع اشتراک معتبر نیست.' });
      if (password && (password.length < 8 || password.length > 128)) {
        return reply(res, 400, { message: 'رمز تازه باید حداقل ۸ نویسه باشد.' });
      }
      try {
        const passwordHash = password ? await bcrypt.hash(password, 10) : null;
        const updated = await database.query(
          `UPDATE users
           SET name = $1, username = $2, plan = $3,
               password_hash = COALESCE($4, password_hash)
           WHERE id = $5 RETURNING id`,
          [name, username, plan, passwordHash, id],
        );
        if (!updated.rows[0]) return reply(res, 404, { message: 'کاربر پیدا نشد.' });
        const user = await selectUsers(database, id);
        return reply(res, 200, user.rows[0]);
      } catch (error: any) {
        if (error?.code === '23505') return reply(res, 409, { message: 'این ایمیل یا نام کاربری قبلاً ثبت شده است.' });
        throw error;
      }
    }

    if (pathname === '/api/users' && method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!/^\d+$/.test(id)) return reply(res, 400, { message: 'شناسه کاربر معتبر نیست.' });
      const deleted = await database.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
      if (!deleted.rows[0]) return reply(res, 404, { message: 'کاربر پیدا نشد.' });
      return reply(res, 200, { success: true, id: deleted.rows[0].id });
    }

    if (pathname === '/api/chat' && method === 'GET') {
      const messages = await database.query(
        'SELECT id, author, message AS text, created_at AS time FROM chat_messages ORDER BY created_at DESC LIMIT 100',
      );
      return reply(res, 200, messages.rows.reverse());
    }

    if (pathname === '/api/chat' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const message = String(body.message || '').trim();
      if (!message) return reply(res, 400, { message: 'پیام خالی است.' });
      const inserted = await database.query(
        "INSERT INTO chat_messages (author, message) VALUES ('شما', $1) RETURNING id, author, message AS text, created_at AS time",
        [message],
      );
      return reply(res, 200, inserted.rows[0]);
    }

    return reply(res, 404, { message: 'مسیر پیدا نشد.' });
  } catch (error) {
    console.error('API request failed:', error);
    return reply(res, 503, { message: 'خطا در اتصال به پایگاه داده یا اجرای درخواست.' });
  }
};
}

export default createApiHandler(pool, initializeDatabase);
