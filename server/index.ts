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

app.get('/api/subscriptions', (_req, res) => res.json([
  { name: 'حرفه‌ای', users: 128, price: '۲۹۹٬۰۰۰', color: 'violet', change: '+۱۲٪' },
  { name: 'پایه', users: 86, price: '۱۴۹٬۰۰۰', color: 'blue', change: '+۸٪' },
  { name: 'آزمایشی', users: 34, price: 'رایگان', color: 'amber', change: '+۳٪' },
]));

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
