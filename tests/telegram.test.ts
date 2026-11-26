import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { createApiHandler } from '../api/[...path]';
import { initializeSchema } from '../server/database';
import { createTelegramHandler } from '../server/telegram';
import { createTestDatabase } from './database';

describe('Telegram connection and webhook inbox', () => {
  let postgres: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: Server;
  let base: string;
  let calls: { method: string; body: any }[];
  let remoteUrl: string;
  let failMethod: string;
  let remoteError: string;
  let nextMessageId: number;
  const adminToken = 'telegram-test-admin';
  const botToken = '123456789:abcdefghijklmnopqrstuvwxyz0123456789';
  const webhookUrl = 'https://panel.example.com/api/telegram?action=webhook';

  const fakeTelegram = (async (url: string | URL | Request, options: RequestInit) => {
    assert.ok(String(url).startsWith('https://api.telegram.org/bot' + botToken + '/'));
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(options.body));
    calls.push({ method, body });
    if (method === failMethod) return new Response(JSON.stringify({ ok: false, description: remoteError }), { status: 400 });
    let result: any = true;
    if (method === 'getMe') result = { id: 123456789, is_bot: true, username: 'panel_test_bot', first_name: 'Panel Bot' };
    else if (method === 'setWebhook') remoteUrl = body.url;
    else if (method === 'deleteWebhook') remoteUrl = '';
    else if (method === 'getWebhookInfo') result = { url: remoteUrl, pending_update_count: 2, last_error_message: '', last_error_date: undefined };
    else if (method === 'sendMessage') result = { message_id: nextMessageId++, date: 1795540005, chat: { id: Number(body.chat_id) } };
    else if (method !== 'deleteMessage') throw new Error('Unexpected Telegram method: ' + method);
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as typeof fetch;

  async function request(action: string, method = 'GET', body?: unknown, token = adminToken, fallback = false, query?: Record<string, string>) {
    const params = new URLSearchParams({ action, ...query });
    const response = await fetch(base + (fallback ? '/fallback' : '') + '/api/telegram?' + params, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { code: response.status, headers: response.headers, body: await response.json() };
  }
  async function settings() { return (await postgres.database.query<any>('SELECT * FROM telegram_settings WHERE id=1')).rows[0]; }
  async function connect() {
    assert.equal((await request('settings', 'PUT', { botToken, webhookUrl })).code, 200);
    const result = await request('connect', 'POST');
    assert.equal(result.code, 200);
    return settings();
  }
  const update = (id = 100, extra: any = {}) => ({ update_id: id, message: {
    message_id: id, date: 1795540000, chat: { id: -100123456789, title: 'گروه آزمایشی' },
    from: { id: 456789, first_name: 'کاربر', last_name: 'آزمایشی', username: 'test_user' }, text: 'سلام از تلگرام', ...extra,
  } });
  const privateUpdate = (id: number, text: string, chatId = 456789, extra: Record<string, unknown> = {}) =>
    update(id, { text, chat: { id: chatId, type: 'private' },
      from: { id: chatId, first_name: 'کاربر', last_name: 'آزمایشی', username: 'test_user' }, ...extra });
  async function webhook(body: unknown, secret: string, fallback = false) {
    const response = await fetch(base + (fallback ? '/fallback' : '') + '/api/telegram?action=webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body),
    });
    return { code: response.status, body: await response.json().catch(() => null) };
  }

  before(async () => {
    postgres = await createTestDatabase();
    await initializeSchema(postgres.database);
    await postgres.database.query(`INSERT INTO sessions(token,admin_username,expires_at)
      SELECT $1,username,NOW()+INTERVAL '1 hour' FROM admins LIMIT 1`, [adminToken]);
    const app = express(); app.use(express.json());
    app.use('/fallback', createApiHandler(postgres.database, async () => {}));
    app.all('/api/telegram', createTelegramHandler(postgres.database, async () => {}, fakeTelegram));
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = 'http://127.0.0.1:' + address.port;
  });
  beforeEach(async () => {
    calls = []; remoteUrl = ''; failMethod = ''; remoteError = ''; nextMessageId = 1000;
    await postgres.database.query('DELETE FROM telegram_chat_messages; DELETE FROM telegram_messages; DELETE FROM telegram_webhook_updates');
    await postgres.database.query(`UPDATE telegram_settings SET bot_token='',webhook_url='',webhook_secret='',enabled=FALSE,
      bot_id=NULL,bot_username='',bot_name='',last_received_at=NULL WHERE id=1`);
  });
  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (postgres) await postgres.close();
  });

  it('starts disconnected and protects settings and messages with an administrator session', async () => {
    const initial = await request('settings');
    assert.equal(initial.code, 200); assert.equal(initial.body.tokenConfigured, false); assert.equal(initial.body.enabled, false);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    for (const action of ['settings', 'messages', 'status', 'connect', 'disconnect', 'chats', 'chat', 'send', 'delete-message']) {
      const method = ['connect', 'disconnect', 'send', 'delete-message'].includes(action) ? 'POST' : 'GET';
      assert.equal((await request(action, method, undefined, '')).code, 401);
      assert.equal((await request(action, 'GET', undefined, 'invalid')).code, 401);
    }
    assert.equal((await request('connect', 'POST')).code, 400);
    assert.deepEqual(calls, []);
  });

  it('validates token and public HTTPS callback URL without overwriting a valid configuration', async () => {
    for (const url of ['http://panel.example.com/api/telegram?action=webhook', 'https://localhost/api/telegram?action=webhook',
      'https://panel.example.com/other', webhookUrl + '#fragment', webhookUrl + '&token=secret',
      'https://user:password@panel.example.com/api/telegram?action=webhook', 'https://panel.example.com:3001/api/telegram?action=webhook']) {
      assert.equal((await request('settings', 'PUT', { botToken, webhookUrl: url })).code, 400);
    }
    for (const token of ['bad', true, {}, '123:short']) assert.equal((await request('settings', 'PUT', { botToken: token, webhookUrl })).code, 400);
    const saved = await request('settings', 'PUT', { botToken, webhookUrl, enabled: true });
    assert.equal(saved.code, 200); assert.equal(saved.body.enabled, false); assert.equal(saved.body.tokenConfigured, true);
    assert.ok(!JSON.stringify(saved.body).includes(botToken)); assert.ok(!('webhook_secret' in saved.body));
    assert.equal((await request('settings', 'PUT', { botToken: '', webhookUrl })).code, 200);
    assert.equal((await settings()).bot_token, botToken);
  });

  it('registers the webhook with a random secret and reports actual Telegram status', async () => {
    const row = await connect();
    assert.equal(row.enabled, true); assert.equal(String(row.bot_id), '123456789'); assert.equal(row.bot_username, 'panel_test_bot');
    assert.match(row.webhook_secret, /^[a-f0-9]{64}$/);
    assert.deepEqual(calls.map(call => call.method), ['getMe', 'setWebhook']);
    assert.equal(calls[1].body.secret_token, row.webhook_secret); assert.equal(calls[1].body.url, webhookUrl);
    assert.equal(calls[1].body.drop_pending_updates, false);
    assert.deepEqual(calls[1].body.allowed_updates, ['message', 'edited_message', 'channel_post', 'edited_channel_post']);
    const status = await request('status'); assert.equal(status.body.connected, true); assert.equal(status.body.pendingUpdates, 2);
    assert.ok(!JSON.stringify(status.body).includes(botToken)); assert.ok(!JSON.stringify(status.body).includes(row.webhook_secret));
    remoteUrl = 'https://other.example.com/hook'; assert.equal((await request('status')).body.connected, false);
    assert.equal((await request('settings', 'PUT', { webhookUrl: 'https://new.example.com/api/telegram?action=webhook' })).code, 409);
    assert.equal((await settings()).webhook_url, webhookUrl);
  });

  it('accepts authentic messages without admin login and deduplicates Telegram retries', async () => {
    const row = await connect();
    const question = privateUpdate(100, 'سلام از تلگرام');
    assert.equal((await webhook(question, '')).code, 401);
    assert.equal((await webhook(question, 'wrong')).code, 401);
    await webhook(privateUpdate(99, 'پشتیبانی'), row.webhook_secret);
    assert.equal((await webhook(question, row.webhook_secret)).code, 200);
    assert.equal((await webhook(question, row.webhook_secret, true)).code, 200);
    const result = await request('messages'); assert.equal(result.code, 200); assert.equal(result.body.length, 1);
    assert.equal(result.body[0].senderName, 'کاربر آزمایشی'); assert.equal(result.body[0].senderUsername, 'test_user');
    assert.equal(result.body[0].chatId, '456789'); assert.equal(result.body[0].text, 'سلام از تلگرام');
    assert.equal(new Date(result.body[0].sentAt).getTime(), 1795540000 * 1000);
    assert.ok((await settings()).last_received_at);
    assert.deepEqual((await request('messages', 'GET', undefined, adminToken, true)).body, result.body);
    assert.equal((await request('webhook')).code, 405);
  });

  it('stores support captions and edits while ignoring channel posts and edits to other messages', async () => {
    const row = await connect();
    const beforeSupport = privateUpdate(99, 'پیام خارج از پشتیبانی');
    await webhook(beforeSupport, row.webhook_secret);
    await webhook(privateUpdate(100, 'پشتیبانی'), row.webhook_secret);
    await webhook(privateUpdate(101, '', 456789, { text: undefined, photo: [{ file_id: 'photo-id' }], caption: 'توضیح تصویر' }), row.webhook_secret);
    const question = privateUpdate(102, 'پیام پشتیبانی');
    await webhook(question, row.webhook_secret);
    const service = privateUpdate(107, '', 456789, { text: undefined, message_auto_delete_timer_changed: { message_auto_delete_time: 60 } });
    assert.deepEqual((await webhook(service, row.webhook_secret)).body, { ok: true });
    await webhook(privateUpdate(103, '/menu'), row.webhook_secret);
    await webhook({ update_id: 104, edited_message: { ...question.message, text: '<script>alert(1)</script>' } }, row.webhook_secret);
    await webhook({ update_id: 105, edited_message: { ...beforeSupport.message, text: 'متن ویرایش‌شده خارج از پشتیبانی' } }, row.webhook_secret);
    await webhook({ update_id: 106, channel_post: { message_id: 10, date: 1795540000, chat: { id: -100777, title: 'کانال', type: 'channel' }, voice: { file_id: 'voice' } } }, row.webhook_secret);
    const rows = (await request('messages')).body;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].edited, true); assert.equal(rows[0].text, '<script>alert(1)</script>');
    assert.equal(rows[2].text, 'توضیح تصویر'); assert.equal(rows[2].contentType, 'photo');
    assert.ok(calls.every(call => ['getMe', 'setWebhook'].includes(call.method)));
  });

  it('rejects malformed updates and acknowledges unrelated updates safely', async () => {
    const row = await connect();
    for (const body of [null, {}, { update_id: '12' }, { update_id: -1 }, update(104, { chat: { id: 'invalid' } }), update(105, { date: -1 })]) {
      assert.equal((await webhook(body, row.webhook_secret)).code, 400);
    }
    assert.equal((await webhook({ update_id: 106, callback_query: {} }, row.webhook_secret)).code, 200);
    assert.equal((await request('messages')).body.length, 0);
  });

  it('disconnects while preserving inbox history and refuses disabled webhook requests', async () => {
    const row = await connect();
    await webhook(privateUpdate(99, 'پشتیبانی'), row.webhook_secret);
    await webhook(privateUpdate(100, 'سلام'), row.webhook_secret);
    const result = await request('disconnect', 'POST'); assert.equal(result.code, 200); assert.equal(result.body.enabled, false);
    assert.equal(calls.at(-1)?.method, 'deleteWebhook'); assert.equal(calls.at(-1)?.body.drop_pending_updates, false);
    assert.equal((await request('messages')).body.length, 1);
    assert.equal((await webhook(update(110), row.webhook_secret)).code, 401);
    assert.equal((await request('status')).body.connected, false);
  });

  it('keeps failed registration disconnected and redacts tokens from Telegram errors', async () => {
    await request('settings', 'PUT', { botToken, webhookUrl });
    failMethod = 'setWebhook'; remoteError = 'Invalid token ' + botToken;
    const result = await request('connect', 'POST'); assert.equal(result.code, 502);
    assert.ok(!JSON.stringify(result.body).includes(botToken)); assert.equal((await settings()).enabled, false);
    failMethod = ''; assert.equal((await request('connect', 'POST')).code, 200);
    failMethod = 'deleteWebhook'; assert.equal((await request('disconnect', 'POST')).code, 502);
    assert.equal((await settings()).enabled, true);
  });

  it('retains at most 100 inbox entries in the response and isolates another bot history', async () => {
    const row = await connect();
    await postgres.database.query(`WITH incoming AS (
      INSERT INTO telegram_messages(bot_id,update_id,message_id,chat_id,text,sent_at)
        SELECT $1,n,n,'123','پیام',NOW() FROM generate_series(1,110) n
        UNION ALL SELECT 999,200,200,'123','ربات دیگر',NOW()
        RETURNING bot_id,chat_id,message_id,text,sent_at
    )
    INSERT INTO telegram_chat_messages(bot_id,chat_id,message_id,text,sent_at,direction,is_support)
      SELECT bot_id,chat_id,message_id,text,sent_at,'incoming',TRUE FROM incoming`, [row.bot_id]);
    const result = await request('messages'); assert.equal(result.body.length, 100);
    assert.ok(result.body.every((message: any) => message.text !== 'ربات دیگر'));
    assert.equal(String(result.body[0].updateId), '110');
  });

  const privateChat = (botId: unknown) => ({ botId: String(botId), chatId: '456789' });
  const thread = (chat: ReturnType<typeof privateChat>, fallback = false) => request('chat', 'GET', undefined, adminToken, fallback, chat);

  it('admits only messages sent through support and exits support for each other menu choice', async () => {
    const row = await connect();
    const secret = row.webhook_secret;
    const outside = await webhook(privateUpdate(200, 'پیام بدون انتخاب پشتیبانی'), secret);
    assert.match(outside.body.text, /ابتدا «پشتیبانی»/);
    assert.equal((await webhook(privateUpdate(201, 'پشتیبانی'), secret)).body.method, 'sendMessage');
    assert.deepEqual((await request('chats')).body.chats, []);
    assert.match((await webhook(privateUpdate(202, 'پیام کاربر دوم', 789012), secret)).body.text, /ابتدا «پشتیبانی»/);

    const expected: string[] = [];
    for (const [index, menu] of ['وضعیت اشتراک', 'تعرفه‌ها', 'اتصال به برنامه', '/menu', '/start@panel_test_bot'].entries()) {
      const id = 210 + index * 4;
      const question = 'سؤال پشتیبانی ' + index;
      assert.match((await webhook(privateUpdate(id, question), secret)).body.text, /پشتیبانی دریافت شد/);
      expected.push(question);
      const choice = privateUpdate(id + 1, menu);
      assert.equal((await webhook(choice, secret)).body.method, 'sendMessage');
      assert.match((await webhook(privateUpdate(id + 2, 'خارج از پشتیبانی'), secret)).body.text, /ابتدا «پشتیبانی»/);
      assert.equal((await webhook(privateUpdate(id + 3, 'پشتیبانی'), secret)).body.method, 'sendMessage');
      assert.deepEqual((await webhook(choice, secret)).body, { ok: true });
    }
    assert.deepEqual((await thread(privateChat(row.bot_id))).body.map((message: any) => message.text), expected);
    const stored = await postgres.database.query('SELECT text FROM telegram_messages ORDER BY id');
    assert.deepEqual(stored.rows, expected.map(text => ({ text })));
  });

  it('uses the menu order within the chat when Telegram delivers an exit or a question late', async () => {
    const row = await connect();
    const secret = row.webhook_secret;
    const open = privateUpdate(200, 'پشتیبانی');
    await webhook(open, secret);
    await webhook(privateUpdate(201, 'سؤال اول'), secret);
    await webhook(privateUpdate(205, 'پیام پس از خروج'), secret);
    await webhook(privateUpdate(210, 'پشتیبانی'), secret);
    await webhook(privateUpdate(211, 'سؤال بعد از ورود دوباره'), secret);

    await webhook(privateUpdate(204, '/menu'), secret);
    await webhook(privateUpdate(202, 'سؤال با تحویل دیرتر'), secret);
    await webhook(privateUpdate(206, 'پیام خارج از پشتیبانی'), secret);
    assert.deepEqual((await webhook(open, secret)).body, { ok: true });
    assert.deepEqual((await thread(privateChat(row.bot_id))).body.map((message: any) => message.text), [
      'سؤال اول', 'سؤال با تحویل دیرتر', 'سؤال بعد از ورود دوباره',
    ]);
  });

  it('receives a support question and saves the admin reply sent to the same private Telegram chat', async () => {
    const row = await connect();
    const chat = privateChat(row.bot_id);
    assert.equal((await webhook(privateUpdate(210, 'پشتیبانی'), row.webhook_secret)).body.chat_id, chat.chatId);
    const question = privateUpdate(211, 'برای تمدید راهنمایی می‌خواهم');
    assert.equal((await webhook(question, row.webhook_secret, true)).code, 200);
    assert.deepEqual((await webhook(question, row.webhook_secret)).body, { ok: true });
    await webhook(privateUpdate(212, 'پشتیبانی', 789012), row.webhook_secret);
    await webhook(privateUpdate(213, 'سؤال کاربر دوم', 789012), row.webhook_secret);

    const inbox = await request('chats');
    assert.equal(inbox.code, 200);
    assert.equal(inbox.body.botId, chat.botId);
    assert.equal(inbox.body.connected, true);
    assert.equal(inbox.body.chats.find((item: any) => item.chatId === chat.chatId).lastMessage, question.message.text);
    const text = 'سلام، از بخش تعرفه‌ها می‌توانید اشتراک را تمدید کنید.';
    const reply = await request('send', 'POST', { ...chat, message: ' ' + text + ' ' });
    assert.equal(reply.code, 201);
    assert.deepEqual(calls.at(-1), { method: 'sendMessage', body: { chat_id: chat.chatId, text } });
    assert.equal(reply.body.direction, 'outgoing');
    assert.equal(reply.body.text, text);
    assert.equal((await request('chats')).body.chats[0].lastMessage, text);

    const history = await thread(chat, true);
    assert.equal(history.code, 200);
    assert.deepEqual(history.body.map((message: any) => [message.direction, message.text]), [
      ['incoming', question.message.text], ['outgoing', text],
    ]);
    assert.equal((await thread({ ...chat, chatId: '789012' })).body.length, 1);
  });

  it('validates the active bot and known private chat before sending and keeps failed sends out of the history', async () => {
    const row = await connect();
    const chat = privateChat(row.bot_id);
    await webhook(update(), row.webhook_secret);
    await webhook(privateUpdate(210, 'پشتیبانی'), row.webhook_secret);
    await webhook(privateUpdate(211, 'سلام'), row.webhook_secret);

    const payload = { ...chat, message: 'پاسخ پشتیبانی' };
    assert.equal((await request('send', 'POST', { ...payload, botId: '999' })).code, 409);
    assert.equal((await thread({ ...chat, botId: '999' })).code, 409);
    assert.equal((await request('send', 'POST', { ...payload, chatId: '789012' })).code, 404);
    assert.equal((await request('send', 'POST', { ...payload, chatId: '-100123456789' })).code, 400);
    for (const message of [{ text: 'پاسخ' }, ' ', 'a'.repeat(4097)]) {
      assert.equal((await request('send', 'POST', { ...payload, message })).code, 400);
    }
    assert.ok(calls.every(call => call.method !== 'sendMessage'));

    failMethod = 'sendMessage'; remoteError = 'Forbidden: bot was blocked by the user';
    assert.equal((await request('send', 'POST', payload)).code, 502);
    assert.deepEqual((await thread(chat)).body.map((message: any) => message.direction), ['incoming']);
    assert.equal((await request('disconnect', 'POST')).code, 200);
    assert.equal((await request('chats')).body.connected, false);
    assert.equal((await request('send', 'POST', payload)).code, 409);
    assert.equal(calls.filter(call => call.method === 'sendMessage').length, 1);
  });

  it('distinguishes a Telegram delivery from a failure to write the delivered reply to history', async () => {
    const row = await connect();
    await webhook(privateUpdate(210, 'پشتیبانی'), row.webhook_secret);
    await webhook(privateUpdate(211, 'سلام'), row.webhook_secret);
    await postgres.database.query("ALTER TABLE telegram_chat_messages ADD CONSTRAINT test_incoming_only CHECK (direction='incoming')");
    try {
      const reply = await request('send', 'POST', { ...privateChat(row.bot_id), message: 'سلام' });
      assert.equal(reply.code, 202);
      assert.match(reply.body.notice, /در تلگرام ارسال شد/);
      assert.equal(reply.body.direction, 'outgoing');
      assert.equal(calls.filter(call => call.method === 'sendMessage').length, 1);
    } finally {
      await postgres.database.query('ALTER TABLE telegram_chat_messages DROP CONSTRAINT test_incoming_only');
    }
  });

  it('keeps prior support questions and replies while removing menus and other messages from the visible history', async () => {
    const row = await connect();
    const chat = privateChat(row.bot_id);
    await postgres.database.query(`INSERT INTO telegram_messages(bot_id,update_id,message_id,chat_id,chat_title,text,content_type,edited,sent_at)
      VALUES($1,10,15,$2,'کاربر قدیمی','کپشن ویرایش‌شده','photo',TRUE,to_timestamp(1795540000)),
        ($1,9,15,$2,'کاربر قدیمی','کپشن اولیه','photo',FALSE,to_timestamp(1795540000)),
        ($1,7,13,$2,'کاربر قدیمی','پیام پیش از پشتیبانی','text',FALSE,to_timestamp(1795540000)),
        ($1,8,14,$2,'کاربر قدیمی','پشتیبانی','text',FALSE,to_timestamp(1795540000)),
        ($1,11,17,$2,'کاربر قدیمی','تعرفه‌ها','text',FALSE,to_timestamp(1795540000)),
        ($1,12,18,$2,'کاربر قدیمی','پیام بعد از خروج','text',FALSE,to_timestamp(1795540000)),
        (999,11,17,$2,'ربات دیگر','پیام ربات دیگر','text',FALSE,to_timestamp(1795540000))`, [row.bot_id, chat.chatId]);
    await postgres.database.query(`INSERT INTO telegram_chat_messages(bot_id,chat_id,message_id,direction,text,sent_at)
      VALUES($1,$2,16,'outgoing','پاسخ قبلی',to_timestamp(1795540000)),
        ($1,$2,17,'incoming','تعرفه‌ها',to_timestamp(1795540000)),
        ($1,$2,18,'incoming','پیام بعد از خروج',to_timestamp(1795540000))`, [row.bot_id, chat.chatId]);
    await postgres.database.query('ALTER TABLE telegram_chat_messages DROP COLUMN is_support');
    await initializeSchema(postgres.database);
    await initializeSchema(postgres.database);
    const prior = await thread(chat);
    assert.deepEqual(prior.body.map((message: any) => [message.text, message.contentType]), [
      ['کپشن ویرایش‌شده', 'photo'], ['پاسخ قبلی', 'text'],
    ]);
    assert.equal((await request('messages')).body.length, 2);
    assert.deepEqual((await webhook({ ...privateUpdate(8, 'پشتیبانی'), message: { ...privateUpdate(8, 'پشتیبانی').message, message_id: 14 } }, row.webhook_secret)).body, { ok: true });
    assert.match((await webhook(privateUpdate(19, 'پیام بعد از ارتقا'), row.webhook_secret)).body.text, /ابتدا «پشتیبانی»/);
  });

  it('keeps the newest edit to an admitted message when edits arrive out of order', async () => {
    const row = await connect();
    const chat = privateChat(row.bot_id);
    await webhook(privateUpdate(19, 'پشتیبانی'), row.webhook_secret);
    const question = privateUpdate(20, 'متن اولیه');
    await webhook(question, row.webhook_secret);
    await webhook({ update_id: 22, edited_message: { ...question.message, text: 'متن تازه' } }, row.webhook_secret);
    await webhook({ update_id: 21, edited_message: { ...question.message, text: 'ویرایش قبلی' } }, row.webhook_secret);
    assert.equal((await thread(chat)).body.at(-1).text, 'متن تازه');
  });

  it('keeps a deleted Telegram message hidden even if a later update edits it', async () => {
    const row = await connect();
    const chat = privateChat(row.bot_id);
    await webhook(privateUpdate(210, 'پشتیبانی'), row.webhook_secret);
    const incoming = privateUpdate(211, 'متن اولیه');
    await webhook(incoming, row.webhook_secret);
    const payload = { ...chat, messageId: '211' };
    assert.equal((await request('delete-message', 'POST', payload)).code, 200);
    assert.equal((await request('delete-message', 'POST', payload)).code, 200);
    assert.deepEqual(calls.filter(call => call.method === 'deleteMessage'), [
      { method: 'deleteMessage', body: { chat_id: chat.chatId, message_id: 211 } },
    ]);
    await webhook({ update_id: 212, edited_message: { ...incoming.message, text: 'متن ویرایش‌شده' } }, row.webhook_secret);
    const history = await thread(chat);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].deleted, true);
    assert.equal(history.body[0].text, '');
    assert.ok((await request('messages')).body.every((message: any) => message.text === ''));
  });

  it('shows the four persistent bottom menu buttons on start and menu commands', async () => {
    const row = await connect();
    for (const [index, command] of ['/start', '/start@panel_test_bot invitation', '/menu'].entries()) {
      const result = await webhook(privateUpdate(200 + index, command), row.webhook_secret);
      assert.equal(result.code, 200); assert.equal(result.body.method, 'sendMessage');
      assert.equal(result.body.chat_id, '456789');
      assert.deepEqual(result.body.reply_markup.keyboard.flat().map((button: any) => button.text), ['پشتیبانی', 'اتصال به برنامه', 'تعرفه ها', 'وضعیت اشتراک']);
      assert.equal(result.body.reply_markup.resize_keyboard, true);
      assert.equal(result.body.reply_markup.is_persistent, true);
    }
  });

  it('guides support messages into the inbox and displays a copyable app connection code', async () => {
    const row = await connect();
    const support = await webhook(privateUpdate(210, 'پشتیبانی'), row.webhook_secret);
    assert.match(support.body.text, /همین‌جا/);
    const message = await webhook(privateUpdate(211, 'برای تمدید راهنمایی می‌خواهم'), row.webhook_secret);
    assert.match(message.body.text, /پشتیبانی دریافت شد/);
    const app = await webhook(privateUpdate(212, 'اتصال به برنامه'), row.webhook_secret);
    assert.equal(app.code, 200);
    assert.equal(app.body.parse_mode, 'HTML');
    assert.match(app.body.text, /<code>Ariya[A-Za-z0-9]{10}<\/code>/);
    assert.equal(support.body.parse_mode, undefined);
    assert.equal(message.body.parse_mode, undefined);
    assert.equal((await request('messages')).body.length, 1);
    assert.ok(support.body.reply_markup && message.body.reply_markup && app.body.reply_markup);
  });

  it('generates a fresh 15-character code with letters and digits for every app connection click', async () => {
    const row = await connect();
    const codes = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const result = await webhook(privateUpdate(300 + index, 'اتصال به برنامه'), row.webhook_secret, index % 2 === 1);
      assert.equal(result.code, 200);
      assert.equal(result.body.method, 'sendMessage');
      assert.equal(result.body.chat_id, '456789');
      assert.equal(result.body.parse_mode, 'HTML');
      const code = result.body.text.match(/<code>([^<]+)<\/code>/)?.[1];
      assert.ok(code);
      assert.equal(code.length, 15);
      assert.match(code, /^Ariya[A-Za-z0-9]{10}$/);
      assert.match(code.slice(5), /[A-Za-z]/);
      assert.match(code.slice(5), /[0-9]/);
      assert.ok(!codes.has(code));
      codes.add(code);
      assert.ok(result.body.reply_markup);
      const retry = await webhook(privateUpdate(300 + index, 'اتصال به برنامه'), row.webhook_secret);
      assert.deepEqual(retry.body, { ok: true });
    }
    assert.equal((await request('messages')).body.length, 0);
  });

  it('reads current active tariffs in toman and excludes trial and disabled plans', async () => {
    const row = await connect();
    await postgres.database.query(`INSERT INTO subscription_plans(name,price_irr,quota_bytes,duration_days,active)
      VALUES('تعرفه آزمون',123456,2147483648,12,TRUE),('تعرفه خاموش',999,1073741824,7,FALSE)`);
    try {
      for (const [index, label] of ['تعرفه ها', 'تعرفه‌ها'].entries()) {
        const result = await webhook(privateUpdate(220 + index, label), row.webhook_secret);
        assert.equal(result.code, 200); assert.equal(result.body.method, 'sendMessage');
        assert.match(result.body.text, /تعرفه آزمون/); assert.match(result.body.text, /۱۲۳٬۴۵۶ تومان/);
        assert.match(result.body.text, /۲ گیگابایت/); assert.match(result.body.text, /۱۲ روز/);
        assert.ok(!result.body.text.includes('تعرفه خاموش')); assert.ok(!result.body.text.includes('آزمایشی'));
        assert.ok(result.body.text.length <= 4096);
      }
    } finally { await postgres.database.query("DELETE FROM subscription_plans WHERE name IN ('تعرفه آزمون','تعرفه خاموش')"); }
  });

  it('shows a useful message when there are no active paid plans', async () => {
    const row = await connect();
    const active = (await postgres.database.query<any>('SELECT id FROM subscription_plans WHERE active=TRUE')).rows.map((plan: any) => plan.id);
    await postgres.database.query('UPDATE subscription_plans SET active=FALSE');
    try {
      const result = await webhook(privateUpdate(230, 'تعرفه ها'), row.webhook_secret);
      assert.match(result.body.text, /تعرفه‌ای فعال نیست/); assert.ok(result.body.reply_markup);
    } finally { await postgres.database.query('UPDATE subscription_plans SET active=TRUE WHERE id=ANY($1::bigint[])', [active]); }
  });

  it('does not send a second menu response for a retried update', async () => {
    const row = await connect(); const body = privateUpdate(240, '/start');
    const first = await webhook(body, row.webhook_secret); assert.equal(first.body.method, 'sendMessage');
    const retry = await webhook(body, row.webhook_secret, true); assert.deepEqual(retry.body, { ok: true });
    assert.equal((await request('messages')).body.length, 0);
    assert.ok(calls.every(call => ['getMe', 'setWebhook'].includes(call.method)));
  });

  it('does not send menu responses in groups, channels, edited messages or bot messages', async () => {
    const row = await connect();
    assert.deepEqual((await webhook(update(250, { text: '/start', chat: { id: -123, type: 'group' } }), row.webhook_secret)).body, { ok: true });
    assert.deepEqual((await webhook({ update_id: 251, edited_message: privateUpdate(251, '/start').message }, row.webhook_secret)).body, { ok: true });
    assert.deepEqual((await webhook({ update_id: 252, channel_post: update(252, { text: '/start', chat: { id: -456, type: 'channel' } }).message }, row.webhook_secret)).body, { ok: true });
    assert.deepEqual((await webhook(update(253, { text: '/start', chat: { id: 456789, type: 'private' }, from: { id: 123, is_bot: true } }), row.webhook_secret)).body, { ok: true });
    assert.deepEqual((await webhook(update(254, { text: 'اتصال به برنامه', chat: { id: -123, type: 'group' } }), row.webhook_secret)).body, { ok: true });
    assert.deepEqual((await webhook({ update_id: 255, edited_message: privateUpdate(255, 'اتصال به برنامه').message }, row.webhook_secret)).body, { ok: true });
    assert.deepEqual((await webhook(update(256, { text: 'اتصال به برنامه', chat: { id: 456789, type: 'private' }, from: { id: 123, is_bot: true } }), row.webhook_secret)).body, { ok: true });
  });

  it('keeps schema initialization idempotent and preserves Telegram history', async () => {
    const row = await connect();
    await webhook(privateUpdate(99, 'پشتیبانی'), row.webhook_secret);
    await webhook(privateUpdate(100, 'سلام'), row.webhook_secret);
    await initializeSchema(postgres.database);
    assert.equal((await settings()).enabled, true); assert.equal((await request('messages')).body.length, 1);
  });
});
