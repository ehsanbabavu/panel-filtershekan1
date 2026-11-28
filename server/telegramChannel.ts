import { timingSafeEqual } from 'node:crypto';
import type { MobileDatabase } from './presence.js';
import { createTelegramClient, TelegramError } from './telegramApi.js';
import { channelMessage, ChannelError, generateChannelMessage } from './telegramChannelContent.js';
import { findChannelNews } from './telegramChannelNews.js';

type Channel = {
  channelId: string; channelTitle: string; channelUsername: string; botId: string | null;
  model: string; automatic: boolean; revision: number;
};
type Bot = { id: string | null; token: string; username: string };
type Delivery = {
  id: string; channelId: string; channelTitle: string; mode: 'manual' | 'automatic';
  status: 'pending' | 'sent' | 'failed' | 'uncertain'; text: string; error: string; messageId: string | null; createdAt: string;
};

const channelColumns = `channel_id AS "channelId",channel_title AS "channelTitle",channel_username AS "channelUsername",
  bot_id::text AS "botId",model,automatic,revision`;
const historyColumns = `id,channel_id AS "channelId",channel_title AS "channelTitle",mode,
  CASE WHEN status='pending' AND created_at < NOW()-INTERVAL '2 minutes' THEN 'uncertain' ELSE status END AS status,
  text,error,message_id::text AS "messageId",created_at AS "createdAt"`;

export const telegramChannelSchema = `
  CREATE TABLE IF NOT EXISTS telegram_channel_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), channel_id TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '', channel_username TEXT NOT NULL DEFAULT '',
    bot_id BIGINT,
    model TEXT NOT NULL DEFAULT '', automatic BOOLEAN NOT NULL DEFAULT FALSE,
    revision INTEGER NOT NULL DEFAULT 0
  );
  ALTER TABLE telegram_channel_settings ADD COLUMN IF NOT EXISTS avalai_api_key TEXT NOT NULL DEFAULT '';
  INSERT INTO telegram_channel_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS telegram_channel_deliveries (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_title TEXT NOT NULL, mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', text TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
    message_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE telegram_channel_deliveries ADD COLUMN IF NOT EXISTS source_url TEXT;
  CREATE INDEX IF NOT EXISTS telegram_channel_deliveries_created_idx ON telegram_channel_deliveries(created_at DESC);
  CREATE TABLE IF NOT EXISTS telegram_channel_requests (id TEXT PRIMARY KEY);
`;

function modelName(value: unknown) {
  if (typeof value !== 'string' || !/^[\w./:-]{1,100}$/.test(value.trim())) {
    throw new ChannelError(400, 'نام مدل متنی AvalAI را وارد کنید.');
  }
  return value.trim();
}

function channelTarget(value: unknown) {
  if (typeof value !== 'string') throw new ChannelError(400, 'نام کاربری یا شناسهٔ کانال را وارد کنید.');
  const target = value.trim().replace(/^https:\/\/t\.me\/(\w+)\/?$/i, '@$1');
  if (/^@[a-zA-Z0-9_]{5,32}$/.test(target)) return target;
  if (/^-100\d{1,13}$/.test(target) && Number.isSafeInteger(Number(target))) return target;
  throw new ChannelError(400, 'کانال را با نام کاربری، پیوند عمومی t.me یا شناسهٔ عددی ‎-100… وارد کنید.');
}

function cronAuthorized(header: unknown, secret: string | undefined) {
  if (!secret || typeof header !== 'string') return false;
  const supplied = Buffer.from(header), expected = Buffer.from('Bearer ' + secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createTelegramChannelPublisher(database: MobileDatabase, initialize: () => Promise<void>, {
  telegramFetch = fetch, aiFetch = fetch, newsFetch = fetch, chooseNewsCategory = undefined as (() => number) | undefined,
  env = process.env, now = () => new Date(),
} = {}) {
  const callTelegram = createTelegramClient(telegramFetch);
  const readChannel = async () => (await database.query<Channel>(
    `SELECT ${channelColumns} FROM telegram_channel_settings WHERE id=1`)).rows[0];
  const readBot = async () => (await database.query<Bot>(
    'SELECT bot_id::text AS id,bot_token AS token,bot_username AS username FROM telegram_settings WHERE id=1')).rows[0];
  const readDelivery = async (id: string) => (await database.query<Delivery>(
    `SELECT ${historyColumns} FROM telegram_channel_deliveries WHERE id=$1`, [id])).rows[0];
  const environmentKey = () => env.AVALAI_API_KEY?.trim() || '';

  async function readAiSettings() {
    const result = await database.query<{ saved: boolean }>(
      "SELECT avalai_api_key <> '' AS saved FROM telegram_channel_settings WHERE id=1");
    const saved = Boolean(result.rows[0]?.saved);
    return { saved, configured: saved || Boolean(environmentKey()) };
  }

  async function saveAiSettings(body: { apiKey?: unknown } | undefined) {
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!/^[\x21-\x7e]{1,512}$/.test(apiKey)) {
      throw new ChannelError(400, 'کلید AvalAI را بدون فاصله یا سطر جدید وارد کنید.');
    }
    const saved = await database.query('UPDATE telegram_channel_settings SET avalai_api_key=$1 WHERE id=1', [apiKey]);
    if (!saved.rowCount) throw new ChannelError(503, 'ذخیرهٔ کلید AvalAI انجام نشد.');
    return { saved: true, configured: true };
  }

  async function generate(model: string, channelId: string) {
    const result = await database.query<{ avalai_api_key: string }>(
      'SELECT avalai_api_key FROM telegram_channel_settings WHERE id=1');
    const apiKey = result.rows[0]?.avalai_api_key || environmentKey();
    if (!apiKey) throw new ChannelError(409, 'کلید AvalAI را از بخش «تلگرام ← تنظیمات» ثبت کنید.');
    const recent = await database.query<{ source_url: string }>(`SELECT source_url FROM telegram_channel_deliveries
      WHERE channel_id=$1 AND source_url IS NOT NULL AND status IN ('sent','uncertain')
      AND created_at >= NOW()-INTERVAL '7 days'`, [channelId]);
    const news = await findChannelNews(newsFetch, now(), new Set(recent.rows.map(row => row.source_url)), chooseNewsCategory);
    const text = await generateChannelMessage({ model, ...news }, { apiKey, baseUrl: env.AVALAI_BASE_URL }, aiFetch);
    return { text, sourceUrl: news.sourceUrl };
  }

  const assertBot = (bot: Bot) => {
    if (!bot?.token || !bot.id) throw new ChannelError(409, 'ابتدا ربات را در بخش «اتصال ربات» متصل کنید.');
  };

  async function verifyChannel(bot: Bot, target: string) {
    assertBot(bot);
    const chat = await callTelegram(bot.token, 'getChat', { chat_id: target });
    if (chat?.type !== 'channel' || !Number.isSafeInteger(chat.id) || chat.id >= 0) {
      throw new ChannelError(400, 'مقصد انتخاب‌شده باید یک کانال تلگرام باشد.');
    }
    const member = await callTelegram(bot.token, 'getChatMember', { chat_id: chat.id, user_id: Number(bot.id) });
    if (member?.status !== 'administrator' || member.can_post_messages !== true) {
      throw new ChannelError(409, 'ربات را مدیر کانال کنید و مجوز ارسال پیام را بدهید.');
    }
    return { id: String(chat.id), title: String(chat.title || '').slice(0, 255),
      username: typeof chat.username === 'string' && /^\w{5,32}$/.test(chat.username) ? chat.username : '' };
  }

  const readHistory = () => database.query<Delivery>(
    `SELECT ${historyColumns} FROM telegram_channel_deliveries ORDER BY created_at DESC,id DESC LIMIT 30`);

  async function snapshot() {
    const [channel, bot, ai, history] = await Promise.all([readChannel(), readBot(), readAiSettings(), readHistory()]);
    return { channel, botUsername: bot.username, channelReady: Boolean(channel.channelId && bot.token && bot.id === channel.botId),
      aiConfigured: ai.configured, schedulerConfigured: env.VERCEL ? Boolean(env.CRON_SECRET) : true, history: history.rows };
  }

  async function save(body: any, channel: Channel, bot: Bot) {
    const target = channelTarget(body?.target);
    const model = body?.model === '' ? '' : modelName(body?.model);
    const automatic = body?.automatic;
    if (typeof automatic !== 'boolean') throw new ChannelError(400, 'وضعیت انتشار خودکار معتبر نیست.');
    if (body?.revision !== channel.revision) throw new ChannelError(409, 'تنظیمات تغییر کرده است. صفحه را تازه کنید.');
    if (automatic && (!model || (env.VERCEL && !env.CRON_SECRET) || !(await readAiSettings()).configured)) {
      throw new ChannelError(409, 'برای انتشار خودکار، مدل AvalAI و تنظیمات زمان‌بندی و کلید سرور لازم است.');
    }
    // Saved numeric IDs identify the same channel even if its public username changes.
    const keepChannel = target === channel.channelId && !automatic && (bot.id === channel.botId || channel.automatic);
    const verified = keepChannel
      ? { id: channel.channelId, title: channel.channelTitle, username: channel.channelUsername }
      : await verifyChannel(bot, target);
    const updated = await database.query(`UPDATE telegram_channel_settings
      SET channel_id=$1,channel_title=$2,channel_username=$3,bot_id=$4,model=$5,automatic=$6,revision=revision+1
      WHERE id=1 AND revision=$7 AND ($9 OR EXISTS (SELECT 1 FROM telegram_settings WHERE id=1 AND bot_id=$4 AND bot_token=$8))`,
    [verified.id, verified.title, verified.username, keepChannel ? channel.botId : bot.id,
      model, automatic, channel.revision, bot.token, keepChannel]);
    if (!updated.rowCount) throw new ChannelError(409, 'تنظیمات کانال یا ربات تغییر کرده است. صفحه را تازه کنید.');
    return snapshot();
  }

  async function deleteDelivery(id: unknown) {
    if (typeof id !== 'string' || !/^(?:daily:\d{4}-\d{2}-\d{2}|manual:[a-f0-9-]{36})$/.test(id)) {
      throw new ChannelError(400, 'شناسهٔ پیام تاریخچه معتبر نیست.');
    }
    // Keep only the request ID, so deleting history cannot replay a previous send.
    const deleted = await database.query(`WITH removed AS (
      DELETE FROM telegram_channel_deliveries WHERE id=$1 AND (status<>'pending' OR created_at < NOW()-INTERVAL '2 minutes')
      RETURNING id
    ), remembered AS (
      INSERT INTO telegram_channel_requests(id) SELECT id FROM removed ON CONFLICT DO NOTHING
    ) SELECT id FROM removed`, [id]);
    if (!deleted.rowCount && await readDelivery(id)) {
      throw new ChannelError(409, 'پیام در حال ارسال است. بعد از مشخص شدن نتیجه دوباره تلاش کنید.');
    }
    return { history: (await readHistory()).rows };
  }

  async function send(id: string, channel: Channel, bot: Bot, manualText?: string) {
    const mode = manualText === undefined ? 'automatic' : 'manual';
    const claimed = await database.query(`WITH destination AS (
      SELECT c.channel_id,c.channel_title FROM telegram_channel_settings c
      JOIN telegram_settings b ON b.id=1 AND c.bot_id=b.bot_id AND b.bot_token=$4
      WHERE c.id=1 AND c.revision=$5 AND ($2='manual' OR c.automatic)
      AND NOT EXISTS (SELECT 1 FROM telegram_channel_deliveries WHERE id=$1)
    ), claimed AS (
      INSERT INTO telegram_channel_requests(id) SELECT $1 FROM destination ON CONFLICT DO NOTHING RETURNING id
    )
    INSERT INTO telegram_channel_deliveries(id,channel_id,channel_title,mode,text)
      SELECT claimed.id,destination.channel_id,destination.channel_title,$2,$3 FROM claimed CROSS JOIN destination
      RETURNING id`, [id, mode, manualText ?? '', bot.token, channel.revision]);
    if (!claimed.rowCount) {
      const existing = await readDelivery(id);
      if (mode === 'automatic') return null;
      if (existing?.channelId === channel.channelId && existing.text === manualText) return existing;
      throw new ChannelError(409, 'تنظیمات کانال تغییر کرده یا این درخواست قبلاً ثبت شده است. صفحه را تازه کنید.');
    }

    let sending = false;
    try {
      let text = manualText;
      let sourceUrl: string | null = null;
      if (text === undefined) {
        const news = await generate(channel.model, channel.channelId);
        text = news.text;
        sourceUrl = news.sourceUrl;
      }
      const current = await database.query(`UPDATE telegram_channel_deliveries SET text=$2,source_url=$6 WHERE id=$1
        AND EXISTS (SELECT 1 FROM telegram_channel_settings c JOIN telegram_settings b ON b.id=1
          AND c.bot_id=b.bot_id AND b.bot_token=$3 WHERE c.id=1 AND c.revision=$4 AND ($5='manual' OR c.automatic))`,
      [id, text, bot.token, channel.revision, mode, sourceUrl]);
      if (!current.rowCount) throw new ChannelError(409, 'تنظیمات کانال یا ربات هنگام آماده‌سازی پیام تغییر کرد.');
      sending = true;
      const sent = await callTelegram(bot.token, 'sendMessage', { chat_id: channel.channelId, text,
        link_preview_options: { is_disabled: true } });
      if (!Number.isSafeInteger(sent?.message_id) || sent.message_id < 1) {
        throw new TelegramError('شناسهٔ پیام از تلگرام دریافت نشد.', true);
      }
      await database.query(`UPDATE telegram_channel_deliveries SET status='sent',message_id=$2 WHERE id=$1`, [id, sent.message_id]);
    } catch (error) {
      const uncertain = sending && (!(error instanceof TelegramError) || error.deliveryUncertain);
      const message = error instanceof ChannelError || error instanceof TelegramError ? error.message : 'ثبت نتیجهٔ انتشار انجام نشد.';
      await database.query(`UPDATE telegram_channel_deliveries SET status=$2,error=$3 WHERE id=$1 AND status='pending'`,
        [id, uncertain ? 'uncertain' : 'failed', message]).catch(() => undefined);
    }
    return readDelivery(id);
  }

  async function runScheduled(waitForLocalTime = true) {
    await initialize();
    const due = await database.query<{ day: string }>(`SELECT to_char(tehran, 'YYYY-MM-DD') AS day
      FROM (SELECT $1::timestamptz AT TIME ZONE 'Asia/Tehran' AS tehran) clock
      WHERE NOT $2::boolean OR tehran::time >= TIME '20:00'`, [now(), waitForLocalTime]);
    if (!due.rows[0]) return { status: 'not-due' };
    const channel = await readChannel();
    if (!channel.automatic) return { status: 'disabled' };
    const bot = await readBot();
    if (!bot.token || !bot.id || bot.id !== channel.botId) return { status: 'channel-disconnected' };
    const result = await send('daily:' + due.rows[0].day, channel, bot);
    return { status: result?.status ?? 'already-processed' };
  }

  async function handle(req: any, res: any) {
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url || '/api/telegram-channel', 'http://localhost');
    const action = url.pathname === '/api/telegram/channel/scheduled' ? 'scheduled'
      : String(req.query?.action || url.searchParams.get('action') || '').replace(/^channel-/, '');
    const method = String(req.method || 'GET').toUpperCase();
    const reply = (status: number, body: unknown) => res.status(status).json(body);
    try {
      if (action === 'scheduled') {
        if (method !== 'GET') return reply(405, { message: 'روش درخواست معتبر نیست.' });
        if (!cronAuthorized(req.headers?.authorization, env.CRON_SECRET)) return reply(401, { message: 'دسترسی زمان‌بندی معتبر نیست.' });
        // Vercel supplies the trigger time, which can vary within the scheduled hour.
        const result = await runScheduled(false);
        return reply(result.status === 'failed' || result.status === 'uncertain' ? 502 : 200, result);
      }

      const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return reply(401, { message: 'برای ادامه با حساب مدیر وارد شوید.' });
      await initialize();
      if (!(await database.query('SELECT 1 FROM sessions WHERE token=$1 AND expires_at>NOW()', [token])).rowCount) {
        return reply(401, { message: 'نشست شما منقضی شده است؛ دوباره وارد شوید.' });
      }

      if (action === 'settings' && method === 'GET') return reply(200, await snapshot());
      if (action === 'ai-settings' && method === 'GET') return reply(200, await readAiSettings());
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (action === 'ai-settings' && method === 'PUT') return reply(200, await saveAiSettings(body));
      if (action === 'history' && method === 'DELETE') return reply(200, await deleteDelivery(body?.id));
      if (action === 'preview' && method === 'POST') {
        const model = modelName(body?.model);
        const channel = await readChannel();
        const { text } = await generate(model, channel.channelId);
        return reply(200, { text });
      }

      const [channel, bot] = await Promise.all([readChannel(), readBot()]);
      if (action === 'settings' && method === 'PUT') return reply(200, await save(body, channel, bot));
      if (action === 'send' && method === 'POST') {
        const text = channelMessage(body?.text, 4096, 'پیام');
        if (typeof body?.requestId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(body.requestId)) {
          throw new ChannelError(400, 'شناسهٔ درخواست انتشار معتبر نیست.');
        }
        if (body?.revision !== channel.revision) throw new ChannelError(409, 'تنظیمات کانال تغییر کرده است. صفحه را تازه کنید.');
        if (!channel.channelId || channel.botId !== bot.id) throw new ChannelError(409, 'کانال را برای ربات فعلی ذخیره کنید.');
        assertBot(bot);
        return reply(200, { delivery: await send('manual:' + body.requestId.toLowerCase(), channel, bot, text) });
      }

      if (action === 'verify' && method === 'POST') {
        if (!channel.channelId || channel.botId !== bot.id) throw new ChannelError(409, 'کانال را برای ربات فعلی ذخیره کنید.');
        const result = await verifyChannel(bot, channel.channelId);
        return reply(200, { title: result.title });
      }
      return reply(405, { message: 'عملیات یا روش درخواست پشتیبانی نمی‌شود.' });
    } catch (error) {
      if (error instanceof ChannelError) return reply(error.status, { message: error.message });
      if (error instanceof TelegramError) return reply(502, { message: error.message });
      if (error instanceof SyntaxError) return reply(400, { message: 'بدنهٔ درخواست معتبر نیست.' });
      return reply(503, { message: 'عملیات کانال تلگرام انجام نشد.' });
    }
  }

  return { handle, runScheduled };
}
