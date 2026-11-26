import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MobileDatabase } from './presence.js';
import { createTelegramMenuReply } from './telegramMenu.js';

class TelegramError extends Error {}

function chatIdOf(value: unknown) {
  const id = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return /^-?[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)) ? id : '';
}

const botChanged = 'ربات این گفت‌وگو تغییر کرده است. فهرست را به‌روز کنید.';
const connectBot = 'برای ارسال پیام، ربات تلگرام را از بخش «اتصال ربات» وصل کنید.';

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
        const senderName = String([sender.first_name, sender.last_name].filter(value => typeof value === 'string').join(' ') ||
          sender.title || message.chat.title || 'فرستنده نامشخص').slice(0, 256);
        const senderUsername = typeof sender.username === 'string' ? sender.username.slice(0, 64) : '';
        const chatTitle = String(message.chat.title || senderName).slice(0, 256);
        const chatId = String(message.chat.id);
        const edited = Boolean(body.edited_message || body.edited_channel_post);
        const contentType = typeof message.text === 'string' ? 'text' : ['photo', 'video', 'voice', 'audio', 'document', 'sticker', 'contact', 'location', 'poll'].find(key => message[key]) || 'other';
        const text = (typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '').slice(0, 4096);
        const client = await database.connect();
        try {
          await client.query('BEGIN');
          const inserted = await client.query(`INSERT INTO telegram_messages(bot_id,update_id,message_id,chat_id,chat_title,
            sender_name,sender_username,text,content_type,edited,sent_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11))
            ON CONFLICT(bot_id,update_id) DO NOTHING RETURNING id`,
          [row.bot_id, body.update_id, message.message_id, chatId, chatTitle, senderName, senderUsername, text, contentType, edited, message.date]);
          if (inserted.rowCount) {
            await client.query(`INSERT INTO telegram_chat_messages AS current
              (bot_id,chat_id,message_id,chat_title,sender_name,sender_username,text,direction,sent_at,content_type,edited,update_id)
              VALUES($1,$2,$3,$4,$5,$6,$7,'incoming',to_timestamp($8),$9,$10,$11)
              ON CONFLICT(bot_id,chat_id,message_id) DO UPDATE SET
                chat_title=EXCLUDED.chat_title,sender_name=EXCLUDED.sender_name,sender_username=EXCLUDED.sender_username,
                text=EXCLUDED.text,content_type=EXCLUDED.content_type,edited=EXCLUDED.edited,update_id=EXCLUDED.update_id
              WHERE current.direction='incoming' AND current.deleted_at IS NULL AND
                (current.update_id IS NULL OR EXCLUDED.edited > current.edited OR
                  (EXCLUDED.edited=current.edited AND EXCLUDED.update_id > current.update_id))`,
            [row.bot_id, chatId, message.message_id, chatTitle, senderName, senderUsername, text, message.date, contentType, edited, body.update_id]);
            await client.query('UPDATE telegram_settings SET last_received_at=NOW() WHERE id=1 AND bot_id=$1', [row.bot_id]);
          }
          const menuReply = inserted.rowCount && body.message ? await createTelegramMenuReply(client, message, row.bot_id, body.update_id) : null;
          await client.query('COMMIT');
          if (inserted.rowCount && menuReply) return reply(200, menuReply);
          return reply(200, { ok: true });
        } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
      }

      const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token || !(await database.query('SELECT 1 FROM sessions WHERE token=$1 AND expires_at>NOW()', [token])).rowCount) {
        return reply(401, { message: 'برای ادامه با حساب مدیر وارد شوید.' });
      }
      const row = (await database.query<any>('SELECT * FROM telegram_settings WHERE id=1')).rows[0];
      if (action === 'settings' && method === 'GET') return reply(200, settingsOf(row));

      if (action === 'messages' && method === 'GET') {
        const result = await database.query(`SELECT m.id,m.update_id AS "updateId",m.message_id AS "messageId",m.chat_id AS "chatId",
          m.chat_title AS "chatTitle",m.sender_name AS "senderName",m.sender_username AS "senderUsername",
          CASE WHEN c.deleted_at IS NULL THEN m.text ELSE '' END AS text,
          CASE WHEN c.deleted_at IS NULL THEN m.content_type ELSE 'other' END AS "contentType",
          m.edited,m.sent_at AS "sentAt",m.received_at AS "receivedAt"
          FROM telegram_messages m LEFT JOIN telegram_chat_messages c
            ON (c.bot_id,c.chat_id,c.message_id)=(m.bot_id,m.chat_id,m.message_id)
          WHERE m.bot_id=$1 ORDER BY m.received_at DESC,m.id DESC LIMIT 100`, [row.bot_id]);
        return reply(200, result.rows);
      }

      if (action === 'chats' && method === 'GET') {
        const result = await database.query(`SELECT "chatId",title,username,"lastMessage","lastContentType","lastDeleted" FROM (
          SELECT DISTINCT ON(chat_id) chat_id AS "chatId",chat_title AS title,sender_username AS username,
            text AS "lastMessage",content_type AS "lastContentType",(deleted_at IS NOT NULL) AS "lastDeleted",
            sent_at,message_id
          FROM telegram_chat_messages WHERE bot_id=$1 ORDER BY chat_id,sent_at DESC,message_id DESC
        ) chats ORDER BY sent_at DESC,message_id DESC,"chatId"`, [row.bot_id]);
        return reply(200, { botId: row.bot_id ? String(row.bot_id) : null, connected: Boolean(row.enabled), chats: result.rows });
      }

      if (action === 'chat' && method === 'GET') {
        const chatId = chatIdOf(req.query?.chatId ?? url.searchParams.get('chatId'));
        const botId = req.query?.botId ?? url.searchParams.get('botId');
        if (!chatId) return reply(400, { message: 'گفت‌وگوی تلگرام معتبر نیست.' });
        if (!row.bot_id || botId !== String(row.bot_id)) return reply(409, { message: botChanged });
        const result = await database.query(`SELECT chat_id AS "chatId",message_id::text AS "messageId",
          sender_name AS "senderName",text,direction,sent_at AS "sentAt",content_type AS "contentType",
          (deleted_at IS NOT NULL) AS deleted FROM telegram_chat_messages WHERE bot_id=$1 AND chat_id=$2
          ORDER BY sent_at DESC,message_id DESC LIMIT 300`, [row.bot_id, chatId]);
        return reply(200, result.rows.reverse());
      }

      if (action === 'send' && method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const chatId = chatIdOf(body?.chatId);
        const text = typeof body?.message === 'string' ? body.message.trim() : '';
        if (!row.enabled || !row.bot_token || !row.bot_id) return reply(409, { message: connectBot });
        if (body?.botId !== String(row.bot_id)) return reply(409, { message: botChanged });
        if (!chatId || chatId.startsWith('-')) return reply(400, { message: 'یک گفت‌وگوی خصوصی تلگرام انتخاب کنید.' });
        if (!text || text.length > 4096) return reply(400, { message: 'پیام باید بین ۱ تا ۴۰۹۶ نویسه باشد.' });
        if (text.includes('\0')) return reply(400, { message: 'متن پیام معتبر نیست.' });
        const chat = (await database.query<{ chat_title: string; sender_username: string }>(`SELECT chat_title,sender_username
          FROM telegram_chat_messages WHERE bot_id=$1 AND chat_id=$2 AND direction='incoming'
          ORDER BY sent_at DESC,message_id DESC LIMIT 1`, [row.bot_id, chatId])).rows[0];
        if (!chat) return reply(404, { message: 'این کاربر هنوز به ربات پیام نداده است.' });

        const sent = await callTelegram(row.bot_token, 'sendMessage', { chat_id: chatId, text });
        if (!Number.isSafeInteger(sent?.message_id) || sent.message_id < 1 || !Number.isSafeInteger(sent.date) ||
          sent.date < 1 || sent.date > 8640000000000) throw new TelegramError('مشخصات پیام ارسالی از تلگرام دریافت نشد.');
        const message = { chatId, messageId: String(sent.message_id), senderName: 'پشتیبانی', text,
          direction: 'outgoing', sentAt: new Date(sent.date * 1000).toISOString(), contentType: 'text', deleted: false };
        try {
          await database.query(`INSERT INTO telegram_chat_messages
            (bot_id,chat_id,message_id,chat_title,sender_name,sender_username,text,direction,sent_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,'outgoing',to_timestamp($8))
            ON CONFLICT(bot_id,chat_id,message_id) DO NOTHING`,
          [row.bot_id, chatId, sent.message_id, chat.chat_title, message.senderName, chat.sender_username, text, sent.date]);
        } catch {
          return reply(202, { ...message, notice: 'پیام در تلگرام ارسال شد. ثبت پیام در تاریخچه انجام نشد.' });
        }
        return reply(201, message);
      }

      if (action === 'delete-message' && method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const chatId = chatIdOf(body?.chatId);
        const messageId = chatIdOf(body?.messageId);
        if (!row.bot_id || body?.botId !== String(row.bot_id)) return reply(409, { message: botChanged });
        if (!row.enabled || !row.bot_token) return reply(409, { message: 'ابتدا ربات تلگرام را وصل کنید.' });
        if (!chatId || !messageId || messageId.startsWith('-')) return reply(400, { message: 'شناسهٔ پیام معتبر نیست.' });
        const params = [row.bot_id, chatId, messageId];
        const client = await database.connect();
        try {
          await client.query('BEGIN');
          const existing = (await client.query<{ direction: string; deleted_at: Date | null }>(`SELECT direction,deleted_at
            FROM telegram_chat_messages WHERE bot_id=$1 AND chat_id=$2 AND message_id=$3 FOR UPDATE`, params)).rows[0];
          if (!existing || existing.direction !== 'incoming') {
            await client.query('ROLLBACK');
            return reply(404, { message: 'پیام دریافتی پیدا نشد.' });
          }
          if (!existing.deleted_at) {
            await callTelegram(row.bot_token, 'deleteMessage', { chat_id: chatId, message_id: Number(messageId) });
            await client.query(`UPDATE telegram_chat_messages SET deleted_at=NOW(),text=''
              WHERE bot_id=$1 AND chat_id=$2 AND message_id=$3`, params);
            await client.query(`UPDATE telegram_messages SET text='',content_type='other'
              WHERE bot_id=$1 AND chat_id=$2 AND message_id=$3`, params);
          }
          await client.query('COMMIT');
          return reply(200, { deleted: true });
        } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
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
