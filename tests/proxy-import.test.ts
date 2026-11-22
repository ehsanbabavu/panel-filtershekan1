import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { createApiHandler } from '../api/[...path]';
import { initializeSchema } from '../server/database';
import { importProxies } from '../server/proxyImport';
import { MAX_PROXY_IMPORT_BYTES, MAX_PROXY_IMPORT_ROWS, parseProxyImport } from '../shared/proxyImport';
import { createTestDatabase } from './database';

const sample = '203.0.113.10:80:example-user-1:example-password\n203.0.113.11:1080:example-user-2:another-password';

it('parses TXT in line order, tolerates BOM and empty lines, and preserves credentials', () => {
  assert.deepEqual(parseProxyImport('\uFEFF\r\n' + sample.replace('\n', '\r\n\r\n') + '\r\n'), [
    { host: '203.0.113.10', port: 80, username: 'example-user-1', password: 'example-password' },
    { host: '203.0.113.11', port: 1080, username: 'example-user-2', password: 'another-password' },
  ]);
  assert.deepEqual(parseProxyImport('[2001:db8::1]:1080:user:pass:with:colons '), [
    { host: '2001:db8::1', port: 1080, username: 'user', password: 'pass:with:colons ' },
  ]);
  assert.deepEqual(parseProxyImport('proxy.example:1080::'), [{ host: 'proxy.example', port: 1080, username: '', password: '' }]);
});

it('rejects malformed fields, reports the original line number, and enforces upload limits', () => {
  for (const line of ['missing-fields', 'host:0:user:pass', 'host:65536:user:pass', 'host:8.5:user:pass',
    'host:1e2:user:pass', 'bad host:80:user:pass', `host:80:user:${'p'.repeat(513)}`, 'host:80:user:bad\u0000password']) {
    assert.throws(() => parseProxyImport('203.0.113.10:80:user:pass\n\n' + line), /خط ۳:/);
  }
  for (const content of [undefined, {}, '', '\uFEFF\n \r\n']) assert.throws(() => parseProxyImport(content));
  assert.throws(() => parseProxyImport('x'.repeat(MAX_PROXY_IMPORT_BYTES + 1)), /حجم/);
  assert.throws(() => parseProxyImport('host:80:u:p\n'.repeat(MAX_PROXY_IMPORT_ROWS + 1)), /۱۰٬۰۰۰/);
});

describe('TXT import through the authenticated panel API with real PostgreSQL SQL', () => {
  let postgres: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: Server;
  let base: string;
  const token = 'proxy-import-test-token';

  async function request(path: string, method = 'GET', content?: unknown, auth = token) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(content === undefined ? {} : { body: JSON.stringify({ content }) }),
    });
    return { code: response.status, body: await response.json() };
  }

  before(async () => {
    postgres = await createTestDatabase();
    await initializeSchema(postgres.database);
    await postgres.database.query(`INSERT INTO sessions(token,admin_username,expires_at)
      SELECT $1,username,NOW()+INTERVAL '1 hour' FROM admins LIMIT 1`, [token]);
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use(createApiHandler(postgres.database, async () => {}));
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => { await postgres.database.query('DELETE FROM proxy_servers'); });
  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (postgres) await postgres.close();
  });

  it('appends in file order and leaves every existing record unchanged, including inactive servers', async () => {
    await postgres.database.query(`INSERT INTO proxy_servers(name,host,port,username,password,active)
      VALUES('ساکس ۷','198.51.100.1',9000,'old-user','old-password',FALSE),
        ('سرور قدیمی','198.51.100.2',9001,'another-user','another-password',TRUE)`);
    const before = await request('/api/proxies');
    const imported = await request('/api/proxies/import', 'POST', sample);
    assert.equal(imported.code, 201);
    assert.equal(imported.body.count, 2);
    assert.deepEqual(imported.body.proxies.map((proxy: any) => proxy.name), ['ساکس 8', 'ساکس 9']);
    const after = await request('/api/proxies');
    assert.deepEqual(after.body.slice(0, 2), before.body);
    assert.deepEqual(after.body.slice(2).map((proxy: any) => [proxy.host, proxy.port, proxy.username, proxy.password, proxy.active]), [
      ['203.0.113.10', 80, 'example-user-1', 'example-password', true],
      ['203.0.113.11', 1080, 'example-user-2', 'another-password', true],
    ]);
    assert.deepEqual((await request('/api/proxies')).body, after.body);
  });

  it('starts at one for an empty list and continues numbering when the same file is uploaded again', async () => {
    assert.equal((await request('/api/proxies/import', 'POST', sample)).code, 201);
    assert.equal((await request('/api/proxies/import', 'POST', sample)).code, 201);
    const rows = (await request('/api/proxies')).body;
    assert.deepEqual(rows.map((proxy: any) => proxy.name), ['ساکس 1', 'ساکس 2', 'ساکس 3', 'ساکس 4']);
    assert.deepEqual(rows.map((proxy: any) => proxy.host), ['203.0.113.10', '203.0.113.11', '203.0.113.10', '203.0.113.11']);
    assert.equal(new Set(rows.map((proxy: any) => proxy.id)).size, 4);
  });

  it('does not insert any lines of an invalid file or accept missing/expired authentication', async () => {
    for (const content of [sample + '\ninvalid-line', ' ', {}, 'host:0:user:pass']) {
      const result = await request('/api/proxies/import', 'POST', content);
      assert.equal(result.code, 400);
      assert.deepEqual((await request('/api/proxies')).body, []);
    }
    for (const auth of ['', 'expired-token']) {
      assert.equal((await request('/api/proxies/import', 'POST', sample, auth)).code, 401);
    }
    assert.deepEqual((await request('/api/proxies')).body, []);
  });

  it('accepts a TXT larger than the default Express 100 KB body limit', async () => {
    const content = 'proxy.example:1080:user:example-password\n'.repeat(3000);
    assert.ok(content.length > 100 * 1024);
    const result = await request('/api/proxies/import', 'POST', content);
    assert.equal(result.code, 201);
    assert.equal(result.body.count, 3000);
    assert.equal(result.body.proxies[2999].name, 'ساکس 3000');
  });

  it('rolls back a database failure and can import successfully afterward', async () => {
    await postgres.database.query("ALTER TABLE proxy_servers ADD CONSTRAINT reject_test_host CHECK(host <> '203.0.113.11')");
    try {
      await assert.rejects(importProxies(postgres.database, sample), /reject_test_host/);
      assert.deepEqual((await request('/api/proxies')).body, []);
    } finally { await postgres.database.query('ALTER TABLE proxy_servers DROP CONSTRAINT reject_test_host'); }
    const result = await request('/api/proxies/import', 'POST', sample);
    assert.equal(result.code, 201);
    assert.deepEqual(result.body.proxies.map((proxy: any) => proxy.name), ['ساکس 1', 'ساکس 2']);
  });

  it('keeps simultaneous uploads in contiguous blocks with unique sequential names', async () => {
    const results = await Promise.all([
      request('/api/proxies/import', 'POST', sample),
      request('/api/proxies/import', 'POST', '198.51.100.10:80:user-a:pass-a\n198.51.100.11:80:user-b:pass-b'),
    ]);
    assert.ok(results.every(result => result.code === 201));
    const rows = (await request('/api/proxies')).body;
    assert.deepEqual(rows.map((proxy: any) => proxy.name), ['ساکس 1', 'ساکس 2', 'ساکس 3', 'ساکس 4']);
    const hosts = rows.map((proxy: any) => proxy.host);
    assert.ok(hosts.join(',') === '203.0.113.10,203.0.113.11,198.51.100.10,198.51.100.11' ||
      hosts.join(',') === '198.51.100.10,198.51.100.11,203.0.113.10,203.0.113.11');
  });
});
