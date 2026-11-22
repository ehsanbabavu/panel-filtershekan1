import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { createApiHandler } from '../api/[...path]';
import { initializeSchema } from '../server/database';
import { readApiResponse } from '../client/src/apiResponse';
import { createTestDatabase } from './database';

it('handles non-JSON platform errors without exposing a JSON parser exception', async () => {
  await assert.rejects(readApiResponse(new Response('The page could not be found', { status: 404 })), error => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof SyntaxError));
    assert.match(error.message, /HTTP 404/);
    return true;
  });
  assert.deepEqual(await readApiResponse(new Response('{"count":2}')), { count: 2 });
});

describe('authenticated bulk SOCKS operations with real PostgreSQL SQL', () => {
  let postgres: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: Server;
  let base: string;
  let rows: any[];
  const token = 'proxy-bulk-test-token';

  async function request(method: string, body: unknown, auth = token) {
    const response = await fetch(base + '/api/proxies/bulk', {
      method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    return { code: response.status, body: await response.json() };
  }
  async function list() { return (await postgres.database.query('SELECT * FROM proxy_servers ORDER BY id')).rows; }

  before(async () => {
    postgres = await createTestDatabase();
    await initializeSchema(postgres.database);
    await postgres.database.query(`INSERT INTO sessions(token,admin_username,expires_at)
      SELECT $1,username,NOW()+INTERVAL '1 hour' FROM admins LIMIT 1`, [token]);
    const app = express();
    app.use('/api/proxies/bulk', express.json({ limit: '1mb' }));
    app.use(express.json());
    app.use(createApiHandler(postgres.database, async () => {}));
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    await postgres.database.query('DELETE FROM proxy_servers');
    await postgres.database.query(`INSERT INTO proxy_servers(name,host,port,username,password,active)
      VALUES('ساکس 1','198.51.100.1',1080,'user-1','password-1',TRUE),
        ('ساکس 2','198.51.100.2',1081,'user-2','password-2',FALSE),
        ('ساکس 3','198.51.100.3',1082,'user-3','password-3',TRUE)`);
    rows = await list();
  });
  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (postgres) await postgres.close();
  });

  it('deactivates and activates only selected records while preserving their credentials and order', async () => {
    const ids = [rows[0].id, rows[1].id];
    for (const active of [false, true]) {
      const result = await request('PATCH', { ids, active });
      assert.equal(result.code, 200);
      assert.equal(result.body.count, 2);
      const after = await list();
      assert.deepEqual(after[2], rows[2]);
      for (const index of [0, 1]) {
        assert.equal(after[index].active, active);
        const { active: previousActive, updated_at: previousUpdate, ...previous } = rows[index];
        const { active: nextActive, updated_at: nextUpdate, ...next } = after[index];
        assert.deepEqual(next, previous);
      }
    }
  });

  it('deletes only the selected IDs and counts duplicate IDs once', async () => {
    const result = await request('DELETE', { ids: [rows[0].id, rows[2].id, Number(rows[0].id)] });
    assert.equal(result.code, 200);
    assert.equal(result.body.count, 2);
    assert.deepEqual(new Set(result.body.ids), new Set([String(rows[0].id), String(rows[2].id)]));
    assert.deepEqual(await list(), [rows[1]]);
  });

  it('validates the complete selection and never updates or deletes on malformed input', async () => {
    const invalidIds = [[], 'all', [null], [true], [''], ['0'], [-1], [1.5], ['1 OR 1=1'], ['9223372036854775808'],
      [rows[0].id, 'invalid'], Array(10001).fill(rows[0].id)];
    for (const method of ['PATCH', 'DELETE']) {
      for (const ids of invalidIds) {
        assert.equal((await request(method, { ids, active: false })).code, 400);
      }
      assert.deepEqual(await list(), rows);
    }
    for (const active of [undefined, 'false', 0, null]) {
      assert.equal((await request('PATCH', { ids: [rows[0].id], active })).code, 400);
    }
    assert.deepEqual(await list(), rows);
  });

  it('requires a live administrator session and rejects unsupported methods', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      for (const auth of ['', 'expired-token']) assert.equal((await request(method, { ids: [rows[0].id], active: false }, auth)).code, 401);
    }
    assert.equal((await request('POST', { ids: [rows[0].id] })).code, 405);
    assert.equal((await request('GET', undefined)).code, 405);
    assert.deepEqual(await list(), rows);
  });

  it('ignores stale IDs without touching unrelated records', async () => {
    const result = await request('PATCH', { ids: [rows[0].id, '9223372036854775807'], active: false });
    assert.equal(result.code, 200);
    assert.equal(result.body.count, 1);
    const after = await list();
    assert.equal(after[0].active, false);
    assert.deepEqual(after.slice(1), rows.slice(1));
  });

  it('accepts a full 10,000-ID selection larger than the default Express JSON limit', async () => {
    const ids = Array.from({ length: 10000 }, (_, index) => String(9000000000000000000n + BigInt(index)));
    const result = await request('PATCH', { ids, active: false });
    assert.equal(result.code, 200);
    assert.equal(result.body.count, 0);
    assert.deepEqual(await list(), rows);
  });

  it('keeps a multi-row change atomic if one row violates a database constraint', async () => {
    await postgres.database.query("ALTER TABLE proxy_servers ADD CONSTRAINT protect_test_proxy CHECK(host <> '198.51.100.3' OR active)");
    try {
      const result = await request('PATCH', { ids: [rows[0].id, rows[2].id], active: false });
      assert.equal(result.code, 503);
      assert.deepEqual(await list(), rows);
    } finally { await postgres.database.query('ALTER TABLE proxy_servers DROP CONSTRAINT protect_test_proxy'); }
  });
});
