import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export async function initializeSchema(database: Pick<Pool, 'query'>) {
  await database.query(`
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_vpn_seen TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS app_user_sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    );
    ALTER TABLE app_user_sessions ALTER COLUMN expires_at DROP NOT NULL;
    ALTER TABLE app_user_sessions ADD COLUMN IF NOT EXISTS vpn_connected BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE app_user_sessions ADD COLUMN IF NOT EXISTS vpn_heartbeat_at TIMESTAMPTZ;
    ALTER TABLE app_user_sessions ADD COLUMN IF NOT EXISTS vpn_sequence BIGINT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS app_user_sessions_user_id_idx ON app_user_sessions(user_id);
  `);
  // Existing mobile accounts stay signed in; a login is separate from VPN presence.
  await database.query('UPDATE app_user_sessions SET expires_at = NULL WHERE expires_at IS NOT NULL');
  const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || '232111Eee@', 10);
  await database.query(
    'INSERT INTO admins (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
    [process.env.ADMIN_USERNAME || 'ehsan', adminHash],
  );
  const count = await database.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  if (count.rows[0]?.count === '0') {
    await database.query(`
      INSERT INTO users (name, username, status, plan, last_seen) VALUES
      ('آرمان رضایی', 'arman.r', 'آفلاین', 'حرفه‌ای', 'هنوز متصل نشده'),
      ('سارا محمدی', 'sara.m', 'آفلاین', 'پایه', 'هنوز متصل نشده'),
      ('نیما کریمی', 'nima.k', 'آفلاین', 'حرفه‌ای', 'هنوز متصل نشده'),
      ('نگار احمدی', 'negar.a', 'آفلاین', 'آزمایشی', 'هنوز متصل نشده'),
      ('پارسا حیدری', 'parsa.h', 'آفلاین', 'پایه', 'هنوز متصل نشده'),
      ('یلدا موسوی', 'yalda.m', 'آفلاین', 'حرفه‌ای', 'هنوز متصل نشده')
      ON CONFLICT (username) DO NOTHING
    `);
  }
}

let initialization: Promise<void> | undefined;
export function initializeDatabase() {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    return Promise.reject(new Error('DATABASE_URL یا POSTGRES_URL تنظیم نشده است.'));
  }
  if (!initialization) {
    initialization = initializeSchema(pool).catch(error => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}
