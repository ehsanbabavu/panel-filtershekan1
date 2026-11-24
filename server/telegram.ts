import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MobileDatabase } from './presence.js';
import { createTelegramMenuReply } from './telegramMenu.js';

class TelegramError extends Error {}

function validWebhook(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      ['', '443', '80', '88', '8443'].includes(url.port) &&
      url.pathname === '/api/telegram' && url.searchParams.get('action') === 'webhook' && [...url.searchParams].length === 1;
  } catch { return false; }
}

function settingsOf(row: any) {
  return { tokenConfigured: Boolean(row.bot_token), webhookUrl: row.webhook_url,
    enabled: Boolean(row.enabled), botId: row.bot_id ? String(row.bot_id) : null,
    botUsername: row.bot_username, botName: row.bot_name, lastReceivedAt: row.last_received_at };
}

function secretMatches(expected: string, supplied: string) {
  const left = Buffer.from(expected), right = Buffer.from(supplied);
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export function createTelegramHandler(database: MobileDatabase, initialize: () => Promise<void>, telegramFetch: typeof fetch = fetch) {
  async function callTelegram(token: string, method: string, body: unknown = {}) {
    let response: Response;
    try {
      response = await telegramFetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
    } catch { throw new TelegramError('ارتباط با تلگرام برقرار نشد. دوباره تلاش کنید.'); }
    let payload: any;
    try { payload = await response.json(); } catch { throw new TelegramError('پاسخ تلگرام معتبر نیست.'); }
    if (!response.ok || !payload.ok) {
      const description = String(payload.description || 'درخواست ناموفق بود.').split(token).join('[توکن پنهان]');
      throw new TelegramError('تلگرام درخواست را نپذیرفت: ' + description.slice(0, 500));
    }
    return payload.result;
  }

  return async function handler(req: any, res: any) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    const url = new URL(req.url || '/api/telegram', 'http://localhost');
    const action = String(req.query?.action || url.searchParams.get('action') || 'settings');
    const method = String(req.method || 'GET').toUpperCase();
    const reply = (status: number, body: unknown) => res.status(status).json(body);
    try {
      await initialize();
      if (action === 'webhook') {
        if (method !== 'POST') return reply(405, { message: 'وب‌هوک فقط درخواست POST می‌پذیرد.' });
        const row = (await database.query<any>('SELECT * FROM telegram_settings WHERE id=1')).rows[0];
        const secret = String(req.headers?.['x-telegram-bot-api-secret-token'] || '');
        if (!row?.enabled || !row.bot_id || !secretMatches(row.webhook_secret, secret)) {
          return reply(401, { message: 'وب‌هوک معتبر نیست.' });
        }
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        if (!body || !Number.isSafeInteger(body.update_id) || body.update_id < 0) return reply(400, { message: 'شناسه پیام تلگرام معتبر نیست.' });
        const message = body.message || body.edited_message || body.channel_post || body.edited_channel_post;
        if (!message) return reply(200, { ok: true, ignored: true });
        if (!Number.isSafeInteger(message.message_id) || message.message_id < 1 ||
          !Number.isSafeInteger(message.chat?.id) || !Number.isSafeInteger(message.date) ||
          message.date < 1 || message.date > 8640000000000) return reply(400, { message: 'ساختار پیام تلگرام معتبر نیست.' });
        const sender = message.from || message.sender_chat || {};
        const senderName = [sender.first_name, sender.last_name].filter(value => typeof value === 'string').join(' ') || sender.title || message.chat.title || 'فرستنده نامشخص';
        const contentType = typeof message.text === 'string' ? 'text' : ['photo', 'video', 'voice', 'audio', 'document', 'sticker', 'contact', 'location', 'poll'].find(key => message[key]) || 'other';
        const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
        const menuReply = body.message ? await createTelegramMenuReply(database, message) : null;
        const inserted = await database.query(`INSERT INTO telegram_messages(bot_id,update_id,message_id,chat_id,chat_title,
          sender_name,sender_username,text,content_type,edited,sent_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11))
          ON CONFLICT(bot_id,update_id) DO NOTHING RETURNING id`,
        [row.bot_id, body.update_id, message.message_id, String(message.chat.id),
          String(message.chat.title || senderName).slice(0, 256), String(senderName).slice(0, 256),
          typeof sender.username === 'string' ? sender.username.slice(0, 64) : '', text.slice(0, 4096), contentType,
          Boolean(body.edited_message || body.edited_channel_post), message.date]);
        if (inserted.rowCount) await database.query('UPDATE telegram_settings SET last_received_at=NOW() WHERE id=1 AND bot_id=$1', [row.bot_id]);
        if (inserted.rowCount && menuReply) return reply(200, menuReply);
        return reply(200, { ok: true });
      }

      const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token || !(await database.query('SELECT 1 FROM sessions WHERE token=$1 AND expires_at>NOW()', [token])).rowCount) {
        return reply(401, { message: 'برای ادامه با حساب مدیر وارد شوید.' });
      }
      const row = (await database.query<any>('SELECT * FROM telegram_settings WHERE id=1')).rows[0];
      if (action === 'settings' && method === 'GET') return reply(200, settingsOf(row));

      if (action === 'messages' && method === 'GET') {
        const result = await database.query(`SELECT id,update_id AS "updateId",message_id AS "messageId",chat_id AS "chatId",
          chat_title AS "chatTitle",sender_name AS "senderName",sender_username AS "senderUsername",text,
          content_type AS "contentType",edited,sent_at AS "sentAt",received_at AS "receivedAt"
          FROM telegram_messages WHERE bot_id=$1 ORDER BY received_at DESC,id DESC LIMIT 100`, [row.bot_id]);
        return reply(200, result.rows);
      }

      if (action === 'status' && method === 'GET') {
        if (!row.bot_token) return reply(200, { ...settingsOf(row), connected: false, pendingUpdates: 0 });
        const info = await callTelegram(row.bot_token, 'getWebhookInfo');
        return reply(200, { ...settingsOf(row), connected: Boolean(row.enabled && info.url === row.webhook_url),
          registeredUrl: info.url || '', pendingUpdates: Number(info.pending_update_count || 0),
          lastError: String(info.last_error_message || '').split(row.bot_token).join('[توکن پنهان]').slice(0, 500),
          lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null });
      }

      if (action === 'settings' && method === 'PUT') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        if (body.botToken !== undefined && typeof body.botToken !== 'string') return reply(400, { message: 'توکن ربات معتبر نیست.' });
        const botToken = body.botToken?.trim() || row.bot_token;
        const webhookUrl = typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : '';
        if (!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(botToken) || !validWebhook(webhookUrl)) {
          return reply(400, { message: 'توکن معتبر و آدرس عمومی HTTPS با مسیر /api/telegram?action=webhook وارد کنید.' });
        }
        const client = await database.connect();
        try {
          await client.query('BEGIN');
          const current = (await client.query<any>('SELECT * FROM telegram_settings WHERE id=1 FOR UPDATE')).rows[0];
          if (current.enabled && (botToken !== current.bot_token || webhookUrl !== current.webhook_url)) {
            await client.query('ROLLBACK');
            return reply(409, { message: 'برای تغییر توکن یا آدرس، ابتدا اتصال فعلی را قطع کنید.' });
          }
          const updated = (await client.query<any>(`UPDATE telegram_settings SET bot_token=$1,webhook_url=$2,
            bot_id=CASE WHEN bot_token=$1 THEN bot_id ELSE NULL END,
            bot_username=CASE WHEN bot_token=$1 THEN bot_username ELSE '' END,
            bot_name=CASE WHEN bot_token=$1 THEN bot_name ELSE '' END,
            last_received_at=CASE WHEN bot_token=$1 THEN last_received_at ELSE NULL END,updated_at=NOW()
            WHERE id=1 RETURNING *`, [botToken, webhookUrl])).rows[0];
          await client.query('COMMIT');
          return reply(200, settingsOf(updated));
        } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
      }

      if (['connect', 'disconnect'].includes(action) && method === 'POST') {
        const client = await database.connect();
        try {
          await client.query('BEGIN');
          const current = (await client.query<any>('SELECT * FROM telegram_settings WHERE id=1 FOR UPDATE')).rows[0];
          if (!current.bot_token || !validWebhook(current.webhook_url)) {
            await client.query('ROLLBACK'); return reply(400, { message: 'ابتدا توکن و آدرس وب‌هوک را ذخیره کنید.' });
          }
          if (action === 'disconnect') {
            await callTelegram(current.bot_token, 'deleteWebhook', { drop_pending_updates: false });
            const updated = (await client.query<any>('UPDATE telegram_settings SET enabled=FALSE,updated_at=NOW() WHERE id=1 RETURNING *')).rows[0];
            await client.query('COMMIT'); return reply(200, settingsOf(updated));
          }
          const bot = await callTelegram(current.bot_token, 'getMe');
          if (!bot.is_bot || !Number.isSafeInteger(bot.id)) throw new TelegramError('مشخصات ربات تلگرام معتبر نیست.');
          const secret = randomBytes(32).toString('hex');
          await callTelegram(current.bot_token, 'setWebhook', {
            url: current.webhook_url, secret_token: secret,
            allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'], drop_pending_updates: false,
          });
          const updated = (await client.query<any>(`UPDATE telegram_settings SET enabled=TRUE,bot_id=$1,bot_username=$2,
            bot_name=$3,webhook_secret=$4,updated_at=NOW() WHERE id=1 RETURNING *`,
          [bot.id, String(bot.username || ''), String(bot.first_name || ''), secret])).rows[0];
          await client.query('COMMIT'); return reply(200, settingsOf(updated));
        } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
      }
      return reply(405, { message: 'عملیات یا روش درخواست پشتیبانی نمی‌شود.' });
    } catch (error) {
      if (error instanceof TelegramError) return reply(502, { message: error.message });
      if (error instanceof SyntaxError) return reply(400, { message: 'بدنه درخواست معتبر نیست.' });
      return reply(503, { message: 'دریافت یا ذخیره اطلاعات تلگرام انجام نشد. دوباره تلاش کنید.' });
    }
  };
}
