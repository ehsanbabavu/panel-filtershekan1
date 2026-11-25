import { createHash, randomInt } from 'node:crypto';
import { subscriptionOf, type MobileDatabase } from './presence.js';

type QueryDatabase = Pick<MobileDatabase, 'query'>;

export const telegramLinkSchema = `
  CREATE TABLE IF NOT EXISTS telegram_user_links (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bot_id BIGINT NOT NULL, telegram_user_id BIGINT NOT NULL,
    telegram_username TEXT NOT NULL DEFAULT '', telegram_name TEXT NOT NULL DEFAULT '',
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(bot_id,telegram_user_id)
  );
  CREATE TABLE IF NOT EXISTS telegram_connection_codes (
    code_hash TEXT PRIMARY KEY, bot_id BIGINT NOT NULL, update_id BIGINT NOT NULL,
    telegram_user_id BIGINT NOT NULL, telegram_username TEXT NOT NULL DEFAULT '',
    telegram_name TEXT NOT NULL DEFAULT '', expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(bot_id,update_id)
  );
  CREATE INDEX IF NOT EXISTS telegram_connection_codes_expiry_idx ON telegram_connection_codes(expires_at);
`;

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

export function telegramIdentity(message: any) {
  if (message.chat?.type !== 'private' || message.from?.is_bot || !Number.isSafeInteger(message.from?.id) ||
    message.from.id < 1 || message.chat.id !== message.from.id) return null;
  return { id: String(message.from.id),
    username: typeof message.from.username === 'string' ? message.from.username.slice(0, 64) : '',
    name: [message.from.first_name, message.from.last_name].filter(value => typeof value === 'string').join(' ').slice(0, 256) };
}

// Called inside the webhook transaction, together with update deduplication.
export async function issueTelegramConnectionCode(database: QueryDatabase, botId: string | number, updateId: number, identity: NonNullable<ReturnType<typeof telegramIdentity>>) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let suffix: string;
  do {
    suffix = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
  } while (!/[A-Za-z]/.test(suffix) || !/[0-9]/.test(suffix));
  const code = 'Ariya' + suffix;
  await database.query('SELECT id FROM telegram_settings WHERE id=1 FOR UPDATE');
  await database.query('DELETE FROM telegram_connection_codes WHERE expires_at<=NOW() OR (bot_id=$1 AND telegram_user_id=$2)', [botId, identity.id]);
  await database.query(`INSERT INTO telegram_connection_codes(code_hash,bot_id,update_id,telegram_user_id,telegram_username,telegram_name,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes')`, [hashCode(code), botId, updateId, identity.id, identity.username, identity.name]);
  return code;
}

function linkOf(row: any) {
  return row?.telegram_user_id ? { id: String(row.telegram_user_id), username: row.telegram_username,
    name: row.telegram_name, linkedAt: row.linked_at } : null;
}

export async function handleTelegramLinkRequest(req: any, res: any, database: MobileDatabase, token: string) {
  const method = String(req.method || 'GET').toUpperCase();
  const reply = (status: number, body: unknown) => res.status(status).json(body);
  if (!['GET', 'POST'].includes(method)) return reply(405, { message: 'این روش برای اتصال تلگرام پشتیبانی نمی‌شود.' });
  if (!token) return reply(401, { message: 'برای اتصال تلگرام وارد حساب کاربری شوید.' });
  if (method === 'GET') {
    const session = (await database.query<any>(`SELECT u.id,l.* FROM app_user_sessions s JOIN users u ON u.id=s.user_id
      LEFT JOIN telegram_user_links l ON l.user_id=u.id
      WHERE s.token=$1 AND (s.expires_at IS NULL OR s.expires_at>NOW())`, [token])).rows[0];
    if (!session) return reply(401, { message: 'نشست شما منقضی شده است.' });
    const settings = (await database.query<any>('SELECT bot_username,enabled FROM telegram_settings WHERE id=1')).rows[0];
    return reply(200, { telegram: linkOf(session), botEnabled: Boolean(settings?.enabled),
      botUrl: settings?.bot_username ? `https://t.me/${settings.bot_username}` : null });
  }
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^Ariya[A-Za-z0-9]{10}$/.test(code)) return reply(400, { message: 'کد ۱۵ کاراکتری ربات با پیشوند Ariya را وارد کنید.' });
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const user = (await client.query<any>(`SELECT u.id FROM app_user_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token=$1 AND (s.expires_at IS NULL OR s.expires_at>NOW()) FOR UPDATE OF u`, [token])).rows[0];
    if (!user) { await client.query('ROLLBACK'); return reply(401, { message: 'نشست شما منقضی شده است.' }); }
    const pending = (await client.query<any>(`SELECT c.* FROM telegram_connection_codes c
      JOIN telegram_settings t ON t.id=1 AND t.bot_id=c.bot_id AND t.enabled
      WHERE c.code_hash=$1 AND c.expires_at>NOW() FOR UPDATE OF c`, [hashCode(code)])).rows[0];
    if (!pending) { await client.query('ROLLBACK'); return reply(400, { message: 'کد نامعتبر، منقضی یا قبلاً استفاده شده است. از ربات کد تازه بگیرید.' }); }
    const linked = (await client.query<any>(`INSERT INTO telegram_user_links(user_id,bot_id,telegram_user_id,telegram_username,telegram_name)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET bot_id=EXCLUDED.bot_id,
      telegram_user_id=EXCLUDED.telegram_user_id,telegram_username=EXCLUDED.telegram_username,
      telegram_name=EXCLUDED.telegram_name,linked_at=NOW() RETURNING *`,
    [user.id, pending.bot_id, pending.telegram_user_id, pending.telegram_username, pending.telegram_name])).rows[0];
    await client.query('DELETE FROM telegram_connection_codes WHERE code_hash=$1', [hashCode(code)]);
    await client.query('COMMIT');
    return reply(200, { telegram: linkOf(linked), message: 'حساب تلگرام با موفقیت متصل شد.' });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '23505') return reply(409, { message: 'این حساب تلگرام به کاربر دیگری متصل است.' });
    throw error;
  } finally { client.release(); }
}

export async function telegramSubscriptionText(database: QueryDatabase, botId: string | number, identity: NonNullable<ReturnType<typeof telegramIdentity>>) {
  await database.query(`UPDATE telegram_user_links SET telegram_username=$3,telegram_name=$4
    WHERE bot_id=$1 AND telegram_user_id=$2`, [botId, identity.id, identity.username, identity.name]);
  const row = (await database.query<any>(`SELECT u.id AS user_id,u.name,u.username,u.plan,u.blocked,
    u.subscription_started_at,u.subscription_expires_at,(u.subscription_expires_at>NOW()) AS subscription_time_active,
    u.subscription_quota_bytes,u.subscription_used_bytes,
    COALESCE(p.simultaneous_devices,1) AS simultaneous_device_limit
    FROM telegram_user_links l JOIN users u ON u.id=l.user_id LEFT JOIN subscription_plans p ON p.name=u.plan
    WHERE l.bot_id=$1 AND l.telegram_user_id=$2`, [botId, identity.id])).rows[0];
  if (!row) return 'هنوز حساب برنامه به این تلگرام متصل نشده است. «اتصال به برنامه» را بزنید و کد را در آیکن تلگرامِ تب پروفایل برنامه وارد کنید.';
  const sub = subscriptionOf(row);
  const quota = BigInt(sub.subscriptionQuotaBytes), used = BigInt(sub.subscriptionUsedBytes);
  const gigabytes = (value: bigint) => (Number(value) / 1073741824).toLocaleString('fa-IR', { maximumFractionDigits: 2 }) + ' گیگابایت';
  const date = (value: any) => value ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeZone: 'Asia/Tehran' }).format(new Date(value)) : '—';
  const status = sub.blocked ? 'مسدود' : quota === 0n || !sub.subscriptionExpiresAt ? 'بدون اشتراک' : !sub.subscriptionTimeActive ? 'منقضی‌شده' : sub.exhausted ? 'حجم تمام شده' : 'فعال';
  const days = Math.max(0, Math.ceil((new Date(sub.subscriptionExpiresAt || 0).getTime() - Date.now()) / 86400000));
  return `وضعیت اشتراک شما\n\nنام: ${row.name}\nنام کاربری: ${row.username}\nپلن: ${row.plan}\nوضعیت: ${status}\nحجم کل: ${gigabytes(quota)}\nمصرف‌شده: ${gigabytes(used)}\nباقی‌مانده: ${gigabytes(quota > used ? quota - used : 0n)}\nشروع: ${date(sub.subscriptionStartedAt)}\nپایان: ${date(sub.subscriptionExpiresAt)}\nروزهای باقی‌مانده: ${days.toLocaleString('fa-IR')}\nدستگاه‌های مجاز هم‌زمان: ${sub.simultaneousDevices.toLocaleString('fa-IR')}`;
}
