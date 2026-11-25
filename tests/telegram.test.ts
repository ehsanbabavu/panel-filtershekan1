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
    else if (method !== 'getMe') throw new Error('Unexpected Telegram method: ' + method);
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as typeof fetch;

  async function request(action: string, method = 'GET', body?: unknown, token = adminToken, fallback = false) {
    const response = await fetch(base + (fallback ? '/fallback' : '') + '/api/telegram?action=' + action, {
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
    calls = []; remoteUrl = ''; failMethod = ''; remoteError = '';
    await postgres.database.query('DELETE FROM telegram_messages');
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
    for (const action of ['settings', 'messages', 'status', 'connect', 'disconnect']) {
      assert.equal((await request(action, action === 'connect' || action === 'disconnect' ? 'POST' : 'GET', undefined, '')).code, 401);
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
    assert.equal((await webhook(update(), '')).code, 401);
    assert.equal((await webhook(update(), 'wrong')).code, 401);
    assert.equal((await webhook(update(), row.webhook_secret)).code, 200);
    assert.equal((await webhook(update(), row.webhook_secret, true)).code, 200);
    const result = await request('messages'); assert.equal(result.code, 200); assert.equal(result.body.length, 1);
    assert.equal(result.body[0].senderName, 'کاربر آزمایشی'); assert.equal(result.body[0].senderUsername, 'test_user');
    assert.equal(result.body[0].chatId, '-100123456789'); assert.equal(result.body[0].text, 'سلام از تلگرام');
    assert.equal(new Date(result.body[0].sentAt).getTime(), 1795540000 * 1000);
    assert.ok((await settings()).last_received_at);
    assert.deepEqual((await request('messages', 'GET', undefined, adminToken, true)).body, result.body);
    assert.equal((await request('webhook')).code, 405);
  });

  it('handles captions, edited messages and channel posts without downloading media', async () => {
    const row = await connect();
    await webhook(update(101, { text: undefined, photo: [{ file_id: 'photo-id' }], caption: 'توضیح تصویر' }), row.webhook_secret);
    await webhook({ update_id: 102, edited_message: { ...update(102).message, text: '<script>alert(1)</script>' } }, row.webhook_secret);
    await webhook({ update_id: 103, channel_post: { message_id: 10, date: 1795540000, chat: { id: -100777, title: 'کانال' }, voice: { file_id: 'voice' } } }, row.webhook_secret);
    const rows = (await request('messages')).body;
    assert.equal(rows.length, 3); assert.equal(rows[0].text, ''); assert.equal(rows[0].contentType, 'voice');
    assert.equal(rows[1].edited, true); assert.equal(rows[1].text, '<script>alert(1)</script>');
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
    const row = await connect(); await webhook(update(), row.webhook_secret);
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
    await postgres.database.query(`INSERT INTO telegram_messages(bot_id,update_id,message_id,chat_id,text,sent_at)
      SELECT $1,generate_series,generate_series,'123','پیام',NOW() FROM generate_series(1,110)`, [row.bot_id]);
    await postgres.database.query(`INSERT INTO telegram_messages(bot_id,update_id,message_id,chat_id,text,sent_at)
      VALUES(999,200,200,'123','ربات دیگر',NOW())`);
    const result = await request('messages'); assert.equal(result.body.length, 100);
    assert.ok(result.body.every((message: any) => message.text !== 'ربات دیگر'));
    assert.equal(String(result.body[0].updateId), '110');
  });

  const privateUpdate = (id: number, text: string) => update(id, { text, chat: { id: 456789, type: 'private' } });

  it('shows the three persistent bottom menu buttons on start and menu commands', async () => {
    const row = await connect();
    for (const [index, command] of ['/start', '/start@panel_test_bot invitation', '/menu'].entries()) {
      const result = await webhook(privateUpdate(200 + index, command), row.webhook_secret);
      assert.equal(result.code, 200); assert.equal(result.body.method, 'sendMessage');
      assert.equal(result.body.chat_id, '456789');
      assert.deepEqual(result.body.reply_markup.keyboard.flat().map((button: any) => button.text), ['پشتیبانی', 'اتصال به برنامه', 'تعرفه ها']);
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
    assert.equal((await request('messages')).body.length, 3);
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
    assert.equal((await request('messages')).body.length, 20);
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
    assert.equal((await request('messages')).body.length, 1);
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
    const row = await connect(); await webhook(update(), row.webhook_secret);
    await initializeSchema(postgres.database);
    assert.equal((await settings()).enabled, true); assert.equal((await request('messages')).body.length, 1);
  });
});
