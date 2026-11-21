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
  return { paymentId: row.public_id, status: row.status, planName: row.plan_name, amountToman: Number(row.amount_toman), amountRial: Number(row.amount_rial || 0), paymentUrl: row.payment_url || null, trackId: row.track_id || null, reference: row.reference || null, expiresAt: row.expires_at || null, cardNumber: row.card_number || '', accountHolder: row.account_holder || '' };
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

export async function settleMobileBluePalPayment(database: MobileDatabase, paymentId: string) {
  return settleBluePalPayment(database, paymentId);
}

function paymentDetailsPage(payment: any) {
  const safe = JSON.stringify({ paymentId: String(payment.public_id), planName: String(payment.plan_name || 'اشتراک'), amountToman: Number(payment.amount_toman || 0), amountRial: Number(payment.amount_rial || Number(payment.amount_toman || 0) * 10), trackId: String(payment.track_id || ''), expiresAt: payment.expires_at ? new Date(payment.expires_at).toISOString() : null, cardNumber: String(payment.card_number || ''), accountHolder: String(payment.account_holder || ''), paymentUrl: String(payment.payment_url || '') }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f5f8fa"><title>پرداخت اشتراک</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f4f7f8;color:#17232c;font:14px Tahoma,Arial,sans-serif}.wrap{width:min(100%,520px);margin:auto;padding:16px 14px 28px}.card{overflow:hidden;border:1px solid #dce7e9;border-radius:24px;background:#fff;box-shadow:0 10px 35px #0b29340d}.head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px;color:#fff;background:linear-gradient(105deg,#065f46,#0f766e,#102333)}.head b{font-size:14px}.timer{padding:7px 10px;border:1px solid #ffffff30;border-radius:12px;background:#0003;color:#fcd34d;font-weight:800;white-space:nowrap}.body{display:grid;gap:11px;padding:15px}.intro{margin:0 0 2px;color:#51616d;font-size:12px;line-height:1.9}.box{padding:14px;border:1px solid #e1e8ea;border-radius:17px;background:#fbfcfc}.label{display:block;margin-bottom:9px;color:#667580;font-size:11px;font-weight:700}.value{display:block;text-align:center;font-size:18px;font-weight:900;letter-spacing:.6px;direction:ltr;overflow-wrap:anywhere}.green{color:#087f5b}.sub{margin:9px 0 0;color:#74828b;font-size:10px;line-height:1.8;text-align:center}.copy{display:block;margin:10px auto 0;padding:9px 14px;border:0;border-radius:11px;background:#e6f7f0;color:#087f5b;font-weight:800}.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px;border:1px solid #e1e8ea;border-radius:14px;background:#fbfcfc;font-size:11px}.row b{max-width:64%;text-align:left;overflow-wrap:anywhere}.status{padding:12px;border:1px solid #cfe9dc;border-radius:13px;background:#effaf4;color:#18764e;font-size:11px;line-height:1.9}.status.wait{border-color:#f0e1bc;background:#fffaf0;color:#87621d}.status.bad{border-color:#f0cfd1;background:#fff5f5;color:#a83c45}.return{width:100%;height:44px;border:0;border-radius:14px;background:linear-gradient(90deg,#059669,#0f766e);color:white;font-weight:800}.frame{width:100%;height:58vh;border:1px solid #e1e8ea;border-radius:14px;background:white}.muted{color:#72818b;font-size:10px;line-height:1.8;text-align:center}@media(max-width:360px){.wrap{padding:10px}.body{padding:11px}.value{font-size:16px}}
  </style></head><body><main class="wrap"><section class="card"><header class="head"><b>پرداخت اشتراک · بلوپال</b><span id="timer" class="timer">مهلت: --:--</span></header><div class="body"><p class="intro" id="plan"></p><div id="transfer"><div class="box"><span class="label">شماره کارت مقصد</span><strong class="value" id="card">—</strong><button class="copy" id="copyCard">کپی شماره کارت</button></div><div class="box"><span class="label">مبلغ دقیق واریز (ریال)</span><strong class="value green" id="amount">—</strong><p class="sub">برای شناسایی خودکار فاکتور، مبلغ را دقیقاً به ریال واریز کنید.</p><button class="copy" id="copyAmount">کپی مبلغ ریالی</button></div><div class="row"><span>شناسه رسمی فاکتور</span><b id="invoice">—</b></div><div class="row"><span>صاحب حساب</span><b id="holder">—</b></div></div><div id="online" hidden><p class="muted">این پذیرنده پرداخت آنلاین دارد. پرداخت در همین اپ باز می‌شود و پس از بازگشت، وضعیت از سرور بررسی خواهد شد.</p><iframe id="frame" class="frame" title="صفحه امن پرداخت" referrerpolicy="no-referrer"></iframe><a id="openLink" class="copy" target="_self">ادامه پرداخت در همین اپ</a></div><div class="status wait" id="status">در حال بررسی وضعیت فاکتور از سرور سایت…</div><button id="return" class="return" hidden onclick="goHome()">بازگشت به خانه</button></div></section><p class="muted">تایید پرداخت مستقیماً از وب‌سرویس بلوپال انجام می‌شود؛ رسید یا تصویر پرداخت به‌تنهایی ملاک فعال‌سازی نیست.</p></main><script>
  const P=${safe};const $=id=>document.getElementById(id);const money=n=>Number(n||0).toLocaleString('fa-IR');$('plan').textContent='اشتراک انتخاب‌شده: '+P.planName+' · مبلغ '+money(P.amountToman)+' تومان';$('amount').textContent=money(P.amountRial);$('invoice').textContent=P.trackId||'—';$('holder').textContent=P.accountHolder||'—';if(P.cardNumber){$('card').textContent=P.cardNumber.replace(/(.{4})/g,'$1 ').trim()}else{$('transfer').hidden=true;$('online').hidden=false;$('frame').src=P.paymentUrl;$('openLink').href=P.paymentUrl}
  let seconds=P.expiresAt?Math.max(0,Math.floor((Date.parse(P.expiresAt)-Date.now())/1000)):1800;const timer=setInterval(()=>{seconds=Math.max(0,seconds-1);$('timer').textContent='مهلت: '+String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')},1000);function copy(value,button){const done=()=>{button.textContent='کپی شد';setTimeout(()=>button.textContent=button.id==='copyCard'?'کپی شماره کارت':'کپی مبلغ ریالی',1500)};if(navigator.clipboard)navigator.clipboard.writeText(value).then(done).catch(()=>fallback());else fallback();function fallback(){const input=document.createElement('textarea');input.value=value;document.body.appendChild(input);input.select();document.execCommand('copy');input.remove();done()}}$('copyCard').onclick=()=>copy(P.cardNumber,$('copyCard'));$('copyAmount').onclick=()=>copy(String(P.amountRial),$('copyAmount'));function goHome(){if(window.Native&&Native.goHome)Native.goHome();else $('status').textContent='پرداخت بررسی شد؛ می‌توانید صفحه را ببندید و به خانه برگردید.'}
  async function check(){try{const r=await fetch('/api/mobile?action=payment-page-status&paymentId='+encodeURIComponent(P.paymentId),{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.message||'بررسی پرداخت ناموفق بود');if(d.status==='paid'){clearInterval(timer);$('status').className='status';$('status').textContent='پرداخت تایید و اشتراک فعال شد. در حال بازگشت به خانه…';$('return').hidden=false;setTimeout(goHome,1800)}else if(d.status==='expired'||d.status==='failed'){clearInterval(timer);$('status').className='status bad';$('status').textContent=d.status==='expired'?'مهلت فاکتور تمام شده است. از داخل اپ یک فاکتور تازه صادر کنید.':'پرداخت لغو یا ناموفق شد.';if(seconds===0)$('return').hidden=false}else{ $('status').className='status wait';$('status').textContent=seconds===0?'مهلت پرداخت تمام شده؛ وضعیت نهایی در حال بررسی است…':'در انتظار پرداخت؛ بررسی خودکار ادامه دارد.'}}catch(e){$('status').className='status wait';$('status').textContent=(e.message||'ارتباط برقرار نشد')+'؛ بررسی دوباره ادامه دارد.'}}check();setInterval(check,4000);
  </script></body></html>`;
}

function paymentReturnPage(paid: boolean, paymentId = '') {
  const title = paid ? 'پرداخت تایید شد' : 'در انتظار تایید پرداخت';
  const message = paid ? 'اشتراک شما فعال شد. در حال بازگشت به اپلیکیشن…' : 'وضعیت پرداخت از سایت در حال بررسی است.';
  const safeId = JSON.stringify(paymentId).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#061329"><title>${title}</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7f8;color:#17232c;font:15px Tahoma,Arial,sans-serif"><main style="max-width:420px;margin:24px;padding:26px;border:1px solid #dce7e9;border-radius:24px;background:white;text-align:center"><h2 id="title">${title}</h2><p id="message">${message}</p><button id="home" hidden style="padding:12px 22px;border:0;border-radius:12px;background:#0f766e;color:white;font-weight:bold" onclick="goHome()">بازگشت به خانه</button></main><script>const pid=${safeId};function goHome(){if(window.Native&&Native.goHome)Native.goHome()}async function poll(){try{const r=await fetch('/api/mobile?action=payment-page-status&paymentId='+encodeURIComponent(pid),{cache:'no-store'});const d=await r.json();if(d.status==='paid'){document.getElementById('title').textContent='پرداخت تایید شد';document.getElementById('message').textContent='اشتراک فعال شد؛ در حال بازگشت به اپلیکیشن…';document.getElementById('home').hidden=false;setTimeout(goHome,1500)}}catch(e){}}poll();setInterval(poll,3000);</script></body></html>`;
}

export async function handleMobileRequest(action: string, req: any, res: any, database: MobileDatabase) {
  const method = String(req.method || 'GET').toUpperCase();
  if (!['register', 'login', 'me', 'logout', 'presence', 'usage', 'proxy', 'chat', 'plans', 'payment-create', 'payment-status', 'payment-page', 'payment-page-status', 'payment-return'].includes(action)) {
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
  if (action === 'payment-page' && method === 'GET') {
    const paymentId = String(query.get('paymentId') || '');
    if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return reply(res, 400, { message: 'شناسه فاکتور معتبر نیست.' });
    const found = await database.query<any>(`SELECT public_id,plan_name,amount_toman,amount_rial,track_id,expires_at,card_number,account_holder,payment_url,status
      FROM bluepal_payments WHERE public_id=$1`, [paymentId]);
    if (!found.rows[0]) return reply(res, 404, { message: 'فاکتور برای نمایش پیدا نشد.' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(paymentDetailsPage(found.rows[0]));
  }
  if (action === 'payment-page-status' && method === 'GET') {
    const paymentId = String(query.get('paymentId') || '');
    if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return reply(res, 400, { message: 'شناسه فاکتور معتبر نیست.' });
    try {
      const result = await settleBluePalPayment(database, paymentId);
      return reply(res, result.missing ? 404 : 200, result.payment || { status: 'missing' });
    } catch (error: any) { return reply(res, 502, { message: String(error?.message || 'بررسی پرداخت از بلوپال انجام نشد.') }); }
  }
  if (action === 'payment-return' && method === 'GET') {
    const paymentId = String(query.get('paymentId') || '');
    let paid = false;
    try { paid = Boolean((await settleBluePalPayment(database, paymentId)).paid); }
    catch (error) { console.warn('BluePal return verification deferred:', error); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(paymentReturnPage(paid, paymentId));
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
    let paymentId = '';
    let providerInvoiceReceived = false;
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
        if (previous.rows[0].track_id && previous.rows[0].payment_url) {
          await client.query('COMMIT');
          return reply(res, 200, paymentRow(previous.rows[0]));
        }
        if (previous.rows[0].track_id || previous.rows[0].payment_url) {
          await client.query('COMMIT');
          return reply(res, 409, { message: 'اطلاعات فاکتور قبلی ناقص است؛ برای جلوگیری از صدور فاکتور تکراری، پشتیبانی را مطلع کنید.', invoiceOutcomeUnknown: true });
        }
        // A pending row without a provider invoice ID/link can never be resumed by the app.
        // Retire it so a failed invoice request does not block all future purchases.
        await client.query("UPDATE bluepal_payments SET status='failed',updated_at=NOW() WHERE public_id=$1 AND status='pending'", [previous.rows[0].public_id]);
      }
      const publicId = crypto.randomUUID();
      paymentId = publicId;
      const inserted = await client.query<any>(`INSERT INTO bluepal_payments(public_id,user_id,plan_id,plan_name,quota_bytes,duration_days,amount_toman,amount_rial)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [publicId,userId,planId,selected.name,selected.quota_bytes,selected.duration_days,amount,amount*10]);
      await client.query('COMMIT');
      const payment = inserted.rows[0];
      if (amount === 0) return reply(res,201,{ ...(await activatePaidPayment(database,publicId,'FREE')).payment,free:true });
      const config = await readBluePalConfig(database);
      if (!config) {
        await database.query("UPDATE bluepal_payments SET status='failed',updated_at=NOW() WHERE public_id=$1 AND status='pending'", [publicId]);
        return reply(res,503,{message:'تنظیمات درگاه بلوپال در دسترس نیست.'});
      }
      const callbackUrl = `${appOrigin(req)}/api/mobile?action=payment-return&paymentId=${encodeURIComponent(publicId)}`;
      const invoice = await requestBluePalPayment(config,{amount,callbackUrl,description:`خرید پلن ${selected.name} فیلترشکن`});
      providerInvoiceReceived = true;
      const updated = await database.query<any>('UPDATE bluepal_payments SET track_id=$2,payment_url=$3,amount_rial=$4,expires_at=$5,card_number=$6,account_holder=$7,updated_at=NOW() WHERE public_id=$1 RETURNING *',[publicId,invoice.trackId,invoice.paymentUrl,invoice.amountRial,invoice.expiresAt ? new Date(invoice.expiresAt) : null,invoice.cardNumber,invoice.accountHolder]);
      return reply(res,201,paymentRow(updated.rows[0]));
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (paymentId && !providerInvoiceReceived) {
        await database.query("UPDATE bluepal_payments SET status='failed',updated_at=NOW() WHERE public_id=$1 AND status='pending' AND track_id IS NULL AND payment_url IS NULL", [paymentId]).catch(() => undefined);
      }
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
