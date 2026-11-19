import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
});

let initialization: Promise<void> | undefined;

async function initializeDatabase() {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    throw new Error('DATABASE_URL یا POSTGRES_URL تنظیم نشده است.');
  }
  if (!initialization) {
    initialization = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admins (
          username TEXT PRIMARY KEY,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          admin_username TEXT NOT NULL REFERENCES admins(username) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
          id BIGSERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          username TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN ('آنلاین', 'آفلاین')),
          plan TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
          id BIGSERIAL PRIMARY KEY,
          author TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx ON chat_messages(created_at);
      `);
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_user_sessions (
          token TEXT PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL
        )
      `);
      const username = process.env.ADMIN_USERNAME || 'ehsan';
      const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || '232111Eee@', 10);
      await pool.query(
        'INSERT INTO admins (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
        [username, passwordHash],
      );
      const count = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
      if (count.rows[0]?.count === '0') {
        await pool.query(`
          INSERT INTO users (name, username, status, plan, last_seen) VALUES
          ('آرمان رضایی', 'arman.r', 'آنلاین', 'حرفه‌ای', 'هم‌اکنون'),
          ('سارا محمدی', 'sara.m', 'آنلاین', 'پایه', 'هم‌اکنون'),
          ('نیما کریمی', 'nima.k', 'آفلاین', 'حرفه‌ای', '۲ ساعت پیش'),
          ('نگار احمدی', 'negar.a', 'آنلاین', 'آزمایشی', 'هم‌اکنون'),
          ('پارسا حیدری', 'parsa.h', 'آفلاین', 'پایه', 'دیروز'),
          ('یلدا موسوی', 'yalda.m', 'آنلاین', 'حرفه‌ای', 'هم‌اکنون')
          ON CONFLICT (username) DO NOTHING
        `);
      }
    })().catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

function reply(res: any, status: number, data: unknown) {
  res.status(status).json(data);
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    await initializeDatabase();
    const pathname = new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();

    if (pathname === '/api/health' && method === 'GET') {
      await pool.query('SELECT 1');
      return reply(res, 200, { status: 'ok', database: 'connected' });
    }

    if (pathname === '/api/mobile/register' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const name = String(body.name || '').trim();
      const username = String(body.identity || '').trim().toLowerCase();
      const password = body.password;
      if (name.length < 2 || name.length > 80) {
        return reply(res, 400, { message: 'نام باید بین ۲ تا ۸۰ نویسه باشد.' });
      }
      const validEmail = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(username);
      const validUsername = username.length <= 64 && /^[a-z0-9._+-]+$/.test(username);
      if (username.length < 3 || username.length > 254 || (!validEmail && !validUsername)) {
        return reply(res, 400, { message: 'ایمیل یا نام کاربری معتبر وارد کنید.' });
      }
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        return reply(res, 400, { message: 'رمز عبور باید حداقل ۸ نویسه باشد.' });
      }
      try {
        const passwordHash = await bcrypt.hash(password, 10);
        const created = await pool.query<{ id: string; name: string; username: string }>(
          `INSERT INTO users (name, username, status, plan, last_seen, password_hash)
           VALUES ($1, $2, 'آفلاین', 'آزمایشی', 'هم‌اکنون', $3)
           RETURNING id, name, username`,
          [name, username, passwordHash],
        );
        const user = created.rows[0];
        const token = crypto.randomUUID();
        await pool.query(
          "INSERT INTO app_user_sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
          [token, user.id],
        );
        return reply(res, 201, { token, id: user.id, name: user.name, username: user.username });
      } catch (error: any) {
        if (error?.code === '23505') {
          return reply(res, 409, { message: 'این ایمیل یا نام کاربری قبلاً ثبت شده است.' });
        }
        throw error;
      }
    }

    if (pathname === '/api/mobile/login' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const username = String(body.identity || '').trim().toLowerCase();
      const password = body.password;
      const found = await pool.query<{ id: string; name: string; username: string; password_hash: string | null }>(
        'SELECT id, name, username, password_hash FROM users WHERE username = $1',
        [username],
      );
      const user = found.rows[0];
      if (typeof password !== 'string' || !user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
        return reply(res, 401, { message: 'ایمیل/نام کاربری یا رمز عبور اشتباه است.' });
      }
      const token = crypto.randomUUID();
      await pool.query(
        "INSERT INTO app_user_sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
        [token, user.id],
      );
      await pool.query("UPDATE users SET status = 'آنلاین', last_seen = 'هم‌اکنون' WHERE id = $1", [user.id]);
      return reply(res, 200, { token, id: user.id, name: user.name, username: user.username });
    }

    if (pathname === '/api/mobile/logout' && method === 'POST') {
      const token = String(req.headers?.authorization || '').replace(/^Bearer\\s+/i, '');
      if (token) {
        await pool.query('DELETE FROM app_user_sessions WHERE token = $1', [token]);
        await pool.query(
          `UPDATE users SET status = 'آفلاین'
           WHERE password_hash IS NOT NULL
             AND id NOT IN (SELECT user_id FROM app_user_sessions WHERE expires_at > NOW())`,
        );
      }
      return reply(res, 200, { success: true });
    }

    if (pathname === '/api/mobile/me' && method === 'GET') {
      const token = String(req.headers?.authorization || '').replace(/^Bearer\\s+/i, '');
      if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
      const result = await pool.query<{ id: string; name: string; username: string }>(
        `SELECT u.id, u.name, u.username FROM app_user_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token],
      );
      if (!result.rows[0]) return reply(res, 401, { message: 'نشست شما منقضی شده است.' });
      return reply(res, 200, result.rows[0]);
    }

    if (pathname === '/api/login' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const username = body.username;
      const password = body.password;
      const found = await pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM admins WHERE username = $1',
        [username],
      );
      if (typeof password !== 'string' || !found.rows[0] || !(await bcrypt.compare(password, found.rows[0].password_hash))) {
        return reply(res, 401, { message: 'نام کاربری یا رمز عبور اشتباه است.' });
      }
      const token = crypto.randomUUID();
      await pool.query(
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
    const session = await pool.query(
      'SELECT 1 FROM sessions WHERE token = $1 AND expires_at > NOW()',
      [token],
    );
    if (!session.rowCount) return reply(res, 401, { message: 'نشست شما منقضی شده است؛ دوباره وارد شوید.' });

    if (pathname === '/api/users' && method === 'GET') {
      const users = await pool.query(
        'SELECT id, name, username, status, plan, last_seen AS "lastSeen" FROM users ORDER BY id DESC',
      );
      return reply(res, 200, users.rows);
    }

    if (pathname === '/api/users' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const name = String(body.name || '').trim();
      const username = String(body.username || '').trim().toLowerCase();
      const password = body.password;
      const plan = String(body.plan || 'آزمایشی');
      const validEmail = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(username);
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
        const created = await pool.query(
          `INSERT INTO users (name, username, status, plan, last_seen, password_hash)
           VALUES ($1, $2, 'آفلاین', $3, 'هنوز وارد نشده', $4)
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
      const status = String(body.status || '');
      const plan = String(body.plan || '');
      const password = typeof body.password === 'string' ? body.password : '';
      const validEmail = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(username);
      const validUsername = username.length <= 64 && /^[a-z0-9._+-]+$/.test(username);
      if (!/^\\d+$/.test(id)) return reply(res, 400, { message: 'شناسه کاربر معتبر نیست.' });
      if (name.length < 2 || name.length > 80) return reply(res, 400, { message: 'نام باید بین ۲ تا ۸۰ نویسه باشد.' });
      if (username.length < 3 || username.length > 254 || (!validEmail && !validUsername)) {
        return reply(res, 400, { message: 'ایمیل یا نام کاربری معتبر وارد کنید.' });
      }
      if (!['آنلاین', 'آفلاین'].includes(status)) return reply(res, 400, { message: 'وضعیت کاربر معتبر نیست.' });
      if (!['آزمایشی', 'پایه', 'حرفه‌ای'].includes(plan)) return reply(res, 400, { message: 'نوع اشتراک معتبر نیست.' });
      if (password && (password.length < 8 || password.length > 128)) {
        return reply(res, 400, { message: 'رمز تازه باید حداقل ۸ نویسه باشد.' });
      }
      try {
        const passwordHash = password ? await bcrypt.hash(password, 10) : null;
        const updated = await pool.query(
          `UPDATE users
           SET name = $1, username = $2, status = $3, plan = $4,
               password_hash = COALESCE($5, password_hash)
           WHERE id = $6
           RETURNING id, name, username, status, plan, last_seen AS "lastSeen"`,
          [name, username, status, plan, passwordHash, id],
        );
        if (!updated.rows[0]) return reply(res, 404, { message: 'کاربر پیدا نشد.' });
        return reply(res, 200, updated.rows[0]);
      } catch (error: any) {
        if (error?.code === '23505') return reply(res, 409, { message: 'این ایمیل یا نام کاربری قبلاً ثبت شده است.' });
        throw error;
      }
    }

    if (pathname === '/api/users' && method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!/^\\d+$/.test(id)) return reply(res, 400, { message: 'شناسه کاربر معتبر نیست.' });
      const deleted = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
      if (!deleted.rows[0]) return reply(res, 404, { message: 'کاربر پیدا نشد.' });
      return reply(res, 200, { success: true, id: deleted.rows[0].id });
    }

    if (pathname === '/api/chat' && method === 'GET') {
      const messages = await pool.query(
        'SELECT id, author, message AS text, created_at AS time FROM chat_messages ORDER BY created_at DESC LIMIT 100',
      );
      return reply(res, 200, messages.rows.reverse());
    }

    if (pathname === '/api/chat' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const message = String(body.message || '').trim();
      if (!message) return reply(res, 400, { message: 'پیام خالی است.' });
      const inserted = await pool.query(
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
}
