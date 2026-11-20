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

    const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
    const session = await database.query(
      'SELECT 1 FROM sessions WHERE token = $1 AND expires_at > NOW()',
      [token],
    );
    if (!session.rowCount) return reply(res, 401, { message: 'نشست شما منقضی شده است؛ دوباره وارد شوید.' });

    if (pathname === '/api/user-subscriptions' && method === 'GET') {
      const subscriptions = await database.query(`SELECT u.id AS "userId",u.name AS "userName",u.username,p.name AS "planName",
        u.subscription_started_at AS "startedAt",u.subscription_expires_at AS "expiresAt",
        u.subscription_quota_bytes AS "quotaBytes",u.subscription_used_bytes AS "usedBytes",u.blocked,
        (u.subscription_expires_at>NOW() AND u.subscription_used_bytes<u.subscription_quota_bytes) AS active
        FROM users u LEFT JOIN subscription_plans p ON p.name=u.plan
        WHERE u.subscription_started_at IS NOT NULL ORDER BY u.subscription_started_at DESC`);
      return reply(res, 200, subscriptions.rows);
    }

    if (pathname === '/api/users/block' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const id = Number(body.userId);
      if (!Number.isSafeInteger(id) || id < 1 || typeof body.blocked !== 'boolean') {
        return reply(res, 400, { message: 'شناسه کاربر یا وضعیت مسدودسازی معتبر نیست.' });
      }
      const updated = await database.query('UPDATE users SET blocked=$2 WHERE id=$1 RETURNING id', [id, body.blocked]);
      if (!updated.rows[0]) return reply(res, 404, { message: 'کاربر پیدا نشد.' });
      if (body.blocked) await database.query('UPDATE app_user_sessions SET vpn_connected=FALSE,vpn_heartbeat_at=NULL WHERE user_id=$1', [id]);
      return reply(res, 200, { success: true, userId: id, blocked: body.blocked });
    }

    if (pathname === '/api/subscriptions' && method === 'GET') {
      const plans = await database.query(`SELECT p.id,p.name,p.description,p.price_irr AS "priceIrr",p.quota_bytes AS "quotaBytes",
        p.duration_days AS "durationDays",p.simultaneous_devices AS "simultaneousDevices",p.features,p.active,COUNT(u.id)::int AS users
        FROM subscription_plans p LEFT JOIN users u ON u.plan=p.name GROUP BY p.id ORDER BY p.id`);
      return reply(res, 200, plans.rows);
    }

    if (pathname === '/api/subscriptions' && (method === 'POST' || method === 'PATCH')) {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const priceIrr = Number(body.priceIrr);
      const quotaBytes = Number(body.quotaBytes);
      const durationDays = Number(body.durationDays);
      const simultaneousDevices = Number(body.simultaneousDevices ?? 1);
      const features = body.features ?? [];
      if (name.length < 2 || name.length > 80 || !Number.isSafeInteger(priceIrr) || priceIrr < 0 ||
          !Number.isSafeInteger(quotaBytes) || quotaBytes < 1 || !Number.isInteger(durationDays) || durationDays < 1 ||
          !Number.isInteger(simultaneousDevices) || simultaneousDevices < 1 || !Array.isArray(features) ||
          features.some((feature: unknown) => typeof feature !== 'string')) {
        return reply(res, 400, { message: 'مشخصات اشتراک معتبر نیست.' });
      }
      try {
        if (method === 'POST') {
          const created = await database.query(`INSERT INTO subscription_plans(name,description,price_irr,quota_bytes,duration_days,simultaneous_devices,features,active)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,description,price_irr AS "priceIrr",quota_bytes AS "quotaBytes",
            duration_days AS "durationDays",simultaneous_devices AS "simultaneousDevices",features,active`,
          [name, description, priceIrr, quotaBytes, durationDays, simultaneousDevices, JSON.stringify(features), body.active !== false]);
          return reply(res, 201, created.rows[0]);
        }
        const query = new URL(req.url || '/', 'http://localhost').searchParams;
        const id = Number(query.get('id') || body.id);
        if (!Number.isSafeInteger(id) || id < 1) return reply(res, 400, { message: 'شناسه اشتراک معتبر نیست.' });
        const updated = await database.query(`UPDATE subscription_plans SET name=$2,description=$3,price_irr=$4,quota_bytes=$5,
          duration_days=$6,simultaneous_devices=$7,features=$8,active=$9,updated_at=NOW() WHERE id=$1
          RETURNING id,name,description,price_irr AS "priceIrr",quota_bytes AS "quotaBytes",duration_days AS "durationDays",
          simultaneous_devices AS "simultaneousDevices",features,active`,
        [id, name, description, priceIrr, quotaBytes, durationDays, simultaneousDevices, JSON.stringify(features), body.active !== false]);
        if (!updated.rows[0]) return reply(res, 404, { message: 'اشتراک پیدا نشد.' });
        return reply(res, 200, updated.rows[0]);
      } catch (error: any) {
        if (error?.code === '23505') return reply(res, 409, { message: 'نام این اشتراک از قبل وجود دارد.' });
        throw error;
      }
    }

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
      const planRow = await database.query<any>('SELECT id,duration_days,quota_bytes FROM subscription_plans WHERE name=$1 AND active=true', [plan]);
      if (!planRow.rows[0]) return reply(res, 400, { message: 'پلن اشتراک فعال پیدا نشد.' });
      try {
        const passwordHash = await bcrypt.hash(password, 10);
        const created = await database.query<any>(
          `INSERT INTO users (name, username, status, plan, last_seen, password_hash)
           VALUES ($1, $2, 'آفلاین', $3, 'هنوز متصل نشده', $4)
           RETURNING id, name, username, status, plan, last_seen AS "lastSeen"`,
          [name, username, plan, passwordHash],
        );
        const user = created.rows[0];
        const subscription = await database.query<any>(`UPDATE users SET subscription_started_at=NOW(),
          subscription_expires_at=NOW()+$2*INTERVAL '1 day',subscription_quota_bytes=$3,subscription_used_bytes=0
          WHERE id=$1 RETURNING subscription_started_at AS "startedAt",subscription_expires_at AS "expiresAt",subscription_quota_bytes AS "quotaBytes"`,
        [user.id, planRow.rows[0].duration_days, planRow.rows[0].quota_bytes]);
        await database.query(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status)
          VALUES($1,$2,$3,$4,$5,0,'active')`, [user.id, planRow.rows[0].id, subscription.rows[0].startedAt, subscription.rows[0].expiresAt, subscription.rows[0].quotaBytes]);
        return reply(res, 201, { ...user, ...subscription.rows[0], blocked: false });
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
      const planRow = await database.query<any>('SELECT id,duration_days,quota_bytes FROM subscription_plans WHERE name=$1 AND active=true', [plan]);
      if (!planRow.rows[0]) return reply(res, 400, { message: 'پلن اشتراک فعال پیدا نشد.' });
      if (password && (password.length < 8 || password.length > 128)) {
        return reply(res, 400, { message: 'رمز تازه باید حداقل ۸ نویسه باشد.' });
      }
      try {
        const passwordHash = password ? await bcrypt.hash(password, 10) : null;
        const updated = await database.query<any>(
          `UPDATE users
           SET name = $1, username = $2, plan = $3, password_hash = COALESCE($4, password_hash),
               subscription_started_at=NOW(),subscription_expires_at=NOW()+$6*INTERVAL '1 day',
               subscription_quota_bytes=$7,subscription_used_bytes=0
           WHERE id = $5 RETURNING id,subscription_started_at AS "startedAt",subscription_expires_at AS "expiresAt",subscription_quota_bytes AS "quotaBytes"`,
          [name, username, plan, passwordHash, id, planRow.rows[0].duration_days, planRow.rows[0].quota_bytes],
        );
        if (!updated.rows[0]) return reply(res, 404, { message: 'کاربر پیدا نشد.' });
        await database.query(`UPDATE user_subscriptions SET status='cancelled' WHERE user_id=$1 AND status='active'`, [id]);
        await database.query(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status)
          VALUES($1,$2,$3,$4,$5,0,'active')`, [id, planRow.rows[0].id, updated.rows[0].startedAt, updated.rows[0].expiresAt, updated.rows[0].quotaBytes]);
        const user = await selectUsers(database, id);
        return reply(res, 200, { ...user.rows[0], ...updated.rows[0] });
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
