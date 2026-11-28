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
  let category = 0;
  let feedsDown = false;
  const sent: { chat_id: string; text: string }[] = [];
  const prompts: any[] = [];
  const aiAuthorization: (string | null)[] = [];
  const channelId = '-1001234567890';
  const adminToken = 'fixture-admin-session';
  const botToken = '123456789:fixture-bot-token';
  const env = { VERCEL: '1', CRON_SECRET: 'fixture-cron-secret', AVALAI_API_KEY: 'fixture-avalai-key' };
  const techUrl = 'https://arstechnica.com/tech-policy/new-chip';
  const olderTechUrl = 'https://www.theverge.com/tech/new-network';
  const politicsUrl = 'https://www.theguardian.com/politics/new-election';
  const newsFetch: typeof fetch = async url => {
    if (feedsDown) throw new Error('Feed unavailable');
    const stories: Record<string, [string, string, string][]> = {
      'feeds.arstechnica.com': [['A company presents a new chip', techUrl + '?utm_source=rss', 'Thu, 26 Nov 2026 10:00:00 GMT']],
      'www.theverge.com': [['New network made available', olderTechUrl, 'Thu, 26 Nov 2026 09:00:00 GMT']],
      'www.wired.com': [['Old device', 'https://www.wired.com/story/old', 'Fri, 20 Nov 2026 10:00:00 GMT']],
    };
    const feed = new URL(String(url));
    const items = feed.pathname === '/politics/rss'
      ? [['Parliament calls new election', politicsUrl, 'Thu, 26 Nov 2026 10:30:00 GMT']]
      : stories[feed.hostname] ?? [];
    return new Response(`<rss version="2.0"><channel><title>Test feed</title>${items.map(([title, link, date]) =>
      `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><description>A detailed source summary with named facts about the story.</description></item>`).join('')}</channel></rss>`);
  };

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
    const publisher = createTelegramChannelPublisher(postgres.database, async () => {}, {
      telegramFetch, aiFetch, newsFetch, chooseNewsCategory: () => category, env, now: () => date,
    });
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

  const settings = { target: 'https://t.me/test_channel', model: 'gpt-5-mini', automatic: false };

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

  it('summarizes the latest eligible story in either category and skips generation when feeds are unavailable', async () => {
    const preview = await request('preview', 'POST', settings);
    assert.equal(preview.status, 200);
    assert.ok(preview.data.text.endsWith(techUrl));
    assert.match(preview.data.text, /Ars Technica/);
    assert.equal(aiAuthorization.at(-1), `Bearer ${env.AVALAI_API_KEY}`);
    assert.equal(prompts.at(-1).model, settings.model);
    assert.match(JSON.parse(prompts.at(-1).messages[1].content).متن_منبع, /A company presents a new chip/);
    category = 1;
    assert.ok((await request('preview', 'POST', settings)).data.text.endsWith(politicsUrl));
    assert.equal(JSON.parse(prompts.at(-1).messages[1].content).موضوع, 'خبر سیاسی');
    category = 0;
    assert.equal(sent.length, 0);
    invalidAi = true;
    assert.equal((await request('preview', 'POST', settings)).status, 502);
    invalidAi = false;
    feedsDown = true;
    const aiCalls = prompts.length;
    assert.equal((await request('preview', 'POST', settings)).status, 502);
    assert.equal(prompts.length, aiCalls);
    feedsDown = false;
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

  it('deletes the database history row and prevents a deleted request from being sent again', async () => {
    const history = (await request()).data.history;
    const post = history.find((item: any) => item.status === 'sent');
    assert.ok(post);
    assert.equal((await request('history', 'DELETE', { id: post.id }, 'invalid')).status, 401);
    const deleted = await request('history', 'DELETE', { id: post.id });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.history.length, history.length - 1);
    assert.ok(!deleted.data.history.some((item: any) => item.id === post.id));
    assert.equal((await postgres.database.query('SELECT id FROM telegram_channel_deliveries WHERE id=$1', [post.id])).rowCount, 0);
    assert.equal((await request('send', 'POST', { requestId: post.id.slice(7), revision: 1, text: post.text })).status, 409);
    assert.equal(sent.length, 3);
  });

  it('deletes history created before request tracking, but protects active deliveries', async () => {
    const id = 'manual:' + randomUUID();
    await postgres.database.query(`INSERT INTO telegram_channel_deliveries(id,channel_id,channel_title,mode,text)
      VALUES($1,$2,'کانال آزمون','manual','پیام قدیمی')`, [id, channelId]);
    assert.equal((await request('history', 'DELETE', { id })).status, 409);
    await postgres.database.query("UPDATE telegram_channel_deliveries SET status='sent' WHERE id=$1", [id]);
    assert.equal((await request('history', 'DELETE', { id })).status, 200);
    assert.equal((await postgres.database.query('SELECT id FROM telegram_channel_deliveries WHERE id=$1', [id])).rowCount, 0);
    assert.equal((await request('send', 'POST', { requestId: id.slice(7), revision: 1, text: 'پیام قدیمی' })).status, 409);
    assert.equal(sent.length, 3);
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
    assert.ok(sent.at(-1)?.text.endsWith(olderTechUrl));
    const snapshot = await request();
    assert.equal(snapshot.data.history.filter((post: any) => post.mode === 'automatic').length, 2);
    assert.equal((await request('history', 'DELETE', { id: 'daily:2026-11-27' })).status, 200);
    assert.equal((await scheduled()).data.status, 'already-processed');
    permission = false;
    assert.equal((await request('settings', 'PUT', { ...settings, target: channelId, revision: 2 })).status, 200);
    date = new Date('2026-11-28T16:30:00Z');
    assert.equal((await scheduled()).data.status, 'disabled');
    assert.equal(sent.length, 5);
  });
});
