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
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_role TEXT NOT NULL DEFAULT 'admin' CHECK (sender_role IN ('admin','user'));
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS read_by_admin BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS chat_messages_user_created_idx ON chat_messages(user_id,created_at);
    CREATE TABLE IF NOT EXISTS proxy_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), host TEXT NOT NULL, port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
      username TEXT NOT NULL DEFAULT '', password TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bluepal_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      api_key TEXT NOT NULL DEFAULT '',
      merchant_id TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT 'https://blupal.top',
      custom_endpoint TEXT NOT NULL DEFAULT '/api/v1/invoices/create',
      card_number TEXT NOT NULL DEFAULT '', account_holder TEXT NOT NULL DEFAULT '', iban TEXT NOT NULL DEFAULT '',
      webhook_secret TEXT NOT NULL DEFAULT '', custom_webhook_url TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE bluepal_settings ADD COLUMN IF NOT EXISTS custom_endpoint TEXT NOT NULL DEFAULT '/api/v1/invoices/create';
    ALTER TABLE bluepal_settings ADD COLUMN IF NOT EXISTS card_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE bluepal_settings ADD COLUMN IF NOT EXISTS account_holder TEXT NOT NULL DEFAULT '';
    ALTER TABLE bluepal_settings ADD COLUMN IF NOT EXISTS iban TEXT NOT NULL DEFAULT '';
    ALTER TABLE bluepal_settings ADD COLUMN IF NOT EXISTS webhook_secret TEXT NOT NULL DEFAULT '';
    ALTER TABLE bluepal_settings ADD COLUMN IF NOT EXISTS custom_webhook_url TEXT NOT NULL DEFAULT '';
    UPDATE bluepal_settings SET base_url='https://blupal.top',custom_endpoint='/api/v1/invoices/create',merchant_id=''
      WHERE base_url IN ('https://www.bluepal.ir','https://bluepal.ir') AND custom_endpoint='/api/v1/invoices/create';
    CREATE TABLE IF NOT EXISTS proxy_servers (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL,
      port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535), username TEXT NOT NULL DEFAULT '', password TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE, legacy_settings_id INTEGER UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS system_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    INSERT INTO proxy_servers(name,host,port,username,password,active,legacy_settings_id)
      SELECT 'پروکسی اصلی',p.host,p.port,p.username,p.password,TRUE,1 FROM proxy_settings p
      WHERE p.id=1 AND NOT EXISTS(SELECT 1 FROM system_migrations WHERE version='legacy-proxy-to-list-v1')
      ON CONFLICT(legacy_settings_id) DO NOTHING;
    INSERT INTO system_migrations(version) VALUES('legacy-proxy-to-list-v1') ON CONFLICT(version) DO NOTHING;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_vpn_seen TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_quota_bytes BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_used_bytes BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
      price_irr BIGINT NOT NULL DEFAULT 0 CHECK (price_irr >= 0), quota_bytes BIGINT NOT NULL CHECK (quota_bytes > 0),
      duration_days INTEGER NOT NULL CHECK (duration_days > 0), simultaneous_devices INTEGER NOT NULL DEFAULT 1 CHECK (simultaneous_devices > 0),
      features JSONB NOT NULL DEFAULT '[]'::jsonb, active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id BIGINT NOT NULL REFERENCES subscription_plans(id), started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL, quota_bytes BIGINT NOT NULL CHECK (quota_bytes > 0), used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','exhausted','cancelled')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS user_subscriptions_user_active_idx ON user_subscriptions(user_id, expires_at DESC);
    CREATE TABLE IF NOT EXISTS bluepal_payments (
      id BIGSERIAL PRIMARY KEY, public_id UUID NOT NULL UNIQUE, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id BIGINT NOT NULL REFERENCES subscription_plans(id), plan_name TEXT NOT NULL, quota_bytes BIGINT NOT NULL,
      duration_days INTEGER NOT NULL, amount_toman BIGINT NOT NULL CHECK (amount_toman >= 0), amount_rial BIGINT NOT NULL DEFAULT 0,
      track_id TEXT UNIQUE, payment_url TEXT, expires_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired')), reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS bluepal_payments_user_created_idx ON bluepal_payments(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS mobile_usage_reports (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL,
      sequence BIGINT NOT NULL, cumulative_bytes BIGINT NOT NULL CHECK (cumulative_bytes >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id, token)
    );
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
  await database.query(`INSERT INTO subscription_plans(name,description,price_irr,quota_bytes,duration_days,simultaneous_devices,features)
    VALUES ('حرفه‌ای','برای تجربه‌ای کامل و بدون محدودیت',299000,107374182400,30,5,'["۱۰۰ گیگابایت حجم","اتصال هم‌زمان تا ۵ دستگاه","پشتیبانی اولویت‌دار"]'),
    ('پایه','تمام چیزهایی که برای شروع نیاز دارید',149000,107374182400,30,2,'["۱۰۰ گیگابایت حجم","اتصال هم‌زمان تا ۲ دستگاه","پشتیبانی استاندارد"]'),
    ('آزمایشی','آشنایی با سرویس',0,10737418240,7,1,'["۱۰ گیگابایت حجم","اتصال برای ۷ روز","پشتیبانی استاندارد"]') ON CONFLICT(name) DO NOTHING`);
  await database.query(`UPDATE users u SET subscription_started_at=COALESCE(u.subscription_started_at,u.created_at),
    subscription_expires_at=COALESCE(u.subscription_expires_at,u.created_at+CASE WHEN u.plan='آزمایشی' THEN INTERVAL '7 days' ELSE INTERVAL '30 days' END),
    subscription_quota_bytes=COALESCE(u.subscription_quota_bytes,p.quota_bytes)
    FROM subscription_plans p WHERE p.name=u.plan AND (u.subscription_started_at IS NULL OR u.subscription_expires_at IS NULL OR u.subscription_quota_bytes IS NULL)`);
  await database.query(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status)
    SELECT u.id,p.id,u.subscription_started_at,u.subscription_expires_at,u.subscription_quota_bytes,u.subscription_used_bytes,
      CASE WHEN u.subscription_expires_at<=NOW() THEN 'expired' WHEN u.subscription_used_bytes>=u.subscription_quota_bytes THEN 'exhausted' ELSE 'active' END
    FROM users u JOIN subscription_plans p ON p.name=u.plan
    WHERE u.subscription_started_at IS NOT NULL AND u.subscription_expires_at IS NOT NULL AND u.subscription_quota_bytes IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=u.id)`);
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
