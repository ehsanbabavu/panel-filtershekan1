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
  try {
    await initializeDatabase();
    const pathname = new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();

    if (pathname === '/api/health' && method === 'GET') {
      await pool.query('SELECT 1');
      return reply(res, 200, { status: 'ok', database: 'connected' });
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
        'SELECT id, name, username, status, plan, last_seen AS "lastSeen" FROM users ORDER BY id',
      );
      return reply(res, 200, users.rows);
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
