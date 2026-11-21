import bcrypt from 'bcryptjs';
import { reportPresence, type MobileDatabase } from './presence.js';
import { readBluePalConfig, requestBluePalPayment, verifyBluePalPayment } from './bluepal.js';

function reply(res: any, status: number, body: unknown) {
  return res.status(status).json(body);
}

function bodyOf(req: any) {
  return typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
}

function appOrigin(req: any) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('PUBLIC_BASE_URL باید HTTPS باشد.');
    return url.origin;
  }
  const protocol = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  if (!host || (protocol !== 'https' && !['localhost', '127.0.0.1'].includes(host.split(':')[0]))) throw new Error('نشانی عمومی سایت تنظیم نشده است.');
  return `${protocol}://${host}`;
}

function paymentRow(row: any) {
  return { paymentId: row.public_id, status: row.status, planName: row.plan_name, amountToman: Number(row.amount_toman), paymentUrl: row.payment_url || null, trackId: row.track_id || null, reference: row.reference || null };
}

async function activatePaidPayment(database: MobileDatabase, paymentId: string, reference: string) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<any>('SELECT * FROM bluepal_payments WHERE public_id=$1 FOR UPDATE', [paymentId]);
    const payment = locked.rows[0];
    if (!payment) { await client.query('ROLLBACK'); return { missing: true }; }
    if (payment.status !== 'paid') {
      const dates = await client.query<any>("SELECT NOW() AS started_at,NOW()+($1::int*INTERVAL '1 day') AS expires_at", [payment.duration_days]);
      const { started_at: startedAt, expires_at: expiresAt } = dates.rows[0];
      await client.query("UPDATE user_subscriptions SET status='cancelled' WHERE user_id=$1 AND status='active'", [payment.user_id]);
      await client.query(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status)
        VALUES($1,$2,$3,$4,$5,0,'active')`, [payment.user_id, payment.plan_id, startedAt, expiresAt, payment.quota_bytes]);
      await client.query(`UPDATE users SET plan=$2,subscription_started_at=$3,subscription_expires_at=$4,
        subscription_quota_bytes=$5,subscription_used_bytes=0 WHERE id=$1`, [payment.user_id, payment.plan_name, startedAt, expiresAt, payment.quota_bytes]);
      await client.query(`UPDATE bluepal_payments SET status='paid',reference=$2,paid_at=NOW(),updated_at=NOW() WHERE public_id=$1`, [paymentId, reference]);
    }
    await client.query('COMMIT');
    const result = await database.query<any>('SELECT * FROM bluepal_payments WHERE public_id=$1', [paymentId]);
    return { paid: true, payment: paymentRow(result.rows[0]) };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function settleBluePalPayment(database: MobileDatabase, paymentId: string) {
  const selected = await database.query<any>('SELECT * FROM bluepal_payments WHERE public_id=$1', [paymentId]);
  const payment = selected.rows[0];
  if (!payment) return { missing: true };
  if (payment.status === 'paid') return { paid: true, payment: paymentRow(payment) };
  if (!payment.track_id) return { paid: false, payment: paymentRow(payment) };
  const config = await readBluePalConfig(database);
  if (!config) throw new Error('درگاه بلوپال تنظیم نشده است.');
  const expectedRial = Number(payment.amount_rial) || Number(payment.amount_toman) * 10;
  const verification = await verifyBluePalPayment(config, payment.track_id, expectedRial);
  if (!verification.paid) {
    const status = verification.reason === 'expired' ? 'expired' : ['failed', 'canceled', 'cancelled'].includes(verification.reason || '') ? 'failed' : 'pending';
    if (status === 'pending') return { paid: false, payment: paymentRow(payment) };
    const update = await database.query<any>("UPDATE bluepal_payments SET status=$2,updated_at=NOW() WHERE public_id=$1 AND status='pending' RETURNING *", [paymentId, status]);
    return { paid: false, payment: paymentRow(update.rows[0] || payment) };
  }
  return activatePaidPayment(database, paymentId, verification.reference || payment.track_id);
}

function paymentReturnPage(paid: boolean) {
  const title = paid ? 'پرداخت تایید شد' : 'در انتظار تایید پرداخت';
  const message = paid ? 'اشتراک شما فعال شد. به اپلیکیشن برگردید.' : 'وضعیت پرداخت هنوز نهایی نشده است. اپلیکیشن را باز کنید تا وضعیت دوباره بررسی شود.';
  return `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#061329"><title>${title}</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#020817;color:#f5f8ff;font:16px Tahoma,Arial,sans-serif"><main style="max-width:420px;margin:24px;padding:28px;border:1px solid #00dcca;border-radius:24px;background:linear-gradient(145deg,#0c2149,#08152f);text-align:center"><h2>${title}</h2><p>${message}</p><p style="color:#aab8e8;font-size:13px">می‌توانید این صفحه را ببندید.</p></main></body></html>`;
}

export async function handleMobileRequest(action: string, req: any, res: any, database: MobileDatabase) {
  const method = String(req.method || 'GET').toUpperCase();
  if (!['register', 'login', 'me', 'logout', 'presence', 'usage', 'proxy', 'chat', 'plans', 'payment-create', 'payment-status', 'payment-return'].includes(action)) {
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
        RETURNING id, name, username, created_at AS "createdAt"`,
        [name, username, passwordHash],
      );
      const user = created.rows[0];
      await database.query(`UPDATE users SET subscription_started_at=NOW(),subscription_expires_at=NOW()+INTERVAL '7 days',
        subscription_quota_bytes=(SELECT quota_bytes FROM subscription_plans WHERE name='آزمایشی'),subscription_used_bytes=0 WHERE id=$1`, [user.id]);
      await database.query(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status)
        SELECT u.id,p.id,u.subscription_started_at,u.subscription_expires_at,u.subscription_quota_bytes,0,'active'
        FROM users u JOIN subscription_plans p ON p.name=u.plan WHERE u.id=$1`, [user.id]);
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
    const found = await database.query<{ id: string; name: string; username: string; password_hash: string | null; created_at: string }>(
      'SELECT id, name, username, password_hash, created_at FROM users WHERE username = $1', [username],
    );
    const user = found.rows[0];
    if (typeof password !== 'string' || !user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return reply(res, 401, { message: 'ایمیل/نام کاربری یا رمز عبور اشتباه است.' });
    }
    const token = crypto.randomUUID();
    await database.query('INSERT INTO app_user_sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
    return reply(res, 200, { token, id: user.id, name: user.name, username: user.username, createdAt: user.created_at });
  }

  const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const query = new URL(req.originalUrl || req.url || '/', 'http://localhost').searchParams;
  if (action === 'payment-return' && method === 'GET') {
    let paid = false;
    try { paid = Boolean((await settleBluePalPayment(database, String(query.get('paymentId') || ''))).paid); }
    catch (error) { console.warn('BluePal return verification deferred:', error); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(paymentReturnPage(paid));
  }
  if (action === 'plans' && method === 'GET') {
    if (!token) return reply(res, 401, { message: 'برای دیدن پلن‌ها وارد حساب شوید.' });
    const session = await database.query<any>('SELECT 1 FROM app_user_sessions WHERE token=$1 AND (expires_at IS NULL OR expires_at>NOW())', [token]);
    if (!session.rows[0]) return reply(res, 401, { message: 'نشست شما منقضی شده است.' });
    const plans = await database.query<any>(`SELECT id,name,description,price_irr AS "priceToman",quota_bytes AS "quotaBytes",
      duration_days AS "durationDays",simultaneous_devices AS "simultaneousDevices",features
      FROM subscription_plans WHERE active=true ORDER BY price_irr,id`);
    return reply(res, 200, plans.rows);
  }
  if (action === 'payment-create' && method === 'POST') {
    if (!token) return reply(res, 401, { message: 'برای خرید وارد حساب شوید.' });
    const planId = Number(bodyOf(req).planId);
    if (!Number.isSafeInteger(planId) || planId < 1) return reply(res, 400, { message: 'پلن انتخاب‌شده معتبر نیست.' });
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<any>(`SELECT u.id FROM app_user_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token=$1 AND (s.expires_at IS NULL OR s.expires_at>NOW()) FOR UPDATE OF s`, [token]);
      if (!session.rows[0]) { await client.query('ROLLBACK'); return reply(res, 401, { message: 'نشست شما منقضی شده است.' }); }
      const userId = String(session.rows[0].id);
      const plan = await client.query<any>('SELECT * FROM subscription_plans WHERE id=$1 AND active=true FOR SHARE', [planId]);
      const selected = plan.rows[0];
      if (!selected) { await client.query('ROLLBACK'); return reply(res, 404, { message: 'پلن فعال پیدا نشد.' }); }
      const amount = Number(selected.price_irr);
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 50000000 || (amount > 0 && amount < 10000)) { await client.query('ROLLBACK'); return reply(res, 400, { message: 'قیمت پلن باید رایگان یا بین ۱۰٬۰۰۰ تا ۵۰٬۰۰۰٬۰۰۰ تومان باشد.' }); }
      const previous = await client.query<any>(`SELECT * FROM bluepal_payments WHERE user_id=$1 AND status='pending'
        AND created_at>NOW()-INTERVAL '30 minutes' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [userId]);
      if (previous.rows[0]) {
        await client.query('COMMIT');
        if (previous.rows[0].track_id && previous.rows[0].payment_url) return reply(res, 200, paymentRow(previous.rows[0]));
        return reply(res, 409, { message: 'صدور فاکتور قبلی در حال بررسی است؛ برای جلوگیری از فاکتور تکراری بعداً دوباره وضعیت را بررسی کنید.', invoiceOutcomeUnknown: true });
      }
      const publicId = crypto.randomUUID();
      const inserted = await client.query<any>(`INSERT INTO bluepal_payments(public_id,user_id,plan_id,plan_name,quota_bytes,duration_days,amount_toman,amount_rial)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [publicId,userId,planId,selected.name,selected.quota_bytes,selected.duration_days,amount,amount*10]);
      await client.query('COMMIT');
      const payment = inserted.rows[0];
      if (amount === 0) return reply(res,201,{ ...(await activatePaidPayment(database,publicId,'FREE')).payment,free:true });
      const config = await readBluePalConfig(database);
      if (!config) return reply(res,503,{message:'تنظیمات درگاه بلوپال در دسترس نیست.'});
      const callbackUrl = `${appOrigin(req)}/api/mobile?action=payment-return&paymentId=${encodeURIComponent(publicId)}`;
      const invoice = await requestBluePalPayment(config,{amount,callbackUrl,description:`خرید پلن ${selected.name} فیلترشکن`});
      const updated = await database.query<any>('UPDATE bluepal_payments SET track_id=$2,payment_url=$3,amount_rial=$4,expires_at=$5,updated_at=NOW() WHERE public_id=$1 RETURNING *',[publicId,invoice.trackId,invoice.paymentUrl,invoice.amountRial,invoice.expiresAt ? new Date(invoice.expiresAt) : null]);
      return reply(res,201,paymentRow(updated.rows[0]));
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('BluePal invoice creation failed:',error);
      return reply(res,502,{message:String(error?.message || 'صدور فاکتور بلوپال انجام نشد. اگر درخواست به درگاه رسیده، پیش از تلاش دوباره پنل را بررسی کنید.'),invoiceOutcomeUnknown:true});
    } finally { client.release(); }
  }
  if (action === 'payment-status' && method === 'GET') {
    if (!token) return reply(res,401,{message:'برای بررسی پرداخت وارد حساب شوید.'});
    const paymentId = String(query.get('paymentId') || '');
    if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return reply(res,400,{message:'شناسه فاکتور معتبر نیست.'});
    const owner = await database.query<any>(`SELECT 1 FROM bluepal_payments p JOIN app_user_sessions s ON s.user_id=p.user_id
      WHERE p.public_id=$1 AND s.token=$2 AND (s.expires_at IS NULL OR s.expires_at>NOW())`,[paymentId,token]);
    if (!owner.rows[0]) return reply(res,404,{message:'فاکتور برای این حساب پیدا نشد.'});
    try { return reply(res,200,(await settleBluePalPayment(database,paymentId)).payment || {status:'missing'}); }
    catch (error:any) { return reply(res,502,{message:String(error?.message || 'بررسی پرداخت از بلوپال انجام نشد.')}); }
  }
  if (action === 'chat' && (method === 'GET' || method === 'POST')) {
    if (!token) return reply(res, 401, { message: 'برای گفت‌وگو وارد حساب شوید.' });
    const session = await database.query<any>(`SELECT u.id AS "userId",u.name FROM app_user_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token=$1 AND (s.expires_at IS NULL OR s.expires_at>NOW())`, [token]);
    if (!session.rows[0]) return reply(res, 401, { message: 'نشست شما منقضی شده است.' });
    if (method === 'GET') {
      const messages = await database.query<any>(`SELECT id,author,message AS text,created_at AS time,sender_role AS "senderRole"
        FROM chat_messages WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200`, [session.rows[0].userId]);
      return reply(res, 200, messages.rows.reverse());
    }
    const message = String(bodyOf(req).message || '').trim();
    if (!message || message.length > 4000) return reply(res, 400, { message: 'پیام باید بین ۱ تا ۴۰۰۰ نویسه باشد.' });
    const inserted = await database.query<any>(`INSERT INTO chat_messages(user_id,sender_role,author,message)
      VALUES($1,'user',$2,$3) RETURNING id,author,message AS text,created_at AS time,sender_role AS "senderRole"`,
    [session.rows[0].userId, session.rows[0].name, message]);
    if (!inserted.rows[0]) return reply(res, 500, { message: 'پیام در پایگاه داده ثبت نشد.' });
    console.info('Mobile support message stored', { userId: String(session.rows[0].userId), messageId: String(inserted.rows[0].id) });
    return reply(res, 201, inserted.rows[0]);
  }
  if (action === 'proxy' && method === 'GET') {
    if (!token) return reply(res, 401, { message: 'برای دریافت پروکسی وارد حساب شوید.' });
    const access = await database.query<any>(`SELECT u.blocked,u.subscription_expires_at,(u.subscription_expires_at>NOW()) AS subscription_time_active,
      u.subscription_quota_bytes,u.subscription_used_bytes
      FROM app_user_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token=$1 AND (s.expires_at IS NULL OR s.expires_at>NOW())`, [token]);
    if (!access.rows[0]) return reply(res, 401, { message: 'نشست شما منقضی شده است.' });
    const user = access.rows[0];
    if (user.blocked || !user.subscription_time_active || BigInt(user.subscription_used_bytes || 0) >= BigInt(user.subscription_quota_bytes || 0)) {
      return reply(res, 403, { message: 'برای دریافت پروکسی به اشتراک فعال نیاز دارید.' });
    }
    const config = await database.query<any>('SELECT id AS "proxyId",name,host,port,username,password,updated_at AS "updatedAt" FROM proxy_servers WHERE active=true ORDER BY RANDOM() LIMIT 1');
    if (!config.rows[0]) return reply(res, 404, { message: 'هیچ پروکسی فعالی در پنل وجود ندارد.' });
    return reply(res, 200, { ...config.rows[0], type: 'socks5' });
  }
  if (action === 'usage' && method === 'GET') {
    if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
    const result = await database.query<any>(`SELECT u.id AS user_id,u.name,u.username,u.plan,u.blocked,u.subscription_started_at,
      u.subscription_expires_at,(u.subscription_expires_at>NOW()) AS subscription_time_active,
      u.subscription_quota_bytes,u.subscription_used_bytes
      FROM app_user_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token=$1 AND (s.expires_at IS NULL OR s.expires_at>NOW())`, [token]);
    if (!result.rows[0]) return reply(res, 401, { message: 'نشست شما منقضی شده است.' });
    const row=result.rows[0], quota=BigInt(row.subscription_quota_bytes||0), used=BigInt(row.subscription_used_bytes||0);
    const timeActive=Boolean(row.subscription_time_active);
    const canConnect=Boolean(!row.blocked&&timeActive&&used<quota);
    return reply(res,200,{id:row.user_id,name:row.name,username:row.username,plan:row.plan,
      subscriptionStartedAt:row.subscription_started_at,subscriptionExpiresAt:row.subscription_expires_at,
      subscriptionQuotaBytes:quota.toString(),subscriptionUsedBytes:used.toString(),blocked:Boolean(row.blocked),
      subscriptionTimeActive:timeActive,canConnect,exhausted:used>=quota,serverNow:new Date().toISOString()});
  }
  if (action === 'presence' && method === 'POST') {
    if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
    const body = bodyOf(req);
    if (typeof body.connected !== 'boolean' || !Number.isSafeInteger(body.sequence) || body.sequence < 1) {
      return reply(res, 400, { message: 'وضعیت اتصال یا شماره گزارش معتبر نیست.' });
    }
    const cumulativeBytes = body.cumulativeBytes === undefined ? undefined : Number(body.cumulativeBytes);
    if (cumulativeBytes !== undefined && (!Number.isSafeInteger(cumulativeBytes) || cumulativeBytes < 0)) return reply(res,400,{message:'گزارش مصرف معتبر نیست.'});
    const result = await reportPresence(database, token, body.connected, body.sequence, cumulativeBytes);
    if (!result.authorized) return reply(res, 401, { message: 'نشست شما منقضی شده است.' });
    if (result.denied) return reply(res,403,{...result.subscription,message:result.subscription?.blocked?'دسترسی این حساب توسط مدیر مسدود شده است.':'حجم یا مهلت اشتراک تمام شده است.'});
    if (result.subscription) return reply(res,200,{...result.subscription,success:true,applied:result.applied});
    return reply(res, 200, { success: true, applied: result.applied });
  }

  if (action === 'me' && method === 'GET') {
    if (!token) return reply(res, 401, { message: 'برای ادامه وارد شوید.' });
    const result = await database.query<{ id: string; name: string; username: string }>(
      `SELECT u.id, u.name, u.username,u.created_at AS "createdAt" FROM app_user_sessions s
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
      console.error('Mobile account API failed:', { action, method: String(req.method || 'GET').toUpperCase(), error });
      return reply(res, 503, { message: 'خطا در اتصال به پایگاه داده یا اجرای درخواست.' });
    }
  };
}
