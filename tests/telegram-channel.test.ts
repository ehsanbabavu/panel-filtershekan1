import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { initializeSchema } from '../server/database';
import { createTelegramChannelPublisher } from '../server/telegramChannel';
import { createTestDatabase } from './database';

describe('Telegram channel publishing', () => {
  let postgres: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: Server;
  let origin: string;
  let runScheduled: ReturnType<typeof createTelegramChannelPublisher>['runScheduled'];
  let date = new Date('2026-11-26T16:29:00Z');
  let permission = false;
  let chatType = 'channel';
  let sendResult: 'success' | 'rejected' | 'timeout' = 'success';
  let invalidAi = false;
  const sent: { chat_id: string; text: string }[] = [];
  const prompts: any[] = [];
  const aiAuthorization: (string | null)[] = [];
  const channelId = '-1001234567890';
  const adminToken = 'fixture-admin-session';
  const botToken = '123456789:fixture-bot-token';
  const env = { VERCEL: '1', CRON_SECRET: 'fixture-cron-secret', AVALAI_API_KEY: 'fixture-avalai-key' };

  const telegramFetch: typeof fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.ok(String(url).startsWith(`https://api.telegram.org/bot${botToken}/`));
    switch (String(url).split('/').at(-1)) {
      case 'getChat':
        return Response.json({ ok: true, result: { id: Number(channelId), type: chatType, title: 'کانال آزمون', username: 'test_channel' } });
      case 'getChatMember':
        assert.equal(body.user_id, 123456789);
        return Response.json({ ok: true, result: { status: 'administrator', can_post_messages: permission } });
      case 'sendMessage':
        sent.push(body);
        if (sendResult === 'timeout') throw new Error('Connection closed after submission');
        if (sendResult === 'rejected') {
          return Response.json({ ok: false, description: 'Unauthorized ' + botToken }, { status: 403 });
        }
        return Response.json({ ok: true, result: { message_id: sent.length } });
      default: throw new Error('Unexpected Telegram method');
    }
  };

  const aiFetch: typeof fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.avalai.ir/v1/chat/completions');
    aiAuthorization.push(new Headers(options?.headers).get('authorization'));
    prompts.push(JSON.parse(String(options?.body)));
    return Response.json({ choices: [{ message: { content: invalidAi ? 'invalid' : JSON.stringify({ text: 'یک نکتهٔ کاربردی' }) } }] });
  };

  before(async () => {
    postgres = await createTestDatabase();
    await initializeSchema(postgres.database);
    await postgres.database.query(`INSERT INTO sessions(token,admin_username,expires_at)
      SELECT $1,username,NOW()+INTERVAL '1 hour' FROM admins LIMIT 1`, [adminToken]);
    await postgres.database.query('UPDATE telegram_settings SET bot_id=$1,bot_token=$2 WHERE id=1', [123456789, botToken]);
    const publisher = createTelegramChannelPublisher(postgres.database, async () => {}, { telegramFetch, aiFetch, env, now: () => date });
    runScheduled = publisher.runScheduled;
    const app = express();
    app.use(express.json());
    app.all(['/api/telegram', '/api/telegram/channel/scheduled'], publisher.handle);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    origin = 'http://127.0.0.1:' + address.port;
  });

  after(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await postgres?.close();
  });

  async function request(action = 'settings', method = 'GET', body?: unknown, token = adminToken) {
    const path = action === 'scheduled' ? '/api/telegram/channel/scheduled' : '/api/telegram?action=channel-' + action;
    const response = await fetch(origin + path, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }

  const settings = { target: 'https://t.me/test_channel', topic: 'راهنمای آریا', model: 'gpt-5-mini', automatic: false };

  it('requires the right credentials and verifies a channel and its posting permission', async () => {
    assert.equal((await request('settings', 'GET', undefined, 'invalid')).status, 401);
    assert.equal((await request('scheduled')).status, 401);
    chatType = 'supergroup';
    assert.equal((await request('settings', 'PUT', { ...settings, revision: 0 })).status, 400);
    chatType = 'channel';
    assert.equal((await request('settings', 'PUT', { ...settings, revision: 0 })).status, 409);
    permission = true;
    const saved = await request('settings', 'PUT', { ...settings, revision: 0 });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.channel.channelId, channelId);
    assert.equal(saved.data.channel.revision, 1);
    assert.equal(saved.data.channelReady, true);
    assert.ok(!JSON.stringify(saved.data).includes(botToken));
    assert.equal((await request('settings', 'PUT', { ...settings, revision: 0 })).status, 409);
  });

  it('generates a source-based preview without sending it, and rejects invalid model output', async () => {
    const brief = { ...settings, source: 'آریا یک راهنما منتشر کرد.', sourceUrl: 'https://example.com/news' };
    assert.equal((await request('preview', 'POST', { ...brief, sourceUrl: '' })).status, 400);
    const preview = await request('preview', 'POST', brief);
    assert.equal(preview.status, 200);
    assert.equal(preview.data.text, 'یک نکتهٔ کاربردی\n\nمنبع: https://example.com/news');
    assert.equal(aiAuthorization.at(-1), `Bearer ${env.AVALAI_API_KEY}`);
    assert.equal(prompts.at(-1).model, settings.model);
    assert.equal(JSON.parse(prompts.at(-1).messages[1].content).متن_منبع, brief.source);
    assert.equal(sent.length, 0);
    invalidAi = true;
    assert.equal((await request('preview', 'POST', brief)).status, 502);
    invalidAi = false;
  });

  it('lets only administrators save an AvalAI key and exposes only its status', async () => {
    const fixture = 'fixture-panel-avalai-key';
    assert.equal((await request('ai-settings', 'GET', undefined, 'invalid')).status, 401);
    assert.equal((await request('ai-settings', 'PUT', { apiKey: fixture }, 'invalid')).status, 401);
    assert.deepEqual((await request('ai-settings')).data, { configured: true, saved: false });
    const stored = await request('ai-settings', 'PUT', { apiKey: fixture });
    assert.equal(stored.status, 200);
    assert.deepEqual(stored.data, { configured: true, saved: true });
    assert.equal((await request('ai-settings', 'PUT', { apiKey: 'invalid key' })).status, 400);
    assert.deepEqual((await request('ai-settings')).data, stored.data);
    assert.ok(!JSON.stringify((await request()).data).includes(fixture));
    assert.equal((await request('preview', 'POST', settings)).status, 200);
    assert.equal(aiAuthorization.at(-1), 'Bearer ' + fixture);
  });

  it('publishes to the saved numeric destination and deduplicates repeat submissions', async () => {
    const body = { requestId: randomUUID(), revision: 1, text: 'پیام تست', channelId: '-1000000000000' };
    const first = await request('send', 'POST', body);
    const duplicate = await request('send', 'POST', body);
    assert.equal(first.data.delivery.status, 'sent');
    assert.equal(duplicate.data.delivery.id, first.data.delivery.id);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { chat_id: channelId, text: body.text, link_preview_options: { is_disabled: true } });
    assert.equal((await request('send', 'POST', { ...body, text: 'different' })).status, 409);
  });

  it('records rejection and avoids repeating a delivery with an uncertain result', async () => {
    sendResult = 'rejected';
    const body = { requestId: randomUUID(), revision: 1, text: 'پیام تست' };
    const failed = await request('send', 'POST', body);
    assert.equal(failed.data.delivery.status, 'failed');
    assert.ok(!failed.data.delivery.error.includes(botToken));
    sendResult = 'timeout';
    const retry = { ...body, requestId: randomUUID() };
    assert.equal((await request('send', 'POST', retry)).data.delivery.status, 'uncertain');
    assert.equal((await request('send', 'POST', retry)).data.delivery.status, 'uncertain');
    assert.equal(sent.length, 3);
    sendResult = 'success';
  });

  it('runs once per Tehran date, collects history, and stops when disabled', async () => {
    const saved = await request('settings', 'PUT', { ...settings, target: channelId, automatic: true, revision: 1 });
    assert.equal(saved.status, 200);
    const scheduled = () => request('scheduled', 'GET', undefined, env.CRON_SECRET);
    assert.equal((await runScheduled()).status, 'not-due');
    const outcomes = (await Promise.all([scheduled(), scheduled()])).map(result => result.data.status);
    assert.deepEqual(outcomes.sort(), ['already-processed', 'sent']);
    assert.equal(aiAuthorization.at(-1), 'Bearer fixture-panel-avalai-key');
    assert.equal(sent.length, 4);
    date = new Date('2026-11-27T16:30:00Z');
    assert.equal((await scheduled()).data.status, 'sent');
    assert.deepEqual(JSON.parse(prompts.at(-1).messages[1].content).پست‌های_قبلی, ['یک نکتهٔ کاربردی']);
    const snapshot = await request();
    assert.equal(snapshot.data.history.filter((post: any) => post.mode === 'automatic').length, 2);
    permission = false;
    assert.equal((await request('settings', 'PUT', { ...settings, target: channelId, revision: 2 })).status, 200);
    date = new Date('2026-11-28T16:30:00Z');
    assert.equal((await scheduled()).data.status, 'disabled');
    assert.equal(sent.length, 5);
  });
});
