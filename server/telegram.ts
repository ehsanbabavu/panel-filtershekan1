import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MobileDatabase } from './presence.js';
import { telegramIdentity } from './telegramLink.js';
import { createTelegramMenuReply, telegramMenuAction } from './telegramMenu.js';
import { createTelegramClient, TelegramError } from './telegramApi.js';
import { createTelegramChannelPublisher } from './telegramChannel.js';
import { handleTelegramApk } from './telegramApk.js';

function chatIdOf(value: unknown) {
  const id = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return /^-?[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)) ? id : '';
}

const botChanged = 'ربات این گفت‌وگو تغییر کرده است. فهرست را به‌روز کنید.';
const connectBot = 'برای ارسال پیام، ربات تلگرام را از بخش «اتصال ربات» وصل کنید.';
const telegramMedia = ['photo', 'video', 'voice', 'audio', 'document', 'sticker', 'contact', 'location', 'poll',
  'animation', 'video_note', 'dice', 'venue', 'game', 'story', 'paid_media', 'checklist'];

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
  const callTelegram = createTelegramClient(telegramFetch);
  const channel = createTelegramChannelPublisher(database, initialize, { telegramFetch });

  return async function handler(req: any, res: any) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    const url = new URL(req.url || '/api/telegram', 'http://localhost');
    const action = String(req.query?.action || url.searchParams.get('action') || 'settings');
    if (action.startsWith('channel-') || url.pathname === '/api/telegram/channel/scheduled') return channel.handle(req, res);
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
        const identity = telegramIdentity(message);
        if (!identity) return reply(200, { ok: true });
        const chatId = identity.id;
        const edited = Boolean(body.edited_message);
        const menu = body.message ? telegramMenuAction(message.text) : null;
        const senderName = identity.name || 'فرستنده نامشخص';
        const media = telegramMedia.find(key => message[key]);
        const hasText = typeof message.text === 'string';
        if (!hasText && !media && typeof message.caption !== 'string') return reply(200, { ok: true });
        const contentType = hasText ? 'text' : media || 'other';
        const text = (typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '').slice(0, 4096);
        const messageKey = [row.bot_id, chatId, message.message_id];
        const client = await database.connect();
        try {
          await client.query('BEGIN');
          // Serialize menu changes and message admission with other updates for this bot.
          const connected = await client.query(`SELECT id FROM telegram_settings
            WHERE id=1 AND enabled AND bot_id=$1 AND webhook_secret=$2 FOR UPDATE`, [row.bot_id, row.webhook_secret]);
          if (!connected.rowCount) {
            await client.query('ROLLBACK');
            return reply(401, { message: 'وب‌هوک معتبر نیست.' });
          }
          const receipt = await client.query(`INSERT INTO telegram_webhook_updates(bot_id,update_id,chat_id,menu_message_id,opens_support)
            SELECT $1,$2,$3,$4,$5
            WHERE NOT EXISTS (SELECT 1 FROM telegram_messages WHERE bot_id=$1 AND update_id=$2)
            ON CONFLICT(bot_id,update_id) DO NOTHING RETURNING 1`,
          [row.bot_id, body.update_id, menu ? chatId : null, menu ? message.message_id : null, menu ? menu === 'support' : null]);
          if (!receipt.rowCount) {
            await client.query('COMMIT');
            return reply(200, { ok: true });
          }

          let inSupport = false;
          if (menu && menu !== 'support') {
            // If a menu choice arrived late, hide messages from the interval it closed.
            await client.query(`UPDATE telegram_chat_messages c SET is_support=FALSE
              WHERE c.bot_id=$1 AND c.chat_id=$2 AND c.message_id>$3 AND c.direction='incoming' AND c.is_support
                AND NOT EXISTS (SELECT 1 FROM telegram_webhook_updates u
                  WHERE u.bot_id=c.bot_id AND u.chat_id=c.chat_id AND u.menu_message_id>$3 AND u.menu_message_id<=c.message_id)`,
            messageKey);
          } else if (edited) {
            const original = await client.query(`SELECT 1 FROM telegram_chat_messages
              WHERE bot_id=$1 AND chat_id=$2 AND message_id=$3 AND direction='incoming' AND is_support AND deleted_at IS NULL FOR UPDATE`,
            messageKey);
            inSupport = Boolean(original.rowCount);
          } else if (!menu) {
            const entry = (await client.query<{ opens_support: boolean; menu_message_id: string | number }>(`
              SELECT opens_support,menu_message_id FROM telegram_webhook_updates
              WHERE bot_id=$1 AND chat_id=$2 AND menu_message_id<=$3
              ORDER BY menu_message_id DESC LIMIT 1`, messageKey)).rows[0];
            inSupport = Boolean(entry?.opens_support && Number(entry.menu_message_id) < message.message_id);
          }

          if (inSupport) {
            await client.query(`INSERT INTO telegram_messages(bot_id,update_id,message_id,chat_id,chat_title,
              sender_name,sender_username,text,content_type,edited,sent_at)
              VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,to_timestamp($10))`,
            [row.bot_id, body.update_id, message.message_id, chatId, senderName, identity.username, text, contentType, edited, message.date]);
            await client.query(`INSERT INTO telegram_chat_messages AS current
              (bot_id,chat_id,message_id,chat_title,sender_name,sender_username,text,direction,sent_at,content_type,edited,update_id,is_support)
              VALUES($1,$2,$3,$4,$4,$5,$6,'incoming',to_timestamp($7),$8,$9,$10,TRUE)
              ON CONFLICT(bot_id,chat_id,message_id) DO UPDATE SET
                chat_title=EXCLUDED.chat_title,sender_name=EXCLUDED.sender_name,sender_username=EXCLUDED.sender_username,
                text=EXCLUDED.text,content_type=EXCLUDED.content_type,edited=EXCLUDED.edited,update_id=EXCLUDED.update_id
              WHERE current.direction='incoming' AND current.is_support AND current.deleted_at IS NULL AND
                (current.update_id IS NULL OR EXCLUDED.edited > current.edited OR
                  (EXCLUDED.edited=current.edited AND EXCLUDED.update_id > current.update_id))`,
            [...messageKey, senderName, identity.username, text, message.date, contentType, edited, body.update_id]);
          }
          const menuReply = body.message ? await createTelegramMenuReply(client, identity, row.bot_id, body.update_id, menu, inSupport) : null;
          await client.query('UPDATE telegram_settings SET last_received_at=NOW() WHERE id=1 AND bot_id=$1', [row.bot_id]);
          await client.query('COMMIT');
          return reply(200, menuReply ?? { ok: true });
        } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
      }

      const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token || !(await database.query('SELECT 1 FROM sessions WHERE token=$1 AND expires_at>NOW()', [token])).rowCount) {
        return reply(401, { message: 'برای ادامه با حساب مدیر وارد شوید.' });
      }
      if (action === 'android-apk') return await handleTelegramApk(database, method,
        req.query?.id ?? url.searchParams.get('id'), req.query?.part ?? url.searchParams.get('part'), req.body, res);

      const row = (await database.query<any>('SELECT * FROM telegram_settings WHERE id=1')).rows[0];
      if (action === 'settings' && method === 'GET') return reply(200, settingsOf(row));

      if (action === 'messages' && method === 'GET') {
        const result = await database.query(`SELECT m.id,m.update_id AS "updateId",m.message_id AS "messageId",m.chat_id AS "chatId",
          m.chat_title AS "chatTitle",m.sender_name AS "senderName",m.sender_username AS "senderUsername",
          CASE WHEN c.deleted_at IS NULL THEN m.text ELSE '' END AS text,
          CASE WHEN c.deleted_at IS NULL THEN m.content_type ELSE 'other' END AS "contentType",
          m.edited,m.sent_at AS "sentAt",m.received_at AS "receivedAt"
          FROM telegram_messages m JOIN telegram_chat_messages c
            ON (c.bot_id,c.chat_id,c.message_id)=(m.bot_id,m.chat_id,m.message_id)
          WHERE m.bot_id=$1 AND c.is_support ORDER BY m.received_at DESC,m.id DESC LIMIT 100`, [row.bot_id]);
        return reply(200, result.rows);
      }

      if (action === 'chats' && method === 'GET') {
        const result = await database.query(`SELECT "chatId",title,username,"lastMessage","lastContentType","lastDeleted" FROM (
          SELECT DISTINCT ON(chat_id) chat_id AS "chatId",chat_title AS title,sender_username AS username,
            text AS "lastMessage",content_type AS "lastContentType",(deleted_at IS NOT NULL) AS "lastDeleted",
            sent_at,message_id
          FROM telegram_chat_messages WHERE bot_id=$1 AND is_support ORDER BY chat_id,sent_at DESC,message_id DESC
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
          (deleted_at IS NOT NULL) AS deleted FROM telegram_chat_messages WHERE bot_id=$1 AND chat_id=$2 AND is_support
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
          FROM telegram_chat_messages WHERE bot_id=$1 AND chat_id=$2 AND direction='incoming' AND is_support
          ORDER BY sent_at DESC,message_id DESC LIMIT 1`, [row.bot_id, chatId])).rows[0];
        if (!chat) return reply(404, { message: 'این کاربر هنوز از بخش پشتیبانی پیام نداده است.' });

        const sent = await callTelegram(row.bot_token, 'sendMessage', { chat_id: chatId, text });
        if (!Number.isSafeInteger(sent?.message_id) || sent.message_id < 1 || !Number.isSafeInteger(sent.date) ||
          sent.date < 1 || sent.date > 8640000000000) throw new TelegramError('مشخصات پیام ارسالی از تلگرام دریافت نشد.');
        const message = { chatId, messageId: String(sent.message_id), senderName: 'پشتیبانی', text,
          direction: 'outgoing', sentAt: new Date(sent.date * 1000).toISOString(), contentType: 'text', deleted: false };
        try {
          await database.query(`INSERT INTO telegram_chat_messages
            (bot_id,chat_id,message_id,chat_title,sender_name,sender_username,text,direction,sent_at,is_support)
            VALUES($1,$2,$3,$4,$5,$6,$7,'outgoing',to_timestamp($8),TRUE)
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
            FROM telegram_chat_messages WHERE bot_id=$1 AND chat_id=$2 AND message_id=$3 AND is_support FOR UPDATE`, params)).rows[0];
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
