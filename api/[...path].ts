import bcrypt from 'bcryptjs';
import { initializeDatabase, pool } from '../server/database.js';
import { handleMobileRequest } from '../server/mobile.js';
import { selectUsers, type MobileDatabase } from '../server/presence.js';
import { handleBluePalAdminRequest } from '../server/bluepal.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { settleMobileBluePalPayment } from '../server/mobile.js';
import { getMaintenanceMode, setMaintenanceMode } from '../server/serviceControl.js';
import { createProxyImportHandler } from '../server/proxyImport.js';
import { createProxyBulkHandler } from '../server/proxyBulk.js';
import { createSubscriptionUsageResetHandler } from '../server/subscriptionUsage.js';
import { createTelegramHandler } from '../server/telegram.js';

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

    if (pathname === '/api/telegram') return await createTelegramHandler(database, async () => {})(req, res);

    if (pathname === '/api/health' && method === 'GET') {
      await database.query('SELECT 1');
      return reply(res, 200, { status: 'ok', database: 'connected' });
    }

    if (pathname === '/api/payment/bluepal/webhook' && method === 'POST') {
      const settings = await database.query<any>('SELECT webhook_secret FROM bluepal_settings WHERE id=1');
      const secret = String(settings.rows[0]?.webhook_secret || '');
      if (secret) {
        const supplied = String(req.headers?.['x-blupal-signature'] || req.headers?.['x-webhook-signature'] || '');
        const raw = String(req.rawBody || JSON.stringify(typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}));
        const expected = createHmac('sha256', secret).update(raw).digest('hex');
        const left = Buffer.from(supplied), right = Buffer.from(expected);
        if (left.length !== right.length || !timingSafeEqual(left, right)) return reply(res, 401, { success: false, message: 'امضای وب‌هوک معتبر نیست.' });
      }
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const invoiceId = String(body.invoice_id ?? body.id ?? body.track_id ?? '');
      if (!invoiceId) return reply(res, 400, { success: false, message: 'شناسه فاکتور در وب‌هوک موجود نیست.' });
      const found = await database.query<any>('SELECT public_id FROM bluepal_payments WHERE track_id=$1', [invoiceId]);
      if (!found.rows[0]) return reply(res, 200, { success: true, received: true, matched: false });
      const settled = await settleMobileBluePalPayment(database, String(found.rows[0].public_id));
      return reply(res, settled.paid ? 200 : 202, { success: true, received: true, matched: true, payment: settled.paid ? 'paid' : 'pending-verification' });
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

    const bluePalHandled = await handleBluePalAdminRequest(pathname, method, req, res, database);
    if (bluePalHandled !== null) return bluePalHandled;

    if (pathname === '/api/user-subscriptions/reset-usage') {
      return await createSubscriptionUsageResetHandler(database)(req, res);
    }

    if (pathname === '/api/service-status' && method === 'GET') {
      return reply(res, 200, { maintenanceMode: await getMaintenanceMode(database) });
    }

    if (pathname === '/api/service-status' && method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      if (typeof body.maintenanceMode !== 'boolean') return reply(res, 400, { message: 'وضعیت سرویس معتبر نیست.' });
      return reply(res, 200, await setMaintenanceMode(database, body.maintenanceMode));
    }

    if (pathname === '/api/transactions' && method === 'GET') {
      const result = await database.query(`SELECT p.id,p.public_id AS "paymentId",u.name AS "userName",u.username,
        p.plan_name AS "planName",p.amount_toman AS "amountToman",p.status,p.track_id AS "trackId",p.reference,
        p.payment_url AS "paymentUrl",p.created_at AS "createdAt",p.paid_at AS "paidAt"
        FROM bluepal_payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 500`);
      return reply(res, 200, result.rows);
    }

    if (pathname === '/api/dashboard-stats' && method === 'GET') {
      const result = await database.query<any>(`SELECT COALESCE(SUM(amount_toman),0)::text AS "monthRevenueToman",
        COUNT(*)::int AS "successfulPayments"
        FROM bluepal_payments
        WHERE status='paid'
          AND COALESCE(paid_at,updated_at,created_at) >= (date_trunc('month',NOW() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran')
          AND COALESCE(paid_at,updated_at,created_at) < ((date_trunc('month',NOW() AT TIME ZONE 'Asia/Tehran') + INTERVAL '1 month') AT TIME ZONE 'Asia/Tehran')`);
      return reply(res, 200, result.rows[0] || { monthRevenueToman: '0', successfulPayments: 0 });
    }

    if (pathname === '/api/proxy' && method === 'GET') {
      const result = await database.query('SELECT host,port,username,password,updated_at AS "updatedAt" FROM proxy_settings WHERE id=1');
      return reply(res, 200, result.rows[0] || null);
    }

    if (pathname === '/api/proxy' && method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const host = typeof body.host === 'string' ? body.host.trim() : '';
      const port = Number(body.port);
      const username = typeof body.username === 'string' ? body.username : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!host || host.length > 253 || /\s/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || username.length > 255 || password.length > 512) {
        return reply(res, 400, { message: 'آدرس، پورت یا مشخصات ورود پروکسی معتبر نیست.' });
      }
      const result = await database.query(`INSERT INTO proxy_settings(id,host,port,username,password) VALUES(1,$1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET host=EXCLUDED.host,port=EXCLUDED.port,username=EXCLUDED.username,password=EXCLUDED.password,updated_at=NOW()
        RETURNING host,port,username,password,updated_at AS "updatedAt"`, [host, port, username, password]);
      return reply(res, 200, result.rows[0]);
    }

    if (pathname === '/api/proxies' && method === 'GET') {
      const result = await database.query(`SELECT id,name,host,port,username,password,active,updated_at AS "updatedAt"
        FROM proxy_servers ORDER BY id ASC`);
      return reply(res, 200, result.rows);
    }

    if (pathname === '/api/proxies/import' && method === 'POST') {
      return await createProxyImportHandler(database)(req,res);
    }

    if (pathname === '/api/proxies/bulk') {
      return await createProxyBulkHandler(database)(req,res);
    }

    if (pathname === '/api/proxies' && method === 'DELETE') {
      const id = Number(new URL(req.url || '/', 'http://localhost').searchParams.get('id'));
      if (!Number.isSafeInteger(id) || id < 1) return reply(res, 400, { message: 'شناسه ساکس معتبر نیست.' });
      const result = await database.query('DELETE FROM proxy_servers WHERE id=$1 RETURNING id', [id]);
      if (!result.rows[0]) return reply(res, 404, { message: 'ساکس پیدا نشد.' });
      return reply(res, 200, { success: true, id: result.rows[0].id });
    }

    if (pathname === '/api/proxies' && (method === 'POST' || method === 'PATCH')) {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const host = typeof body.host === 'string' ? body.host.trim() : '';
      const port = Number(body.port);
      const username = typeof body.username === 'string' ? body.username : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const active = body.active === undefined ? true : body.active;
      if (name.length < 2 || name.length > 80 || !host || host.length > 253 || /\s/.test(host) ||
          !Number.isInteger(port) || port < 1 || port > 65535 || username.length > 255 || password.length > 512 || typeof active !== 'boolean') {
        return reply(res, 400, { message: 'مشخصات ساکس معتبر نیست.' });
      }
      if (method === 'POST') {
        const result = await database.query(`INSERT INTO proxy_servers(name,host,port,username,password,active)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,host,port,username,password,active,updated_at AS "updatedAt"`,
        [name, host, port, username, password, active]);
        return reply(res, 201, result.rows[0]);
      }
      const id = Number(new URL(req.url || '/', 'http://localhost').searchParams.get('id'));
      if (!Number.isSafeInteger(id) || id < 1) return reply(res, 400, { message: 'شناسه ساکس معتبر نیست.' });
      const result = await database.query(`UPDATE proxy_servers SET name=$2,host=$3,port=$4,username=$5,password=$6,active=$7,updated_at=NOW()
        WHERE id=$1 RETURNING id,name,host,port,username,password,active,updated_at AS "updatedAt"`,
      [id, name, host, port, username, password, active]);
      if (!result.rows[0]) return reply(res, 404, { message: 'ساکس پیدا نشد.' });
      return reply(res, 200, result.rows[0]);
    }

    if (pathname === '/api/user-subscriptions' && method === 'GET') {
      const subscriptions = await database.query(`SELECT u.id AS "userId",u.name AS "userName",u.username,p.id AS "planId",p.name AS "planName",p.duration_days AS "durationDays",
        u.subscription_started_at AS "startedAt",u.subscription_expires_at AS "expiresAt",
        u.subscription_quota_bytes AS "quotaBytes",u.subscription_used_bytes AS "usedBytes",u.blocked,
        (u.subscription_expires_at>NOW() AND u.subscription_used_bytes<u.subscription_quota_bytes) AS active
        FROM users u LEFT JOIN subscription_plans p ON p.name=u.plan
        WHERE u.subscription_started_at IS NOT NULL ORDER BY u.subscription_started_at DESC`);
      return reply(res, 200, subscriptions.rows);
    }

    if (pathname === '/api/user-subscriptions' && method === 'PATCH') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const userId = Number(body.userId), planId = Number(body.planId), durationDays = Number(body.durationDays), quotaBytes = Number(body.quotaBytes);
      if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(planId) || planId < 1 ||
          !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650 || !Number.isSafeInteger(quotaBytes) || quotaBytes < 1) {
        return reply(res, 400, { message: 'مشخصات اشتراک معتبر نیست.' });
      }
      const client = await database.connect();
      try {
        await client.query('BEGIN');
        const plan = (await client.query<any>('SELECT * FROM subscription_plans WHERE id=$1 AND active=true', [planId])).rows[0];
        if (!plan) { await client.query('ROLLBACK'); return reply(res, 404, { message: 'پلن فعال پیدا نشد.' }); }
        const user = (await client.query<any>('SELECT id,subscription_used_bytes FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
        if (!user) { await client.query('ROLLBACK'); return reply(res, 404, { message: 'کاربر پیدا نشد.' }); }
        const usedBytes = String(user.subscription_used_bytes || 0);
        const startedAt = new Date();
        const expiresAt = new Date(startedAt.getTime() + durationDays * 86400000);
        await client.query("UPDATE user_subscriptions SET status='cancelled',used_bytes=$2 WHERE user_id=$1 AND status='active'", [userId, usedBytes]);
        const subscription = (await client.query<any>(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status)
          VALUES($1,$2,$3,$4,$5,$6,'active') RETURNING id,user_id AS "userId",plan_id AS "planId",started_at AS "startedAt",expires_at AS "expiresAt",quota_bytes AS "quotaBytes",used_bytes AS "usedBytes",status`,
        [userId, planId, startedAt, expiresAt, quotaBytes, usedBytes])).rows[0];
        await client.query(`UPDATE users SET plan=$2,subscription_started_at=$3,subscription_expires_at=$4,
          subscription_quota_bytes=$5,subscription_used_bytes=$6 WHERE id=$1`, [userId, plan.name, startedAt, expiresAt, quotaBytes, usedBytes]);
        await client.query('COMMIT');
        return reply(res, 200, { ...subscription, planName: plan.name, durationDays });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { client.release(); }
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
        p.duration_days AS "durationDays",p.simultaneous_devices AS "simultaneousDevices",p.features,p.active,p.is_trial AS "isTrial",
        COUNT(u.id) FILTER (WHERE u.subscription_expires_at>NOW() AND u.subscription_used_bytes<u.subscription_quota_bytes)::int AS users
        FROM subscription_plans p LEFT JOIN users u ON u.plan=p.name GROUP BY p.id ORDER BY p.id`);
      return reply(res, 200, plans.rows);
    }

    if (pathname === '/api/subscriptions' && method === 'DELETE') {
      const id = Number(new URL(req.url || '/', 'http://localhost').searchParams.get('id'));
      if (!Number.isSafeInteger(id) || id < 1) return reply(res, 400, { message: 'شناسه پلن معتبر نیست.' });
      const assigned = await database.query<any>('SELECT COUNT(*)::int AS count FROM user_subscriptions WHERE plan_id=$1', [id]);
      if (Number(assigned.rows[0]?.count) > 0) return reply(res, 409, { message: 'این پلن در سابقه اشتراک کاربران استفاده شده و قابل حذف نیست.' });
      const deleted = await database.query('DELETE FROM subscription_plans WHERE id=$1 RETURNING id', [id]);
      if (!deleted.rows[0]) return reply(res, 404, { message: 'پلن پیدا نشد.' });
      return reply(res, 200, { success: true, id: deleted.rows[0].id });
    }

    if (pathname === '/api/subscriptions' && (method === 'POST' || method === 'PATCH')) {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      if (method === 'PATCH') {
        const query = new URL(req.url || '/', 'http://localhost').searchParams;
        const id = Number(query.get('id') || body.id);
        if (!Number.isSafeInteger(id) || id < 1) return reply(res, 400, { message: 'شناسه اشتراک معتبر نیست.' });
        const name = body.name === undefined ? null : String(body.name).trim();
        const description = body.description === undefined ? null : String(body.description).trim();
        const priceIrr = body.priceIrr === undefined ? null : Number(body.priceIrr);
        const quotaBytes = body.quotaBytes === undefined ? null : Number(body.quotaBytes);
        const durationDays = body.durationDays === undefined ? null : Number(body.durationDays);
        const simultaneousDevices = body.simultaneousDevices === undefined ? null : Number(body.simultaneousDevices);
        const features = body.features === undefined ? null : body.features;
        if ((name !== null && (name.length < 2 || name.length > 80)) ||
            (description !== null && description.length > 1000) ||
            (priceIrr !== null && (!Number.isSafeInteger(priceIrr) || priceIrr < 0)) ||
            (quotaBytes !== null && (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1)) ||
            (durationDays !== null && (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650)) ||
            (simultaneousDevices !== null && (!Number.isInteger(simultaneousDevices) || simultaneousDevices < 1 || simultaneousDevices > 100)) ||
            (features !== null && (!Array.isArray(features) || features.length > 50 || features.some((feature: unknown) => typeof feature !== 'string' || feature.length > 200))) ||
            (body.active !== undefined && typeof body.active !== 'boolean') ||
            (body.isTrial !== undefined && typeof body.isTrial !== 'boolean')) {
          return reply(res, 400, { message: 'مشخصات اشتراک معتبر نیست.' });
        }
        const updated = await database.query(`UPDATE subscription_plans SET
          name=COALESCE($2,name),description=COALESCE($3,description),price_irr=COALESCE($4,price_irr),
          quota_bytes=COALESCE($5,quota_bytes),duration_days=COALESCE($6,duration_days),
          simultaneous_devices=COALESCE($7,simultaneous_devices),features=COALESCE($8::jsonb,features),
          active=COALESCE($9::boolean,active),is_trial=COALESCE($10::boolean,is_trial),updated_at=NOW()
          WHERE id=$1 RETURNING id,name,description,price_irr AS "priceIrr",quota_bytes AS "quotaBytes",
          duration_days AS "durationDays",simultaneous_devices AS "simultaneousDevices",features,active,is_trial AS "isTrial"`,
        [id,name,description,priceIrr,quotaBytes,durationDays,simultaneousDevices,features === null ? null : JSON.stringify(features),body.active ?? null,body.isTrial ?? null]);
        if (!updated.rows[0]) return reply(res, 404, { message: 'اشتراک پیدا نشد.' });
        return reply(res, 200, updated.rows[0]);
      }
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
          const created = await database.query(`INSERT INTO subscription_plans(name,description,price_irr,quota_bytes,duration_days,simultaneous_devices,features,active,is_trial)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,description,price_irr AS "priceIrr",quota_bytes AS "quotaBytes",
            duration_days AS "durationDays",simultaneous_devices AS "simultaneousDevices",features,active,is_trial AS "isTrial"`,
          [name, description, priceIrr, quotaBytes, durationDays, simultaneousDevices, JSON.stringify(features), body.active !== false, body.isTrial === true]);
          return reply(res, 201, created.rows[0]);
        }
        return reply(res, 500, { message: 'درخواست اشتراک نامعتبر است.' });
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

    if (pathname === '/api/chat/conversations' && method === 'GET') {
      const conversations = await database.query(`SELECT u.id AS "userId",u.name,u.username,
        latest.message AS "lastMessage",latest.created_at AS "lastMessageAt",
        (SELECT COUNT(*)::int FROM chat_messages unread WHERE unread.user_id=u.id AND unread.sender_role='user' AND unread.read_by_admin=FALSE) AS "unreadCount"
        FROM users u LEFT JOIN LATERAL (SELECT message,created_at FROM chat_messages m WHERE m.user_id=u.id ORDER BY m.id DESC LIMIT 1) latest ON TRUE
        WHERE latest.message IS NOT NULL
        ORDER BY latest.created_at DESC NULLS LAST,u.id DESC`);
      return reply(res, 200, conversations.rows);
    }

    if (pathname === '/api/chat/unread-count' && method === 'GET') {
      const result = await database.query('SELECT COUNT(DISTINCT user_id)::int AS count FROM chat_messages WHERE sender_role=$1 AND read_by_admin=FALSE AND user_id IS NOT NULL', ['user']);
      return reply(res, 200, result.rows[0] || { count: 0 });
    }

    if (pathname === '/api/chat' && method === 'GET') {
      const userId = Number(new URL(req.url || '/', 'http://localhost').searchParams.get('userId'));
      if (!Number.isSafeInteger(userId) || userId < 1) return reply(res, 400, { message: 'کاربر گفت‌وگو را انتخاب کنید.' });
      await database.query("UPDATE chat_messages SET read_by_admin=TRUE WHERE user_id=$1 AND sender_role='user' AND read_by_admin=FALSE", [userId]);
      const messages = await database.query(`SELECT id,user_id AS "userId",author,message AS text,created_at AS time,sender_role AS "senderRole"
        FROM chat_messages WHERE user_id=$1 ORDER BY id DESC LIMIT 200`, [userId]);
      return reply(res, 200, messages.rows.reverse());
    }

    if (pathname === '/api/chat' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const message = String(body.message || '').trim();
      const userId = Number(body.userId);
      if (!message || message.length > 4000) return reply(res, 400, { message: 'پیام باید بین ۱ تا ۴۰۰۰ نویسه باشد.' });
      if (!Number.isSafeInteger(userId) || userId < 1) return reply(res, 400, { message: 'کاربر گفت‌وگو را انتخاب کنید.' });
      const admin = await database.query<any>('SELECT admin_username FROM sessions WHERE token=$1 AND expires_at>NOW()', [token]);
      if (!admin.rows[0]) return reply(res, 401, { message: 'نشست شما منقضی شده است.' });
      const inserted = await database.query(`INSERT INTO chat_messages(user_id,sender_role,author,message)
        SELECT $1,'admin',$2,$3 WHERE EXISTS(SELECT 1 FROM users WHERE id=$1)
        RETURNING id,user_id AS "userId",author,message AS text,created_at AS time,sender_role AS "senderRole"`,
      [userId, admin.rows[0].admin_username, message]);
      if (!inserted.rows[0]) return reply(res, 404, { message: 'کاربر پیدا نشد.' });
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
