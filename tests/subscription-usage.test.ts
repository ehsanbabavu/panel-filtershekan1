import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { createApiHandler } from '../api/[...path]';
import { initializeSchema } from '../server/database';
import { createMobileHandler } from '../server/mobile';
import { reportPresence } from '../server/presence';
import { createSubscriptionUsageResetHandler } from '../server/subscriptionUsage';
import { createTestDatabase } from './database';

describe('subscription usage reset through the authenticated HTTP API', () => {
  let postgres: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: Server;
  let base: string;
  let user: any;
  let current: any;
  let history: any[];
  const adminToken = 'usage-reset-admin';
  const mobileToken = 'usage-reset-mobile';

  async function request(body: unknown, token = adminToken, method = 'POST') {
    const response = await fetch(base + '/api/user-subscriptions/reset-usage', {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    return { code: response.status, headers: response.headers, body: await response.json() };
  }
  async function account() {
    return (await postgres.database.query<any>('SELECT * FROM users WHERE id=$1', [user.id])).rows[0];
  }
  async function subscriptions() {
    return (await postgres.database.query<any>('SELECT * FROM user_subscriptions WHERE user_id=$1 ORDER BY id', [user.id])).rows;
  }
  async function usage() {
    return (await fetch(base + '/api/mobile?action=usage', { headers: { Authorization: 'Bearer ' + mobileToken } })).json();
  }

  before(async () => {
    postgres = await createTestDatabase();
    await initializeSchema(postgres.database);
    await postgres.database.query(`INSERT INTO sessions(token,admin_username,expires_at)
      SELECT $1,username,NOW()+INTERVAL '1 hour' FROM admins LIMIT 1`, [adminToken]);
    const app = express();
    app.use(express.json());
    app.all('/api/mobile', createMobileHandler(postgres.database, async () => {}));
    app.use(createApiHandler(postgres.database, async () => {}));
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = 'http://127.0.0.1:' + address.port;
  });
  beforeEach(async () => {
    await postgres.database.query("DELETE FROM users WHERE username='reset.test'");
    user = (await postgres.database.query<any>(`INSERT INTO users(name,username,status,plan,last_seen,
      subscription_started_at,subscription_expires_at,subscription_quota_bytes,subscription_used_bytes)
      VALUES('کاربر ریست','reset.test','آفلاین','حرفه‌ای','هنوز متصل نشده',NOW(),NOW()+INTERVAL '10 days',1000,600) RETURNING *`)).rows[0];
    const plan = (await postgres.database.query<any>("SELECT id FROM subscription_plans WHERE name='حرفه‌ای'")).rows[0];
    await postgres.database.query(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes,status)
      VALUES($1,$2,NOW()-INTERVAL '40 days',NOW()-INTERVAL '10 days',1000,900,'expired'),
        ($1,$2,NOW()-INTERVAL '2 days',NOW()+INTERVAL '5 days',1000,800,'cancelled')`, [user.id, plan.id]);
    history = await subscriptions();
    current = (await postgres.database.query<any>(`INSERT INTO user_subscriptions(user_id,plan_id,started_at,expires_at,quota_bytes,used_bytes)
      SELECT id,$2,subscription_started_at,subscription_expires_at,1000,600 FROM users WHERE id=$1
      RETURNING *`, [user.id, plan.id])).rows[0];
    await postgres.database.query('INSERT INTO app_user_sessions(token,user_id) VALUES($1,$2)', [mobileToken, user.id]);
    await postgres.database.query('INSERT INTO mobile_usage_reports(user_id,token,sequence,cumulative_bytes) VALUES($1,$2,1,600)', [user.id, mobileToken]);
  });
  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (postgres) await postgres.close();
  });

  it('requires a live administrator session, not a mobile session', async () => {
    for (const token of ['', 'invalid', mobileToken]) assert.equal((await request({ userId: user.id }, token)).code, 401);
    await postgres.database.query(`INSERT INTO sessions(token,admin_username,expires_at)
      SELECT 'expired-reset-admin',username,NOW()-INTERVAL '1 second' FROM admins LIMIT 1`);
    assert.equal((await request({ userId: user.id }, 'expired-reset-admin')).code, 401);
    assert.deepEqual(await account(), user);
  });

  it('validates identifiers and supports only POST', async () => {
    for (const userId of [undefined, null, true, [], {}, '', 'invalid', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await request({ userId })).code, 400);
    }
    assert.equal((await request({}, adminToken, 'GET')).code, 405);
    assert.deepEqual(await account(), user);
  });

  it('does not reset missing users or accounts without an assigned subscription', async () => {
    assert.equal((await request({ userId: 99999999 })).code, 404);
    await postgres.database.query('UPDATE users SET subscription_started_at=NULL WHERE id=$1', [user.id]);
    assert.equal((await request({ userId: user.id })).code, 404);
    assert.equal((await account()).subscription_used_bytes, 600);
  });

  it('zeros only current consumption and preserves quota, dates, history and other accounts', async () => {
    const others = await postgres.database.query('SELECT * FROM users WHERE id<>$1 ORDER BY id', [user.id]);
    const result = await request({ userId: user.id, quotaBytes: 999999, blocked: true });
    assert.equal(result.code, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.body.usedBytes, '0');
    assert.equal(result.body.quotaBytes, '1000');
    assert.equal(result.body.active, true);
    assert.deepEqual(await account(), { ...user, subscription_used_bytes: 0 });
    assert.deepEqual(await subscriptions(), [...history, { ...current, used_bytes: 0 }]);
    assert.deepEqual(await postgres.database.query('SELECT * FROM users WHERE id<>$1 ORDER BY id', [user.id]), others);
    assert.equal((await usage()).subscriptionUsedBytes, '0');
  });

  it('restores exhausted subscriptions while keeping expired and blocked accounts restricted', async () => {
    await postgres.database.query('UPDATE users SET subscription_used_bytes=1000 WHERE id=$1', [user.id]);
    await postgres.database.query("UPDATE user_subscriptions SET used_bytes=1000,status='exhausted' WHERE id=$1", [current.id]);
    assert.equal((await usage()).canConnect, false);
    assert.equal((await request({ userId: user.id })).body.active, true);
    assert.equal((await usage()).canConnect, true);
    assert.equal((await subscriptions()).at(-1).status, 'active');
    await postgres.database.query('UPDATE users SET blocked=TRUE WHERE id=$1', [user.id]);
    assert.equal((await request({ userId: user.id })).body.blocked, true);
    assert.equal((await usage()).canConnect, false);
    await postgres.database.query("UPDATE users SET blocked=FALSE,subscription_expires_at=NOW()-INTERVAL '1 day' WHERE id=$1", [user.id]);
    await postgres.database.query('UPDATE user_subscriptions SET expires_at=(SELECT subscription_expires_at FROM users WHERE id=$1) WHERE id=$2', [user.id, current.id]);
    assert.equal((await request({ userId: user.id })).body.active, false);
    assert.equal((await usage()).canConnect, false);
    assert.equal((await subscriptions()).at(-1).status, 'expired');
  });

  it('retains device baselines so repeated heartbeats cannot reintroduce old usage', async () => {
    const baseline = await postgres.database.query('SELECT * FROM mobile_usage_reports WHERE user_id=$1', [user.id]);
    assert.equal((await request({ userId: user.id })).code, 200);
    assert.deepEqual(await postgres.database.query('SELECT * FROM mobile_usage_reports WHERE user_id=$1', [user.id]), baseline);
    await reportPresence(postgres.database, mobileToken, true, 2, 600);
    assert.equal((await account()).subscription_used_bytes, 0);
    await reportPresence(postgres.database, mobileToken, true, 3, 650);
    assert.equal((await account()).subscription_used_bytes, 50);
    await reportPresence(postgres.database, mobileToken, true, 3, 650);
    assert.equal((await account()).subscription_used_bytes, 50);
    assert.equal((await request({ userId: user.id })).code, 200);
    await reportPresence(postgres.database, mobileToken, true, 4, 675);
    assert.equal((await account()).subscription_used_bytes, 25);
  });

  it('is idempotent and creates no new subscriptions', async () => {
    await request({ userId: user.id });
    const first = await subscriptions();
    assert.equal((await request({ userId: user.id })).code, 200);
    assert.deepEqual(await subscriptions(), first);
  });

  it('matches the current subscription with PostgreSQL timestamp precision', async () => {
    await postgres.database.query(`UPDATE users SET subscription_started_at=date_trunc('second',subscription_started_at)+INTERVAL '123456 microseconds',
      subscription_expires_at=date_trunc('second',subscription_expires_at)+INTERVAL '654321 microseconds' WHERE id=$1`, [user.id]);
    await postgres.database.query(`UPDATE user_subscriptions s SET started_at=u.subscription_started_at,expires_at=u.subscription_expires_at
      FROM users u WHERE s.id=$1 AND u.id=s.user_id`, [current.id]);
    assert.equal((await request({ userId: user.id })).code, 200);
    assert.equal((await subscriptions()).at(-1).used_bytes, 0);
  });

  it('rolls back the account reset if updating the subscription record fails', async () => {
    const faultyDatabase = { ...postgres.database, connect: async () => {
      const client = await postgres.database.connect();
      return { release: () => client.release(), query: async (sql: string, values?: any[]) => {
        if (sql.startsWith('UPDATE user_subscriptions')) throw new Error('Simulated subscription update failure');
        return client.query(sql, values);
      } };
    } } as typeof postgres.database;
    await assert.rejects(createSubscriptionUsageResetHandler(faultyDatabase)({ method: 'POST', body: { userId: user.id } }, {}), /Simulated/);
    assert.deepEqual(await account(), user);
    assert.deepEqual(await subscriptions(), [...history, current]);
  });
});
