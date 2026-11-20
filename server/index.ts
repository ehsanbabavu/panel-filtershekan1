import express from 'express';
import bcrypt from 'bcryptjs';
import { initializeDatabase, pool } from './database.js';
import { createMobileHandler } from './mobile.js';
import { selectUsers } from './presence.js';

const app = express();
const port = Number(process.env.PORT || 3001);
export { initializeDatabase } from './database.js';

app.use(express.json());
app.all(['/api/mobile', '/api/mobile/:action'], createMobileHandler(pool, initializeDatabase));
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

app.get('/api/users', async (_req, res, next) => {
  try {
    const result = await selectUsers(pool);
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.get('/api/proxy',async(_req,res,next)=>{try{
  const result=await pool.query('SELECT host,port,username,password,updated_at AS "updatedAt" FROM proxy_settings WHERE id=1');res.json(result.rows[0]||null);
}catch(error){next(error);}});

app.put('/api/proxy',async(req,res,next)=>{try{
  const host=typeof req.body?.host==='string'?req.body.host.trim():'',port=Number(req.body?.port),username=typeof req.body?.username==='string'?req.body.username:'',password=typeof req.body?.password==='string'?req.body.password:'';
  if(!host||host.length>253||/\s/.test(host)||!Number.isInteger(port)||port<1||port>65535||username.length>255||password.length>512)return res.status(400).json({message:'آدرس، پورت یا مشخصات ورود پروکسی معتبر نیست.'});
  const result=await pool.query(`INSERT INTO proxy_settings(id,host,port,username,password) VALUES(1,$1,$2,$3,$4)
    ON CONFLICT(id) DO UPDATE SET host=EXCLUDED.host,port=EXCLUDED.port,username=EXCLUDED.username,password=EXCLUDED.password,updated_at=NOW()
    RETURNING host,port,username,password,updated_at AS "updatedAt"`,[host,port,username,password]);res.json(result.rows[0]);
}catch(error){next(error);}});

app.get('/api/subscriptions', async (_req, res, next) => {
  try { const result=await pool.query(`SELECT p.id,p.name,p.description,p.price_irr AS "priceIrr",p.quota_bytes AS "quotaBytes",
    p.duration_days AS "durationDays",p.simultaneous_devices AS "simultaneousDevices",p.features,p.active,COUNT(u.id)::int AS users
    FROM subscription_plans p LEFT JOIN users u ON u.plan=p.name GROUP BY p.id ORDER BY p.id`); res.json(result.rows); }
  catch(error){next(error);}
});

app.delete('/api/subscriptions',async(req,res,next)=>{try{
  const id=Number(req.query.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({message:'شناسه پلن معتبر نیست.'});
  const assigned=await pool.query<any>('SELECT COUNT(*)::int AS count FROM user_subscriptions WHERE plan_id=$1',[id]);
  if(Number(assigned.rows[0]?.count)>0)return res.status(409).json({message:'این پلن در سابقه اشتراک کاربران استفاده شده و قابل حذف نیست.'});
  const result=await pool.query('DELETE FROM subscription_plans WHERE id=$1 RETURNING id',[id]);
  if(!result.rows[0])return res.status(404).json({message:'پلن پیدا نشد.'});res.json({success:true,id:result.rows[0].id});
}catch(error){next(error);}});

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
  if(typeof name!=='string'||name.trim().length<2||name.trim().length>80||typeof description!=='string'||!Number.isSafeInteger(Number(priceIrr))||Number(priceIrr)<0||!Number.isSafeInteger(Number(quotaBytes))||Number(quotaBytes)<1||!Number.isInteger(Number(durationDays))||Number(durationDays)<1||!Number.isInteger(Number(simultaneousDevices))||Number(simultaneousDevices)<1||!Array.isArray(features)||features.some((v:unknown)=>typeof v!=='string')) return res.status(400).json({message:'مشخصات اشتراک معتبر نیست.'});
  const result=await pool.query(`INSERT INTO subscription_plans(name,description,price_irr,quota_bytes,duration_days,simultaneous_devices,features,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id,name,description,price_irr AS "priceIrr",quota_bytes AS "quotaBytes",duration_days AS "durationDays",simultaneous_devices AS "simultaneousDevices",features,active`,[name.trim(),description.trim(),priceIrr,quotaBytes,durationDays,simultaneousDevices,JSON.stringify(features),Boolean(active)]); res.status(201).json(result.rows[0]);
 } catch(error:any){if(error?.code==='23505')return res.status(409).json({message:'نام این اشتراک از قبل وجود دارد.'});next(error);}});

app.patch('/api/subscriptions',async(req,res,next)=>{try{
  const id=Number(req.query.id),{name,description,priceIrr,quotaBytes,durationDays,simultaneousDevices,features,active}=req.body??{};
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({message:'شناسه اشتراک معتبر نیست.'});
  const result=await pool.query(`UPDATE subscription_plans SET name=COALESCE($2,name),description=COALESCE($3,description),price_irr=COALESCE($4,price_irr),quota_bytes=COALESCE($5,quota_bytes),duration_days=COALESCE($6,duration_days),simultaneous_devices=COALESCE($7,simultaneous_devices),features=COALESCE($8,features),active=COALESCE($9,active),updated_at=NOW() WHERE id=$1 RETURNING id,name,description,price_irr AS "priceIrr",quota_bytes AS "quotaBytes",duration_days AS "durationDays",simultaneous_devices AS "simultaneousDevices",features,active`,[id,name?.trim()??null,description?.trim()??null,priceIrr??null,quotaBytes??null,durationDays??null,simultaneousDevices??null,features?JSON.stringify(features):null,active??null]);
  if(!result.rowCount)return res.status(404).json({message:'اشتراک پیدا نشد.'});res.json(result.rows[0]);
}catch(error:any){if(error?.code==='23505')return res.status(409).json({message:'نام این اشتراک از قبل وجود دارد.'});next(error);}});

app.post('/api/users',async(req,res,next)=>{try{
  const {name,username,password,plan='آزمایشی'}=req.body??{},n=String(name||'').trim(),u=String(username||'').trim().toLowerCase();
  if(n.length<2||n.length>80||!(/^[a-z0-9._+-]{3,64}$|^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(u)||typeof password!=='string'||password.length<8||password.length>128)return res.status(400).json({message:'مشخصات کاربر معتبر نیست.'});
  const result=await pool.query<any>(`INSERT INTO users(name,username,status,plan,last_seen,password_hash) VALUES($1,$2,'آفلاین',$3,'هنوز متصل نشده',$4) RETURNING id,name,username,plan`,[n,u,String(plan),await bcrypt.hash(password,10)]); const user=result.rows[0];
  const sub=await pool.query<any>(`UPDATE users SET subscription_started_at=NOW(),subscription_expires_at=NOW()+p.duration_days*INTERVAL '1 day',subscription_quota_bytes=p.quota_bytes,subscription_used_bytes=0 FROM subscription_plans p WHERE users.id=$1 AND p.name=users.plan RETURNING users.subscription_started_at AS "subscriptionStartedAt",users.subscription_expires_at AS "subscriptionExpiresAt",users.subscription_quota_bytes AS "subscriptionQuotaBytes",users.subscription_used_bytes AS "subscriptionUsedBytes"`,[user.id]);
  if(!sub.rows[0]){await pool.query('DELETE FROM users WHERE id=$1',[user.id]);return res.status(400).json({message:'پلن اشتراک پیدا نشد.'});}
  const planRow=await pool.query<any>('SELECT id FROM subscription_plans WHERE name=$1',[user.plan]);await pool.query(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status) VALUES($1,$2,$3,$4,$5,0,'active')`,[user.id,planRow.rows[0].id,sub.rows[0].subscriptionStartedAt,sub.rows[0].subscriptionExpiresAt,sub.rows[0].subscriptionQuotaBytes]);res.status(201).json({...user,status:'آفلاین',lastSeen:'هنوز متصل نشده',...sub.rows[0]});
}catch(error:any){if(error?.code==='23505')return res.status(409).json({message:'این نام کاربری از قبل ثبت شده است.'});next(error);}});

app.patch('/api/users',async(req,res,next)=>{try{
  const id=Number(req.query.id),{name,username,plan,password}=req.body??{};if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({message:'شناسه کاربر معتبر نیست.'});if(plan!==undefined){const valid=await pool.query('SELECT 1 FROM subscription_plans WHERE name=$1',[plan]);if(!valid.rowCount)return res.status(400).json({message:'پلن اشتراک پیدا نشد.'});}
  const result=await pool.query(`UPDATE users SET name=COALESCE($2,name),username=COALESCE($3,username),plan=COALESCE($4,plan),password_hash=COALESCE($5,password_hash),subscription_started_at=CASE WHEN $4 IS NULL THEN subscription_started_at ELSE NOW() END,subscription_expires_at=CASE WHEN $4 IS NULL THEN subscription_expires_at ELSE NOW()+(SELECT duration_days FROM subscription_plans WHERE name=$4)*INTERVAL '1 day' END,subscription_quota_bytes=CASE WHEN $4 IS NULL THEN subscription_quota_bytes ELSE (SELECT quota_bytes FROM subscription_plans WHERE name=$4) END,subscription_used_bytes=CASE WHEN $4 IS NULL THEN subscription_used_bytes ELSE 0 END WHERE id=$1 RETURNING id,name,username,plan,last_seen AS "lastSeen",subscription_started_at AS "subscriptionStartedAt",subscription_expires_at AS "subscriptionExpiresAt",subscription_quota_bytes AS "subscriptionQuotaBytes",subscription_used_bytes AS "subscriptionUsedBytes"`,[id,name?.trim()??null,username?.trim().toLowerCase()??null,plan??null,password?await bcrypt.hash(password,10):null]);
  if(!result.rows[0])return res.status(404).json({message:'کاربر پیدا نشد.'});if(plan){const p=await pool.query<any>('SELECT id FROM subscription_plans WHERE name=$1',[plan]);await pool.query(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status) VALUES($1,$2,$3,$4,$5,0,'active')`,[id,p.rows[0].id,result.rows[0].subscriptionStartedAt,result.rows[0].subscriptionExpiresAt,result.rows[0].subscriptionQuotaBytes]);}res.json({...result.rows[0],status:'آفلاین'});
}catch(error:any){if(error?.code==='23505')return res.status(409).json({message:'این نام کاربری از قبل وجود دارد.'});next(error);}});

app.delete('/api/users',async(req,res,next)=>{try{const id=Number(req.query.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({message:'شناسه کاربر معتبر نیست.'});const result=await pool.query('DELETE FROM users WHERE id=$1',[id]);if(!result.rowCount)return res.status(404).json({message:'کاربر پیدا نشد.'});res.json({success:true});}catch(error){next(error);}});

app.get('/api/users/:id/subscriptions',async(req,res,next)=>{try{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({message:'شناسه کاربر معتبر نیست.'});const result=await pool.query(`SELECT s.id,s.user_id AS "userId",s.plan_id AS "planId",p.name AS "planName",s.started_at AS "startedAt",s.expires_at AS "expiresAt",s.quota_bytes AS "quotaBytes",s.used_bytes AS "usedBytes",s.status FROM user_subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.user_id=$1 ORDER BY s.started_at DESC`,[id]);res.json(result.rows);}catch(error){next(error);}});

app.post('/api/users/:id/subscriptions',async(req,res,next)=>{const db=await pool.connect();try{
  const userId=Number(req.params.id),planId=Number(req.body?.planId),days=req.body?.durationDays===undefined?null:Number(req.body.durationDays),quota=req.body?.quotaBytes===undefined?null:Number(req.body.quotaBytes);
  if(!Number.isSafeInteger(userId)||userId<1||!Number.isSafeInteger(planId)||planId<1||days!==null&&(!Number.isInteger(days)||days<1||days>3650)||quota!==null&&(!Number.isSafeInteger(quota)||quota<1))return res.status(400).json({message:'مشخصات اشتراک معتبر نیست.'});
  await db.query('BEGIN');const plan=(await db.query<any>('SELECT * FROM subscription_plans WHERE id=$1 AND active=true',[planId])).rows[0];if(!plan){await db.query('ROLLBACK');return res.status(404).json({message:'اشتراک فعال پیدا نشد.'});}
  const user=(await db.query<any>('SELECT subscription_expires_at FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];if(!user){await db.query('ROLLBACK');return res.status(404).json({message:'کاربر پیدا نشد.'});}
  const start=user.subscription_expires_at&&new Date(user.subscription_expires_at).getTime()>Date.now()?user.subscription_expires_at:new Date();
  const duration=days??Number(plan.duration_days),bytes=quota??Number(plan.quota_bytes);
  const sub=(await db.query<any>(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status) VALUES($1,$2,$3,$3+($4::int*INTERVAL '1 day'),$5,0,'active') RETURNING *`,[userId,planId,start,duration,bytes])).rows[0];
  await db.query(`UPDATE user_subscriptions SET status='cancelled' WHERE user_id=$1 AND id<>$2 AND status='active'`,[userId,sub.id]);
  await db.query(`UPDATE users SET plan=$2,subscription_started_at=$3,subscription_expires_at=$4,subscription_quota_bytes=$5,subscription_used_bytes=0 WHERE id=$1`,[userId,plan.name,sub.started_at,sub.expires_at,bytes]);
  await db.query('COMMIT');res.status(201).json({...sub,quota_bytes:String(bytes)});
}catch(error){await db.query('ROLLBACK').catch(()=>undefined);next(error);}finally{db.release();}});

app.get('/api/chat', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, author, message AS text, created_at AS time
       FROM chat_messages ORDER BY created_at DESC LIMIT 100`,
    );
    res.json(result.rows.reverse());
  } catch (error) { next(error); }
});

app.post('/api/chat', async (req, res, next) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ message: 'پیام خالی است.' });
    const result = await pool.query(
      `INSERT INTO chat_messages (author, message) VALUES ('شما', $1)
       RETURNING id, author, message AS text, created_at AS time`,
      [message],
    );
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('API request failed:', error);
  res.status(500).json({ message: 'خطای داخلی سرور رخ داد.' });
});

if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`FilterShekan server running on http://localhost:${port}`));
}

export default app;
