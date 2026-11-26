import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { createApiHandler } from '../api/[...path]';
import { initializeSchema } from '../server/database';
import { createMobileHandler } from '../server/mobile';
import { createTelegramHandler } from '../server/telegram';
import { createTestDatabase } from './database';
import { decryptUserPassword, encryptUserPassword } from '../server/userPassword';

describe('Telegram identity linking and live subscription status through HTTP', () => {
  let postgres: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: Server, base: string, userA: string, userB: string, updateId: number;
  const botId = 123456789, telegramId = 456789, secret = 'telegram-link-test-secret';
  const tokenA = 'telegram-link-mobile-a', tokenB = 'telegram-link-mobile-b', adminToken = 'telegram-link-admin';
  const passwordA = 'Test<&رمز-123', passwordB = 'other-account-password';
  const previousKey = process.env.USER_PASSWORD_ENCRYPTION_KEY;
  let passwordHashA: string, passwordHashB: string;
  const db = () => postgres.database;
  const hash = (code: string) => createHash('sha256').update(code).digest('hex');
  async function request(path: string, method = 'GET', body?: unknown, token = tokenA) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  function update(text: string, id = ++updateId, sender = telegramId, extra: any = {}) {
    return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000),
      chat: { id: sender, type: 'private' }, from: { id: sender, first_name: 'کاربر تلگرام', username: 'linked_person' }, text, ...extra } };
  }
  async function webhook(body: any) {
    const response = await fetch(base + '/api/telegram?action=webhook', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function issue(sender = telegramId) {
    const body = update('اتصال به برنامه', ++updateId, sender);
    const result = await webhook(body);
    assert.equal(result.status, 200);
    const code = result.body.text.match(/<code>(Ariya[A-Za-z0-9]{10})<\/code>/)?.[1];
    assert.ok(code);
    return { code, update: body };
  }
  const link = (code: string, token = tokenA, extra: any = {}) => request('/api/mobile?action=telegram-link', 'POST', { code, ...extra }, token);
  const status = (sender = telegramId) => webhook(update('وضعیت اشتراک', ++updateId, sender));
  before(async () => {
    process.env.USER_PASSWORD_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    passwordHashA = await bcrypt.hash(passwordA, 10); passwordHashB = await bcrypt.hash(passwordB, 10);
    postgres = await createTestDatabase();
    await initializeSchema(db());
    const users = (await db().query<any>(`INSERT INTO users(name,username,status,plan,last_seen)
      VALUES('حساب اول','telegram.account.a','آفلاین','حرفه‌ای','هنوز متصل نشده'),
      ('حساب دوم','telegram.account.b','آفلاین','پایه','هنوز متصل نشده') RETURNING id`)).rows;
    userA = String(users[0].id); userB = String(users[1].id);
    await db().query('INSERT INTO app_user_sessions(token,user_id) VALUES($1,$2),($3,$4)', [tokenA, userA, tokenB, userB]);
    await db().query(`INSERT INTO sessions(token,admin_username,expires_at)
      SELECT $1,username,NOW()+INTERVAL '1 hour' FROM admins LIMIT 1`, [adminToken]);
    const app = express(); app.use(express.json());
    app.all('/api/mobile', createMobileHandler(db(), async () => {}));
    app.all('/api/telegram', createTelegramHandler(db(), async () => {}, (async () => { throw Error('No real Telegram requests expected'); }) as typeof fetch));
    app.use('/fallback', createApiHandler(db(), async () => {}));
    app.use(createApiHandler(db(), async () => {}));
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = 'http://127.0.0.1:' + address.port;
  });
  beforeEach(async () => {
    updateId = 1000;
    await db().query('DELETE FROM telegram_connection_codes; DELETE FROM telegram_user_links; DELETE FROM telegram_webhook_updates');
    await db().query(`UPDATE telegram_settings SET bot_id=$1,bot_username='panel_link_test_bot',enabled=TRUE,webhook_secret=$2 WHERE id=1`, [botId, secret]);
    await db().query(`UPDATE users SET blocked=FALSE,subscription_started_at=NOW(),subscription_expires_at=NOW()+INTERVAL '7 days',
      subscription_quota_bytes=10737418240,subscription_used_bytes=2147483648 WHERE id=ANY($1::bigint[])`, [[userA, userB]]);
    await db().query('UPDATE app_user_sessions SET expires_at=NULL WHERE token=ANY($1::text[])', [[tokenA, tokenB]]);
    await db().query('UPDATE users SET password_hash=$2,password_encrypted=$3 WHERE id=$1', [userA, passwordHashA, encryptUserPassword(passwordA, passwordHashA)]);
    await db().query('UPDATE users SET password_hash=$2,password_encrypted=$3 WHERE id=$1', [userB, passwordHashB, encryptUserPassword(passwordB, passwordHashB)]);
  });
  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (postgres) await postgres.close();
    if (previousKey === undefined) delete process.env.USER_PASSWORD_ENCRYPTION_KEY;
    else process.env.USER_PASSWORD_ENCRYPTION_KEY = previousKey;
  });

  it('stores only a hash, gives codes ten minutes, and preserves the code on duplicate webhook delivery', async () => {
    const { code, update } = await issue();
    const pending = (await db().query<any>('SELECT * FROM telegram_connection_codes')).rows[0];
    assert.equal(pending.code_hash, hash(code));
    assert.ok(!JSON.stringify(pending).includes(code));
    assert.equal(String(pending.telegram_user_id), String(telegramId));
    const lifetime = new Date(pending.expires_at).getTime() - new Date(pending.created_at).getTime();
    assert.equal(lifetime, 600000);
    assert.deepEqual((await webhook(update)).body, { ok: true });
    assert.equal((await db().query<any>('SELECT code_hash FROM telegram_connection_codes')).rows[0].code_hash, hash(code));
    assert.equal((await link(code)).status, 200);
  });

  it('links the authenticated app account, ignores a claimed user ID, and exposes the identity in the admin user list', async () => {
    const { code } = await issue();
    const linked = await link(code, tokenA, { userId: userB, telegramId: 999 });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.telegram.id, String(telegramId));
    assert.equal(linked.body.telegram.username, 'linked_person');
    assert.ok(linked.body.telegram.linkedAt);
    const users = await request('/api/users', 'GET', undefined, adminToken);
    const a = users.body.find((user: any) => String(user.id) === userA), b = users.body.find((user: any) => String(user.id) === userB);
    assert.equal(a.telegramId, String(telegramId)); assert.equal(a.telegramUsername, 'linked_person');
    assert.equal(b.telegramId, null);
    const saved = await request('/api/mobile?action=telegram-link');
    assert.equal(saved.body.telegram.id, String(telegramId));
    assert.equal(saved.body.botUrl, 'https://t.me/panel_link_test_bot');
  });

  it('rejects missing, admin, unknown and expired mobile sessions without consuming the code', async () => {
    const { code } = await issue();
    for (const token of ['', adminToken, 'unknown']) {
      assert.equal((await link(code, token)).status, 401);
      assert.equal((await request('/api/mobile?action=telegram-link', 'GET', undefined, token)).status, 401);
    }
    await db().query("UPDATE app_user_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE token=$1", [tokenB]);
    assert.equal((await link(code, tokenB)).status, 401);
    assert.equal((await link(code)).status, 200);
  });

  it('rejects malformed, expired and consumed codes and supports path-style routing', async () => {
    for (const code of ['12345', 'ariya1234567890', 'Ariya123456789!', '', 'Ariya12345678900']) assert.equal((await link(code)).status, 400);
    const first = await issue();
    await db().query("UPDATE telegram_connection_codes SET expires_at=NOW()-INTERVAL '1 second' WHERE code_hash=$1", [hash(first.code)]);
    assert.equal((await link(first.code)).status, 400);
    const second = await issue();
    assert.equal((await request('/fallback/api/mobile/telegram-link', 'POST', { code: second.code })).status, 200);
    assert.equal((await link(second.code, tokenB)).status, 400);
    assert.equal((await link(second.code)).status, 400);
    assert.equal((await request('/api/mobile?action=telegram-link', 'PUT', {})).status, 405);
  });

  it('invalidates the old code when another code is requested for the same Telegram identity', async () => {
    const first = await issue(), second = await issue();
    assert.notEqual(first.code, second.code);
    assert.equal((await db().query('SELECT 1 FROM telegram_connection_codes')).rows.length, 1);
    assert.equal((await link(first.code)).status, 400);
    assert.equal((await link(second.code)).status, 200);
  });

  it('reports a successful connection instead of issuing another code for an already linked account', async () => {
    const { code } = await issue();
    assert.equal((await link(code)).status, 200);
    const message = update('اتصال به برنامه');
    const result = await webhook(message);
    assert.equal(result.body.text, 'ربات با موفقیت متصل شد');
    assert.equal(result.body.parse_mode, undefined);
    assert.ok(result.body.reply_markup.keyboard.flat().some((button: any) => button.text === 'وضعیت اشتراک'));
    assert.equal((await db().query('SELECT 1 FROM telegram_connection_codes')).rows.length, 0);
    assert.deepEqual((await webhook(message)).body, { ok: true });
    assert.equal((await webhook(update('اتصال به برنامه'))).body.text, 'ربات با موفقیت متصل شد');
    // A link belonging to a different configured bot must not count as connected.
    await db().query('UPDATE telegram_settings SET bot_id=999 WHERE id=1');
    assert.ok((await issue()).code);
  });

  it('refuses to transfer a Telegram identity even if a pending code exists, and rolls back its code', async () => {
    assert.equal((await link((await issue()).code)).status, 200);
    const code = 'AriyaAb12Cd34Ef';
    await db().query(`INSERT INTO telegram_connection_codes(code_hash,bot_id,update_id,telegram_user_id,expires_at)
      VALUES($1,$2,$3,$4,NOW()+INTERVAL '10 minutes')`, [hash(code), botId, ++updateId, telegramId]);
    assert.equal((await link(code, tokenB)).status, 409);
    assert.equal((await request('/api/mobile?action=telegram-link', 'GET', undefined, tokenB)).body.telegram, null);
    assert.equal((await link(code)).status, 200);
  });

  it('allows replacing the current account link and immediately removes subscription access from the old Telegram identity', async () => {
    assert.equal((await link((await issue()).code)).status, 200);
    assert.equal((await link((await issue(777888)).code)).status, 200);
    assert.match((await status()).body.text, /هنوز حساب برنامه/);
    assert.match((await status(777888)).body.text, /حساب اول/);
  });

  it('isolates codes by the active configured bot and refuses codes when the bot is disabled', async () => {
    const { code } = await issue();
    await db().query('UPDATE telegram_settings SET bot_id=999 WHERE id=1');
    assert.equal((await link(code)).status, 400);
    await db().query('UPDATE telegram_settings SET bot_id=$1,enabled=FALSE WHERE id=1', [botId]);
    assert.equal((await link(code)).status, 400);
  });

  it('shows current subscription data for only the linked account and refreshes the Telegram username', async () => {
    assert.match((await status()).body.text, /هنوز حساب برنامه/);
    assert.equal((await link((await issue()).code)).status, 200);
    const result = await webhook(update('وضعیت اشتراک', ++updateId, telegramId, { from: { id: telegramId, first_name: 'نام تازه', username: 'renamed_person' } }));
    for (const expected of [/حساب اول/, /telegram.account.a/, /حرفه‌ای/, /وضعیت: فعال/, /حجم کل: ۱۰ گیگابایت/, /مصرف‌شده: ۲ گیگابایت/, /باقی‌مانده: ۸ گیگابایت/, /شروع:/, /پایان:/, /روزهای باقی‌مانده:/, /هم‌زمان: ۵/]) assert.match(result.body.text, expected);
    assert.ok(!result.body.text.includes('حساب دوم'));
    assert.ok(!result.body.text.includes(passwordB));
    assert.ok(result.body.text.includes(`نام کاربری: telegram.account.a\n\nرمز عبور: ${passwordA}\n\nپلن:`));
    assert.equal(result.body.text.split('\n\n').length, 13);
    assert.ok(result.body.text.split('\n\n').every((part: string) => !part.includes('\n')));
    assert.equal(result.body.parse_mode, undefined);
    assert.equal((await request('/api/mobile?action=telegram-link')).body.telegram.username, 'renamed_person');
    await db().query('UPDATE users SET subscription_used_bytes=3221225472 WHERE id=$1', [userA]);
    assert.match((await status()).body.text, /مصرف‌شده: ۳ گیگابایت/);
    assert.match((await status(123999)).body.text, /هنوز حساب برنامه/);
  });

  it('captures legacy passwords only after successful login and keeps them out of ordinary API responses', async () => {
    await db().query('UPDATE users SET password_encrypted=NULL WHERE id=$1', [userA]);
    assert.equal((await link((await issue()).code)).status, 200);
    const missing = (await status()).body.text;
    assert.match(missing, /رمز عبور: برای نمایش رمز/);
    assert.ok(!missing.includes(passwordHashA));
    assert.equal((await request('/api/mobile?action=login', 'POST', { identity: 'telegram.account.a', password: 'incorrect' }, '')).status, 401);
    assert.equal((await db().query<any>('SELECT password_encrypted FROM users WHERE id=$1', [userA])).rows[0].password_encrypted, null);
    const login = await request('/api/mobile?action=login', 'POST', { identity: 'telegram.account.a', password: passwordA }, '');
    assert.equal(login.status, 200);
    assert.ok(!JSON.stringify(login.body).includes(passwordA));
    assert.ok((await status()).body.text.includes(`رمز عبور: ${passwordA}`));
    const saved = (await db().query<any>('SELECT password_hash,password_encrypted FROM users WHERE id=$1', [userA])).rows[0];
    assert.equal(saved.password_hash, passwordHashA);
    assert.ok(!saved.password_encrypted.includes(passwordA));
    assert.equal(decryptUserPassword(saved.password_encrypted, saved.password_hash), passwordA);
    for (const result of [await request('/api/users', 'GET', undefined, adminToken), await request('/api/mobile?action=me')]) {
      const body = JSON.stringify(result.body);
      assert.ok(!body.includes(passwordA) && !body.includes('password_encrypted') && !body.includes(passwordHashA));
    }
  });

  it('shows the registered password and updates it when an admin changes the account password', async () => {
    const original = 'registration-secret-123', changed = 'changed-secret-456';
    const registered = await request('/api/mobile?action=register', 'POST', { name: 'حساب تازه', identity: 'registered.bot.user', password: original }, '');
    assert.equal(registered.status, 201);
    assert.equal((await link((await issue(888111)).code, registered.body.token)).status, 200);
    assert.ok((await status(888111)).body.text.includes(`رمز عبور: ${original}`));
    const edit = { name: 'حساب تازه', username: 'registered.bot.user', plan: 'پایه' };
    assert.equal((await request('/api/users?id=' + registered.body.id, 'PATCH', { ...edit, password: changed }, adminToken)).status, 200);
    assert.ok((await status(888111)).body.text.includes(`رمز عبور: ${changed}`));
    assert.ok(!(await status(888111)).body.text.includes(original));
    assert.equal((await request('/api/users?id=' + registered.body.id, 'PATCH', { ...edit, password: '' }, adminToken)).status, 200);
    assert.ok((await status(888111)).body.text.includes(`رمز عبور: ${changed}`));
    assert.equal((await request('/api/mobile?action=login', 'POST', { identity: edit.username, password: original }, '')).status, 401);
    assert.equal((await request('/api/mobile?action=login', 'POST', { identity: edit.username, password: changed }, '')).status, 200);
  });

  it('captures passwords for admin-created accounts and clears old copies on password change without a key', async () => {
    const password = 'admin-created-password';
    const body = { name: 'کاربر مدیر', username: 'admin.bot.user', plan: 'پایه', password };
    const created = await request('/api/users', 'POST', body, adminToken);
    assert.equal(created.status, 201);
    const saved = (await db().query<any>('SELECT password_hash,password_encrypted FROM users WHERE id=$1', [created.body.id])).rows[0];
    assert.equal(decryptUserPassword(saved.password_encrypted, saved.password_hash), password);
    const key = process.env.USER_PASSWORD_ENCRYPTION_KEY;
    delete process.env.USER_PASSWORD_ENCRYPTION_KEY;
    try {
      const changed = 'new-password-without-key';
      assert.equal((await request('/api/users?id=' + created.body.id, 'PATCH', { ...body, password: changed }, adminToken)).status, 200);
      const row = (await db().query<any>('SELECT password_hash,password_encrypted FROM users WHERE id=$1', [created.body.id])).rows[0];
      assert.equal(row.password_encrypted, null);
      assert.ok(await bcrypt.compare(changed, row.password_hash));
    } finally { process.env.USER_PASSWORD_ENCRYPTION_KEY = key; }
  });

  it('does not disclose credentials for mismatched hashes, corrupted ciphertext or a different encryption key', async () => {
    const encrypted = encryptUserPassword(passwordA, passwordHashA)!;
    assert.equal(decryptUserPassword(encrypted, passwordHashB), null);
    assert.equal(decryptUserPassword(encrypted + 'a', passwordHashA), null);
    const key = process.env.USER_PASSWORD_ENCRYPTION_KEY;
    process.env.USER_PASSWORD_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    try { assert.equal(decryptUserPassword(encrypted, passwordHashA), null); }
    finally { process.env.USER_PASSWORD_ENCRYPTION_KEY = key; }
  });

  it('does not disclose a linked password in groups, edited messages or mismatched sender identities', async () => {
    assert.equal((await link((await issue()).code)).status, 200);
    for (const extra of [{ chat: { id: -1, type: 'group' } }, { from: { id: telegramId, is_bot: true } }, { from: { id: 333 } }])
      assert.deepEqual((await webhook(update('وضعیت اشتراک', ++updateId, telegramId, extra))).body, { ok: true });
    const edited = update('وضعیت اشتراک');
    assert.deepEqual((await webhook({ update_id: edited.update_id, edited_message: edited.message })).body, { ok: true });
  });

  it('shows blocked, expired, exhausted and missing subscription states without claiming an active subscription', async () => {
    assert.equal((await link((await issue()).code)).status, 200);
    await db().query('UPDATE users SET blocked=TRUE WHERE id=$1', [userA]);
    assert.match((await status()).body.text, /وضعیت: مسدود/);
    await db().query("UPDATE users SET blocked=FALSE,subscription_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [userA]);
    assert.match((await status()).body.text, /وضعیت: منقضی‌شده/);
    await db().query("UPDATE users SET subscription_expires_at=NOW()+INTERVAL '1 day',subscription_used_bytes=subscription_quota_bytes WHERE id=$1", [userA]);
    assert.match((await status()).body.text, /وضعیت: حجم تمام شده/);
    await db().query("UPDATE users SET plan='بدون اشتراک',subscription_expires_at=NULL,subscription_quota_bytes=NULL,subscription_used_bytes=0 WHERE id=$1", [userA]);
    assert.match((await status()).body.text, /وضعیت: بدون اشتراک/);
  });

  it('rolls back the webhook and code invalidation if issuing a new code fails, allowing a safe retry', async () => {
    const first = await issue(), next = update('اتصال به برنامه');
    await db().query('ALTER TABLE telegram_connection_codes ADD CONSTRAINT reject_test_codes CHECK (FALSE) NOT VALID');
    try { assert.equal((await webhook(next)).status, 503); }
    finally { await db().query('ALTER TABLE telegram_connection_codes DROP CONSTRAINT reject_test_codes'); }
    assert.equal((await db().query<any>('SELECT code_hash FROM telegram_connection_codes')).rows[0].code_hash, hash(first.code));
    assert.equal((await db().query('SELECT 1 FROM telegram_webhook_updates WHERE update_id=$1', [next.update_id])).rows.length, 0);
    assert.equal((await webhook(next)).body.method, 'sendMessage');
  });

  it('does not issue or disclose codes in groups, edited messages, bot messages or mismatched sender identities', async () => {
    for (const extra of [{ chat: { id: -1, type: 'group' } }, { from: { id: telegramId, is_bot: true } }, { from: { id: 333 } }])
      assert.deepEqual((await webhook(update('اتصال به برنامه', ++updateId, telegramId, extra))).body, { ok: true });
    const edited = update('اتصال به برنامه');
    assert.deepEqual((await webhook({ update_id: edited.update_id, edited_message: edited.message })).body, { ok: true });
    assert.equal((await db().query('SELECT 1 FROM telegram_connection_codes')).rows.length, 0);
  });

  it('preserves linked identities on schema reinitialization and removes them when an account is deleted', async () => {
    assert.equal((await link((await issue()).code)).status, 200);
    await initializeSchema(db());
    assert.equal((await request('/api/mobile?action=telegram-link')).body.telegram.id, String(telegramId));
    assert.equal((await request('/api/users?id=' + userA, 'DELETE', undefined, adminToken)).status, 200);
    assert.match((await status()).body.text, /هنوز حساب برنامه/);
    assert.equal((await db().query('SELECT 1 FROM telegram_user_links')).rows.length, 0);
  });
});
