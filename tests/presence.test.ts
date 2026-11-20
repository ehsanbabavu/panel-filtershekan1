import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { createApiHandler } from '../api/[...path]';
import { initializeSchema } from '../server/database';
import { createMobileHandler } from '../server/mobile';
import { selectUsers } from '../server/presence';
import { createTestDatabase } from './database';

describe('VPN presence through the mobile and panel HTTP APIs', () => {
  let postgres: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: Server;
  let base: string;
  let adminToken: string;
  let accountNumber = 0;

  async function request(path: string, method = 'GET', token = '', body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { code: response.status, headers: response.headers, body: await response.json() };
  }
  async function register(route = '/api/mobile?action=register') {
    const identity = 'presence.user.' + (++accountNumber);
    const password = 'test-password-123';
    const result = await request(route, 'POST', '', { name: 'کاربر آزمایش', identity, password });
    assert.equal(result.code, 201);
    return { ...result.body, identity, password };
  }
  async function status(id: string) {
    const result = await request('/api/users', 'GET', adminToken);
    assert.equal(result.code, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const user = result.body.find((row: any) => String(row.id) === String(id));
    assert.ok(user);
    return user.status;
  }
  async function presence(token: string, connected: boolean, sequence: number, route = '/api/mobile?action=presence') {
    return request(route, 'POST', token, { connected, sequence });
  }

  before(async () => {
    postgres = await createTestDatabase();
    await initializeSchema(postgres.database);
    const app = express();
    app.use(express.json());
    const initialized = async () => {};
    app.all(['/api/mobile', '/api/mobile/:action'], createMobileHandler(postgres.database, initialized));
    app.use(createApiHandler(postgres.database, initialized));
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = 'http://127.0.0.1:' + address.port;
    const login = await request('/api/login', 'POST', '', {
      username: process.env.ADMIN_USERNAME || 'ehsan',
      password: process.env.ADMIN_PASSWORD || '232111Eee@',
    });
    assert.equal(login.code, 200);
    adminToken = login.body.token;
  });
  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (postgres) await postgres.close();
  });

  it('registration and account login stay offline until VPN connection', async () => {
    const user = await register();
    assert.equal(await status(user.id), 'آفلاین');
    const login = await request('/api/mobile?action=login', 'POST', '', { identity: user.identity, password: user.password });
    assert.equal(login.code, 200);
    assert.equal(await status(user.id), 'آفلاین');
    assert.equal((await presence(login.body.token, true, 1)).code, 200);
    assert.equal(await status(user.id), 'آنلاین');
    assert.equal((await presence(login.body.token, false, 2)).code, 200);
    assert.equal(await status(user.id), 'آفلاین');
    assert.equal((await request('/api/mobile?action=me', 'GET', login.body.token)).code, 200);
  });

  it('supports path-style mobile routes with the same connection semantics', async () => {
    const user = await register('/api/mobile/register');
    const connected = await presence(user.token, true, 1, '/api/mobile/presence');
    assert.equal(connected.code, 200);
    assert.equal(await status(user.id), 'آنلاین');
    await presence(user.token, false, 2, '/api/mobile/presence');
    assert.equal(await status(user.id), 'آفلاین');
  });

  it('ignores delayed and replayed online reports after a newer disconnect', async () => {
    const user = await register();
    await presence(user.token, true, 1);
    await presence(user.token, false, 4);
    const delayed = await presence(user.token, true, 2);
    assert.equal(delayed.body.applied, false);
    assert.equal(await status(user.id), 'آفلاین');
    const replay = await presence(user.token, true, 4);
    assert.equal(replay.body.applied, false);
    assert.equal(await status(user.id), 'آفلاین');
    await presence(user.token, true, 5);
    assert.equal(await status(user.id), 'آنلاین');
  });

  it('expires a missing heartbeat after 90 seconds while preserving the account login', async () => {
    const user = await register();
    await presence(user.token, true, 1);
    await postgres.database.query(
      "UPDATE app_user_sessions SET vpn_heartbeat_at = NOW() - INTERVAL '91 seconds' WHERE token = $1", [user.token],
    );
    assert.equal(await status(user.id), 'آفلاین');
    assert.equal((await request('/api/mobile?action=me', 'GET', user.token)).code, 200);
    await presence(user.token, true, 2);
    assert.equal(await status(user.id), 'آنلاین');
  });

  it('keeps a user online until all connected devices disconnect or log out', async () => {
    const user = await register();
    const login = await request('/api/mobile?action=login', 'POST', '', { identity: user.identity, password: user.password });
    const secondToken = login.body.token;
    await presence(user.token, true, 1);
    await presence(secondToken, true, 1);
    await presence(user.token, false, 2);
    assert.equal(await status(user.id), 'آنلاین');
    await request('/api/mobile?action=logout', 'POST', user.token);
    assert.equal(await status(user.id), 'آنلاین');
    await request('/api/mobile?action=logout', 'POST', secondToken);
    assert.equal(await status(user.id), 'آفلاین');
    assert.equal((await presence(secondToken, true, 2)).code, 401);
    const rows = await selectUsers(postgres.database, String(user.id));
    assert.notEqual(rows.rows[0].lastSeen, 'هنوز متصل نشده');
  });

  it('validates reports and requires a live mobile session', async () => {
    const user = await register();
    assert.equal((await presence('', true, 1)).code, 401);
    assert.equal((await presence(adminToken, true, 1)).code, 401);
    assert.equal((await request('/api/mobile?action=presence', 'POST', user.token, { connected: 'true', sequence: 1 })).code, 400);
    assert.equal((await request('/api/mobile?action=presence', 'POST', user.token, { connected: true })).code, 400);
    assert.equal((await presence(user.token, true, -1)).code, 400);
    assert.equal((await presence(user.token, true, 1.5)).code, 400);
    await postgres.database.query("UPDATE app_user_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE token = $1", [user.token]);
    assert.equal((await presence(user.token, true, 1)).code, 401);
    assert.equal(await status(user.id), 'آفلاین');
  });

  it('uses the authenticated session owner and ignores a claimed user id', async () => {
    const first = await register();
    const second = await register();
    await request('/api/mobile?action=presence', 'POST', first.token, { connected: true, sequence: 1, userId: second.id });
    assert.equal(await status(first.id), 'آنلاین');
    assert.equal(await status(second.id), 'آفلاین');
  });

  it('makes the status read-only when an administrator edits an account', async () => {
    const user = await register();
    const edit = { name: 'نام جدید', username: user.identity, plan: 'پایه', status: 'آنلاین' };
    const offline = await request('/api/users?id=' + user.id, 'PATCH', adminToken, edit);
    assert.equal(offline.code, 200);
    assert.equal(offline.body.status, 'آفلاین');
    await presence(user.token, true, 1);
    const online = await request('/api/users?id=' + user.id, 'PATCH', adminToken, { ...edit, status: 'آفلاین' });
    assert.equal(online.code, 200);
    assert.equal(online.body.status, 'آنلاین');
  });

  it('removes presence when an administrator deletes the user', async () => {
    const user = await register();
    await presence(user.token, true, 1);
    assert.equal((await request('/api/users?id=' + user.id, 'DELETE', adminToken)).code, 200);
    assert.equal((await presence(user.token, true, 2)).code, 401);
  });

  it('never presents sample or legacy status flags as a live VPN connection', async () => {
    await postgres.database.query("UPDATE users SET status = 'آنلاین' WHERE password_hash IS NULL");
    const rows = await selectUsers(postgres.database);
    const samples = rows.rows.filter(row => row.username === 'arman.r' || row.username === 'sara.m');
    assert.equal(samples.length, 2);
    assert.ok(samples.every(row => row.status === 'آفلاین'));
  });
});

it('migrates existing accounts and sessions without fabricating an online VPN', async () => {
  const postgres = await createTestDatabase();
  try {
    await postgres.database.query(`
      CREATE TABLE users (
        id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, plan TEXT NOT NULL, last_seen TEXT NOT NULL
      );
      CREATE TABLE app_user_sessions (
        token TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO users (name, username, status, plan, last_seen)
      VALUES ('حساب قبلی', 'legacy.user', 'آنلاین', 'پایه', 'هم‌اکنون');
      INSERT INTO app_user_sessions (token, user_id, expires_at)
      VALUES ('legacy-token', 1, NOW() + INTERVAL '1 day');
    `);
    await initializeSchema(postgres.database);
    const user = (await selectUsers(postgres.database)).rows[0];
    assert.equal(user.username, 'legacy.user');
    assert.equal(user.status, 'آفلاین');
    const session = await postgres.database.query('SELECT * FROM app_user_sessions WHERE token = $1', ['legacy-token']);
    assert.equal(session.rows[0].vpn_connected, false);
    assert.equal(session.rows[0].expires_at, null);
    assert.equal(Number(session.rows[0].vpn_sequence), 0);
    await initializeSchema(postgres.database);
    assert.equal((await selectUsers(postgres.database)).rows.length, 1);
  } finally { await postgres.close(); }
});
