import express from 'express';
import bcrypt from 'bcryptjs';
import { encryptUserPassword } from './userPassword.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { initializeDatabase, pool } from './database.js';
import { createMobileHandler, handleMobileRequest, settleMobileBluePalPayment } from './mobile.js';
import { selectUsers } from './presence.js';
import { handleBluePalAdminRequest } from './bluepal.js';
import { getMaintenanceMode, setMaintenanceMode } from './serviceControl.js';
import { createProxyImportHandler } from './proxyImport.js';
import { createProxyBulkHandler } from './proxyBulk.js';
import { createProxyListHandler } from './proxyList.js';
import { createSubscriptionUsageResetHandler } from './subscriptionUsage.js';
import { createTelegramHandler } from './telegram.js';
import { createTelegramChannelPublisher } from './telegramChannel.js';

const app = express();
const port = Number(process.env.PORT || 3001);
export { initializeDatabase } from './database.js';

app.use('/api/proxies/import', express.json({ limit: '2mb' }));
app.use('/api/proxies/bulk', express.json({ limit: '1mb' }));
app.use(express.json({ verify: (req: any, _res, buffer) => { req.rawBody = buffer.toString('utf8'); } }));
app.all(['/api/mobile', '/api/mobile/:action'], createMobileHandler(pool, initializeDatabase));
app.all(['/api/telegram', '/api/telegram/channel/scheduled'], createTelegramHandler(pool, initializeDatabase));
app.get('/api/mobile', async (req, res, next) => {
  try {
    if (String(req.query.action || '').toLowerCase() !== 'payment-return') return next();
    return await handleMobileRequest('payment-return', req, res, pool);
  } catch (error) { next(error); }
});
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

app.get('/api/health', async (_req, res) => {
  try {
    await initializeDatabase();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ status: 'error', message: 'اتصال پایگاه داده برقرار نیست.' });
  }
});

app.post('/api/payment/bluepal/webhook', async (req, res, next) => {
  try {
    await initializeDatabase();
    const result = await pool.query<any>('SELECT webhook_secret FROM bluepal_settings WHERE id=1');
    const secret = String(result.rows[0]?.webhook_secret || '');
    if (secret) {
      const supplied = String(req.headers['x-blupal-signature'] || req.headers['x-webhook-signature'] || '');
      const raw = String((req as any).rawBody || JSON.stringify(req.body || {}));
      const expected = createHmac('sha256', secret).update(raw).digest('hex');
      const left = Buffer.from(supplied), right = Buffer.from(expected);
      if (left.length !== right.length || !timingSafeEqual(left, right)) return res.status(401).json({ success: false, message: 'امضای وب‌هوک معتبر نیست.' });
    }
    const body = req.body || {};
    const invoiceId = String(body.invoice_id ?? body.id ?? body.track_id ?? '');
    const status = String(body.status || '').toLowerCase();
    if (!invoiceId) return res.status(400).json({ success: false, message: 'شناسه فاکتور در وب‌هوک موجود نیست.' });
    if (['paid','success','successful','completed'].includes(status)) {
      const payment = await pool.query<any>('SELECT public_id FROM bluepal_payments WHERE track_id=$1', [invoiceId]);
      if (!payment.rows[0]) return res.status(200).json({ success: true, received: true, matched: false });
      const settled = await settleMobileBluePalPayment(pool, String(payment.rows[0].public_id));
      return res.status(settled.paid ? 200 : 202).json({ success: true, received: true, matched: true, payment: settled.paid ? 'paid' : 'pending-verification' });
    }
    return res.status(200).json({ success: true, received: true });
  } catch (error) { next(error); }
});

app.post('/api/login', async (req, res, next) => {
  try {
    await initializeDatabase();
    const { username, password } = req.body ?? {};
    const result = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM admins WHERE username = $1',
      [username],
    );
    if (typeof password !== 'string' || !result.rows[0] || !(await bcrypt.compare(password, result.rows[0].password_hash))) {
      return res.status(401).json({ message: 'نام کاربری یا رمز عبور اشتباه است.' });
    }
    const token = crypto.randomUUID();
    await pool.query(
      `INSERT INTO sessions (token, admin_username, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [token, username],
    );
    res.json({ token, username });
  } catch (error) { next(error); }
});

app.use('/api', async (req, res, next) => {
  try {
    await initializeDatabase();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ message: 'برای ادامه وارد شوید.' });
    const result = await pool.query(
      'SELECT 1 FROM sessions WHERE token = $1 AND expires_at > NOW()',
      [token],
    );
    if (!result.rowCount) return res.status(401).json({ message: 'نشست شما منقضی شده است؛ دوباره وارد شوید.' });
    next();
  } catch (error) { next(error); }
});

app.all('/api/payment/bluepal/:action', async (req, res, next) => {
  try {
    const handled = await handleBluePalAdminRequest(req.path, req.method, req, res, pool);
    if (handled === null) return next();
  } catch (error) { next(error); }
});

app.get('/api/transactions', async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT p.id,p.public_id AS "paymentId",u.name AS "userName",u.username,
      p.plan_name AS "planName",p.amount_toman AS "amountToman",p.status,p.track_id AS "trackId",p.reference,
      p.payment_url AS "paymentUrl",p.created_at AS "createdAt",p.paid_at AS "paidAt"
      FROM bluepal_payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 500`);
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.get('/api/service-status', async (_req, res, next) => {
  try { res.json({ maintenanceMode: await getMaintenanceMode(pool) }); }
  catch (error) { next(error); }
});

app.put('/api/service-status', async (req, res, next) => {
  try {
    const maintenanceMode = req.body?.maintenanceMode;
    if (typeof maintenanceMode !== 'boolean') return res.status(400).json({ message: 'وضعیت سرویس معتبر نیست.' });
    res.json(await setMaintenanceMode(pool, maintenanceMode));
  } catch (error) { next(error); }
});

app.get('/api/dashboard-stats', async (_req, res, next) => {
  try {
    const result = await pool.query<any>(`SELECT COALESCE(SUM(amount_toman),0)::text AS "monthRevenueToman",
      COUNT(*)::int AS "successfulPayments"
      FROM bluepal_payments
      WHERE status='paid'
        AND COALESCE(paid_at,updated_at,created_at) >= (date_trunc('month',NOW() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran')
        AND COALESCE(paid_at,updated_at,created_at) < ((date_trunc('month',NOW() AT TIME ZONE 'Asia/Tehran') + INTERVAL '1 month') AT TIME ZONE 'Asia/Tehran')`);
    res.json(result.rows[0] || { monthRevenueToman: '0', successfulPayments: 0 });
  } catch (error) { next(error); }
});

app.get('/api/users', async (_req, res, next) => {
  try {
    const result = await selectUsers(pool);
    res.json(result.rows);
  } catch (error) { next(error); }
});

const handleProxyList = createProxyListHandler(pool);
app.all('/api/proxies', async (req, res, next) => {
  try { await handleProxyList(req, res); } catch (error) { next(error); }
});

app.post('/api/proxies/import', async (req,res,next) => {
  try { await createProxyImportHandler(pool)(req,res); } catch (error) { next(error); }
});

app.all('/api/proxies/bulk', async (req,res,next) => {
  try { await createProxyBulkHandler(pool)(req,res); } catch (error) { next(error); }
});

app.get('/api/subscriptions', async (_req, res, next) => {
  try { const result=await pool.query(`SELECT p.id,p.name,p.description,p.price_irr AS "priceIrr",p.quota_bytes AS "quotaBytes",
    p.duration_days AS "durationDays",p.simultaneous_devices AS "simultaneousDevices",p.features,p.active,p.is_trial AS "isTrial",COUNT(u.id)::int AS users
    FROM subscription_plans p LEFT JOIN users u ON u.plan=p.name GROUP BY p.id ORDER BY p.id`); res.json(result.rows); }
  catch(error){next(error);}
});

app.delete('/api/subscriptions',async(req,res,next)=>{try{
  const id=Number(req.query.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({message:'شناسه پلن معتبر نیست.'});
  const references=await pool.query<any>(`SELECT
    (SELECT COUNT(*)::int FROM user_subscriptions WHERE plan_id=$1) AS subscriptions,
    (SELECT COUNT(*)::int FROM bluepal_payments WHERE plan_id=$1) AS payments`,[id]);
  if(Number(references.rows[0]?.subscriptions)>0||Number(references.rows[0]?.payments)>0)return res.status(409).json({message:'این پلن سابقهٔ اشتراک یا فاکتور دارد و برای حفظ سوابق حذف نمی‌شود؛ می‌توانید آن را خاموش کنید.'});
  const result=await pool.query('DELETE FROM subscription_plans WHERE id=$1 RETURNING id',[id]);
  if(!result.rows[0])return res.status(404).json({message:'پلن پیدا نشد.'});res.json({success:true,id:result.rows[0].id});
}catch(error){next(error);}});

app.post('/api/user-subscriptions/reset-usage', async (req,res,next)=>{
  try { return await createSubscriptionUsageResetHandler(pool)(req,res); } catch(error) { next(error); }
});

app.get('/api/user-subscriptions', async (_req,res,next)=>{try{
  const result=await pool.query(`SELECT u.id AS "userId",u.name AS "userName",u.username,p.id AS "planId",p.name AS "planName",p.duration_days AS "durationDays",
    u.subscription_started_at AS "startedAt",u.subscription_expires_at AS "expiresAt",
    u.subscription_quota_bytes AS "quotaBytes",u.subscription_used_bytes AS "usedBytes",u.blocked,
    (u.subscription_expires_at>NOW() AND u.subscription_used_bytes<u.subscription_quota_bytes) AS active
    FROM users u LEFT JOIN subscription_plans p ON p.name=u.plan
    WHERE u.subscription_started_at IS NOT NULL ORDER BY u.subscription_started_at DESC`);
  res.json(result.rows);
}catch(error){next(error);}});

app.patch('/api/user-subscriptions',async(req,res,next)=>{const db=await pool.connect();try{
  const userId=Number(req.body?.userId),planId=Number(req.body?.planId),days=Number(req.body?.durationDays),quota=Number(req.body?.quotaBytes);
  if(!Number.isSafeInteger(userId)||userId<1||!Number.isSafeInteger(planId)||planId<1||!Number.isInteger(days)||days<1||days>3650||!Number.isSafeInteger(quota)||quota<1)return res.status(400).json({message:'مشخصات اشتراک معتبر نیست.'});
  await db.query('BEGIN');const plan=(await db.query<any>('SELECT * FROM subscription_plans WHERE id=$1 AND active=true',[planId])).rows[0];if(!plan){await db.query('ROLLBACK');return res.status(404).json({message:'پلن فعال پیدا نشد.'});}
  const user=(await db.query<any>('SELECT id,subscription_used_bytes FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];if(!user){await db.query('ROLLBACK');return res.status(404).json({message:'کاربر پیدا نشد.'});}
  const used=String(user.subscription_used_bytes||0);
  const start=new Date(),expires=new Date(start.getTime()+days*86400000);
  await db.query("UPDATE user_subscriptions SET status='cancelled',used_bytes=$2 WHERE user_id=$1 AND status='active'",[userId,used]);
  const sub=(await db.query<any>(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status) VALUES($1,$2,$3,$4,$5,$6,'active')
    RETURNING id,user_id AS "userId",plan_id AS "planId",started_at AS "startedAt",expires_at AS "expiresAt",quota_bytes AS "quotaBytes",used_bytes AS "usedBytes",status`,[userId,planId,start,expires,quota,used])).rows[0];
  await db.query('UPDATE users SET plan=$2,subscription_started_at=$3,subscription_expires_at=$4,subscription_quota_bytes=$5,subscription_used_bytes=$6 WHERE id=$1',[userId,plan.name,start,expires,quota,used]);
  await db.query('COMMIT');res.json({...sub,planName:plan.name,durationDays:days});
}catch(error){await db.query('ROLLBACK').catch(()=>undefined);next(error);}finally{db.release();}});

app.post('/api/users/block',async(req,res,next)=>{try{
  const id=Number(req.body?.userId),blocked=req.body?.blocked;
  if(!Number.isSafeInteger(id)||id<1||typeof blocked!=='boolean')return res.status(400).json({message:'شناسه کاربر یا وضعیت مسدودسازی معتبر نیست.'});
  const result=await pool.query('UPDATE users SET blocked=$2 WHERE id=$1 RETURNING id',[id,blocked]);
  if(!result.rows[0])return res.status(404).json({message:'کاربر پیدا نشد.'});
  if(blocked)await pool.query('UPDATE app_user_sessions SET vpn_connected=FALSE,vpn_heartbeat_at=NULL WHERE user_id=$1',[id]);
  res.json({success:true,userId:id,blocked});
}catch(error){next(error);}});

app.post('/api/subscriptions', async (req,res,next)=>{ try {
  const {name,description='',priceIrr,quotaBytes,durationDays,simultaneousDevices=1,features=[],active=true}=req.body??{};
  if(typeof name!=='string'||name.trim().length<2||name.trim().length>80||typeof description!=='string'||description.length>1000||!Number.isSafeInteger(Number(priceIrr))||Number(priceIrr)<0||!Number.isSafeInteger(Number(quotaBytes))||Number(quotaBytes)<1||!Number.isInteger(Number(durationDays))||Number(durationDays)<1||Number(durationDays)>3650||!Number.isInteger(Number(simultaneousDevices))||Number(simultaneousDevices)<1||Number(simultaneousDevices)>100||!Array.isArray(features)||features.length>50||features.some((v:unknown)=>typeof v!=='string'||v.length>200)||typeof active!=='boolean') return res.status(400).json({message:'مشخصات اشتراک معتبر نیست.'});
  const result=await pool.query(`INSERT INTO subscription_plans(name,description,price_irr,quota_bytes,duration_days,simultaneous_devices,features,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id,name,description,price_irr AS "priceIrr",quota_bytes AS "quotaBytes",duration_days AS "durationDays",simultaneous_devices AS "simultaneousDevices",features,active,is_trial AS "isTrial"`,[name.trim(),description.trim(),priceIrr,quotaBytes,durationDays,simultaneousDevices,JSON.stringify(features),Boolean(active)]); res.status(201).json(result.rows[0]);
 } catch(error:any){if(error?.code==='23505')return res.status(409).json({message:'نام این اشتراک از قبل وجود دارد.'});next(error);}});

app.patch('/api/subscriptions',async(req,res,next)=>{try{
  const id=Number(req.query.id),{name,description,priceIrr,quotaBytes,durationDays,simultaneousDevices,features,active}=req.body??{};
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({message:'شناسه اشتراک معتبر نیست.'});
  if((name!==undefined&&(typeof name!=='string'||name.trim().length<2||name.trim().length>80))||(description!==undefined&&(typeof description!=='string'||description.length>1000))||(priceIrr!==undefined&&(!Number.isSafeInteger(Number(priceIrr))||Number(priceIrr)<0))||(quotaBytes!==undefined&&(!Number.isSafeInteger(Number(quotaBytes))||Number(quotaBytes)<1))||(durationDays!==undefined&&(!Number.isInteger(Number(durationDays))||Number(durationDays)<1||Number(durationDays)>3650))||(simultaneousDevices!==undefined&&(!Number.isInteger(Number(simultaneousDevices))||Number(simultaneousDevices)<1||Number(simultaneousDevices)>100))||(features!==undefined&&(!Array.isArray(features)||features.length>50||features.some((v:unknown)=>typeof v!=='string'||v.length>200)))||(active!==undefined&&typeof active!=='boolean'))return res.status(400).json({message:'مشخصات اشتراک معتبر نیست.'});
  const db=await pool.connect();try{await db.query('BEGIN');
  const before=(await db.query<any>('SELECT name FROM subscription_plans WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!before){await db.query('ROLLBACK');return res.status(404).json({message:'اشتراک پیدا نشد.'});}
  const result=await db.query(`UPDATE subscription_plans SET name=COALESCE($2,name),description=COALESCE($3,description),price_irr=COALESCE($4,price_irr),quota_bytes=COALESCE($5,quota_bytes),duration_days=COALESCE($6,duration_days),simultaneous_devices=COALESCE($7,simultaneous_devices),features=COALESCE($8,features),active=COALESCE($9,active),updated_at=NOW() WHERE id=$1 RETURNING id,name,description,price_irr AS "priceIrr",quota_bytes AS "quotaBytes",duration_days AS "durationDays",simultaneous_devices AS "simultaneousDevices",features,active,is_trial AS "isTrial"`,[id,name?.trim()??null,description?.trim()??null,priceIrr??null,quotaBytes??null,durationDays??null,simultaneousDevices??null,features!==undefined?JSON.stringify(features):null,active??null]);
  if(before.name!==result.rows[0].name)await db.query('UPDATE users SET plan=$2 WHERE plan=$1',[before.name,result.rows[0].name]);
  await db.query('COMMIT');res.json(result.rows[0]);
  }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
}catch(error:any){if(error?.code==='23505')return res.status(409).json({message:'نام این اشتراک از قبل وجود دارد.'});next(error);}});

app.post('/api/users',async(req,res,next)=>{try{
  const {name,username,password,plan='آزمایشی'}=req.body??{},n=String(name||'').trim(),u=String(username||'').trim().toLowerCase();
  if(n.length<2||n.length>80||!(/^[a-z0-9._+-]{3,64}$|^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(u)||typeof password!=='string'||password.length<8||password.length>128)return res.status(400).json({message:'مشخصات کاربر معتبر نیست.'});
  const passwordHash=await bcrypt.hash(password,10),encryptedPassword=encryptUserPassword(password,passwordHash);
  const result=await pool.query<any>(`INSERT INTO users(name,username,status,plan,last_seen,password_hash,password_encrypted) VALUES($1,$2,'آفلاین',$3,'هنوز متصل نشده',$4,$5) RETURNING id,name,username,plan`,[n,u,String(plan),passwordHash,encryptedPassword]); const user=result.rows[0];
  const sub=await pool.query<any>(`UPDATE users SET subscription_started_at=NOW(),subscription_expires_at=NOW()+p.duration_days*INTERVAL '1 day',subscription_quota_bytes=p.quota_bytes,subscription_used_bytes=0 FROM subscription_plans p WHERE users.id=$1 AND p.name=users.plan RETURNING users.subscription_started_at AS "subscriptionStartedAt",users.subscription_expires_at AS "subscriptionExpiresAt",users.subscription_quota_bytes AS "subscriptionQuotaBytes",users.subscription_used_bytes AS "subscriptionUsedBytes"`,[user.id]);
  if(!sub.rows[0]){await pool.query('DELETE FROM users WHERE id=$1',[user.id]);return res.status(400).json({message:'پلن اشتراک پیدا نشد.'});}
  const planRow=await pool.query<any>('SELECT id FROM subscription_plans WHERE name=$1',[user.plan]);await pool.query(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status) VALUES($1,$2,$3,$4,$5,0,'active')`,[user.id,planRow.rows[0].id,sub.rows[0].subscriptionStartedAt,sub.rows[0].subscriptionExpiresAt,sub.rows[0].subscriptionQuotaBytes]);res.status(201).json({...user,status:'آفلاین',lastSeen:'هنوز متصل نشده',...sub.rows[0]});
}catch(error:any){if(error?.code==='23505')return res.status(409).json({message:'این نام کاربری از قبل ثبت شده است.'});next(error);}});

app.patch('/api/users',async(req,res,next)=>{try{
  const id=Number(req.query.id),{name,username,plan,password}=req.body??{};if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({message:'شناسه کاربر معتبر نیست.'});if(plan!==undefined){const valid=await pool.query('SELECT 1 FROM subscription_plans WHERE name=$1',[plan]);if(!valid.rowCount)return res.status(400).json({message:'پلن اشتراک پیدا نشد.'});}
  if(password!==undefined&&password!==''&&(typeof password!=='string'||password.length<8||password.length>128))return res.status(400).json({message:'رمز تازه باید بین ۸ تا ۱۲۸ نویسه باشد.'});
  const previous=(await pool.query<any>('SELECT plan,subscription_used_bytes FROM users WHERE id=$1',[id])).rows[0];if(!previous)return res.status(404).json({message:'کاربر پیدا نشد.'});const changedPlan=plan!==undefined&&plan!==previous.plan;const assignedPlan=changedPlan?plan:null;
  const passwordHash=password?await bcrypt.hash(password,10):null,encryptedPassword=passwordHash?encryptUserPassword(password,passwordHash):null;
  const result=await pool.query(`UPDATE users SET name=COALESCE($2,name),username=COALESCE($3,username),plan=COALESCE($4,plan),password_hash=COALESCE($5,password_hash),password_encrypted=CASE WHEN $5::text IS NULL THEN password_encrypted ELSE $6 END,subscription_started_at=CASE WHEN $4 IS NULL THEN subscription_started_at ELSE NOW() END,subscription_expires_at=CASE WHEN $4 IS NULL THEN subscription_expires_at ELSE NOW()+(SELECT duration_days FROM subscription_plans WHERE name=$4)*INTERVAL '1 day' END,subscription_quota_bytes=CASE WHEN $4 IS NULL THEN subscription_quota_bytes ELSE (SELECT quota_bytes FROM subscription_plans WHERE name=$4)+CASE WHEN subscription_expires_at>NOW() THEN GREATEST(subscription_quota_bytes-subscription_used_bytes,0) ELSE 0 END END,subscription_used_bytes=CASE WHEN $4 IS NULL THEN subscription_used_bytes ELSE 0 END WHERE id=$1 RETURNING id,name,username,plan,last_seen AS "lastSeen",subscription_started_at AS "subscriptionStartedAt",subscription_expires_at AS "subscriptionExpiresAt",subscription_quota_bytes AS "subscriptionQuotaBytes",subscription_used_bytes AS "subscriptionUsedBytes"`,[id,name?.trim()??null,username?.trim().toLowerCase()??null,assignedPlan,passwordHash,encryptedPassword]);
  if(!result.rows[0])return res.status(404).json({message:'کاربر پیدا نشد.'});if(changedPlan){const p=await pool.query<any>('SELECT id FROM subscription_plans WHERE name=$1',[plan]);await pool.query("UPDATE user_subscriptions SET status='cancelled',used_bytes=$2 WHERE user_id=$1 AND status='active'",[id,previous.subscription_used_bytes||0]);await pool.query(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status) VALUES($1,$2,$3,$4,$5,0,'active')`,[id,p.rows[0].id,result.rows[0].subscriptionStartedAt,result.rows[0].subscriptionExpiresAt,result.rows[0].subscriptionQuotaBytes]);}res.json({...result.rows[0],status:'آفلاین'});
}catch(error:any){if(error?.code==='23505')return res.status(409).json({message:'این نام کاربری از قبل وجود دارد.'});next(error);}});

app.delete('/api/users',async(req,res,next)=>{try{const id=Number(req.query.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({message:'شناسه کاربر معتبر نیست.'});const result=await pool.query('DELETE FROM users WHERE id=$1',[id]);if(!result.rowCount)return res.status(404).json({message:'کاربر پیدا نشد.'});res.json({success:true});}catch(error){next(error);}});

app.get('/api/users/:id/subscriptions',async(req,res,next)=>{try{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({message:'شناسه کاربر معتبر نیست.'});const result=await pool.query(`SELECT s.id,s.user_id AS "userId",s.plan_id AS "planId",p.name AS "planName",s.started_at AS "startedAt",s.expires_at AS "expiresAt",s.quota_bytes AS "quotaBytes",s.used_bytes AS "usedBytes",s.status FROM user_subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.user_id=$1 ORDER BY s.started_at DESC`,[id]);res.json(result.rows);}catch(error){next(error);}});

app.post('/api/users/:id/subscriptions',async(req,res,next)=>{const db=await pool.connect();try{
  const userId=Number(req.params.id),planId=Number(req.body?.planId),days=req.body?.durationDays===undefined?null:Number(req.body.durationDays),quota=req.body?.quotaBytes===undefined?null:Number(req.body.quotaBytes);
  if(!Number.isSafeInteger(userId)||userId<1||!Number.isSafeInteger(planId)||planId<1||days!==null&&(!Number.isInteger(days)||days<1||days>3650)||quota!==null&&(!Number.isSafeInteger(quota)||quota<1))return res.status(400).json({message:'مشخصات اشتراک معتبر نیست.'});
  await db.query('BEGIN');const plan=(await db.query<any>('SELECT * FROM subscription_plans WHERE id=$1 AND active=true',[planId])).rows[0];if(!plan){await db.query('ROLLBACK');return res.status(404).json({message:'اشتراک فعال پیدا نشد.'});}
  const user=(await db.query<any>(`SELECT subscription_used_bytes AS used_bytes,CASE WHEN subscription_expires_at>NOW()
    THEN GREATEST(subscription_quota_bytes-subscription_used_bytes,0) ELSE 0 END AS remaining_bytes
    FROM users WHERE id=$1 FOR UPDATE`,[userId])).rows[0];if(!user){await db.query('ROLLBACK');return res.status(404).json({message:'کاربر پیدا نشد.'});}
  const start=new Date();
  const duration=days??Number(plan.duration_days),bytes=(quota??Number(plan.quota_bytes))+Number(user.remaining_bytes||0);
  const sub=(await db.query<any>(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status) VALUES($1,$2,$3,$3+($4::int*INTERVAL '1 day'),$5,0,'active') RETURNING *`,[userId,planId,start,duration,bytes])).rows[0];
  await db.query(`UPDATE user_subscriptions SET status='cancelled',used_bytes=$3 WHERE user_id=$1 AND id<>$2 AND status='active'`,[userId,sub.id,user.used_bytes||0]);
  await db.query(`UPDATE users SET plan=$2,subscription_started_at=$3,subscription_expires_at=$4,subscription_quota_bytes=$5,subscription_used_bytes=0 WHERE id=$1`,[userId,plan.name,sub.started_at,sub.expires_at,bytes]);
  await db.query('COMMIT');res.status(201).json({...sub,quota_bytes:String(bytes)});
}catch(error){await db.query('ROLLBACK').catch(()=>undefined);next(error);}finally{db.release();}});

app.get('/api/chat/conversations',async(_req,res,next)=>{try{
  const result=await pool.query(`SELECT u.id AS "userId",u.name,u.username,latest.message AS "lastMessage",latest.created_at AS "lastMessageAt",
    (SELECT COUNT(*)::int FROM chat_messages unread WHERE unread.user_id=u.id AND unread.sender_role='user' AND unread.read_by_admin=FALSE) AS "unreadCount"
    FROM users u LEFT JOIN LATERAL(SELECT message,created_at FROM chat_messages m WHERE m.user_id=u.id ORDER BY m.id DESC LIMIT 1) latest ON TRUE
    WHERE latest.message IS NOT NULL
    ORDER BY latest.created_at DESC NULLS LAST,u.id DESC`);res.json(result.rows);
}catch(error){next(error);}});

app.get('/api/chat/unread-count',async(_req,res,next)=>{try{const result=await pool.query("SELECT COUNT(DISTINCT user_id)::int AS count FROM chat_messages WHERE sender_role='user' AND read_by_admin=FALSE AND user_id IS NOT NULL");res.json(result.rows[0]||{count:0});}catch(error){next(error);}});

app.get('/api/chat',async(req,res,next)=>{try{
  const userId=Number(req.query.userId);if(!Number.isSafeInteger(userId)||userId<1)return res.status(400).json({message:'کاربر گفت‌وگو را انتخاب کنید.'});
  await pool.query("UPDATE chat_messages SET read_by_admin=TRUE WHERE user_id=$1 AND sender_role='user' AND read_by_admin=FALSE",[userId]);
  const result=await pool.query(`SELECT id,user_id AS "userId",author,message AS text,created_at AS time,sender_role AS "senderRole"
    FROM chat_messages WHERE user_id=$1 ORDER BY id DESC LIMIT 200`,[userId]);res.json(result.rows.reverse());
}catch(error){next(error);}});

app.post('/api/chat',async(req,res,next)=>{try{
  const userId=Number(req.body?.userId),message=String(req.body?.message||'').trim();if(!Number.isSafeInteger(userId)||userId<1)return res.status(400).json({message:'کاربر گفت‌وگو را انتخاب کنید.'});if(!message||message.length>4000)return res.status(400).json({message:'پیام باید بین ۱ تا ۴۰۰۰ نویسه باشد.'});
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const admin=await pool.query<any>('SELECT admin_username FROM sessions WHERE token=$1 AND expires_at>NOW()',[token]);
  if(!admin.rows[0])return res.status(401).json({message:'نشست شما منقضی شده است.'});
  const result=await pool.query(`INSERT INTO chat_messages(user_id,sender_role,author,message) SELECT $1,'admin',$2,$3 WHERE EXISTS(SELECT 1 FROM users WHERE id=$1)
    RETURNING id,user_id AS "userId",author,message AS text,created_at AS time,sender_role AS "senderRole"`,[userId,admin.rows[0].admin_username,message]);
  if(!result.rows[0])return res.status(404).json({message:'کاربر پیدا نشد.'});res.status(201).json(result.rows[0]);
}catch(error){next(error);}});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('API request failed:', error);
  res.status(500).json({ message: 'خطای داخلی سرور رخ داد.' });
});

if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`FilterShekan server running on http://localhost:${port}`));
  const { runScheduled } = createTelegramChannelPublisher(pool, initializeDatabase);
  const publishDue = () => { void runScheduled().catch(() => console.error('Telegram channel schedule could not run.')); };
  publishDue();
  setInterval(publishDue, 60_000).unref();
}

export default app;
