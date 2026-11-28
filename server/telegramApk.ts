import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { ANDROID_APK_MAX_BYTES, ANDROID_APK_NAME, ANDROID_APK_PART_BYTES } from '../shared/androidApk.js';
import type { MobileDatabase } from './presence.js';

export const telegramApkSchema = `
  CREATE TABLE IF NOT EXISTS telegram_apks (
    id UUID PRIMARY KEY,
    size INTEGER NOT NULL CHECK (size BETWEEN 1 AND ${ANDROID_APK_MAX_BYTES}),
    uploaded_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS telegram_apks_slot_idx ON telegram_apks ((uploaded_at IS NOT NULL));
  CREATE TABLE IF NOT EXISTS telegram_apk_parts (
    apk_id UUID NOT NULL REFERENCES telegram_apks(id) ON DELETE CASCADE,
    part INTEGER NOT NULL,
    data BYTEA NOT NULL CHECK (octet_length(data) BETWEEN 1 AND ${ANDROID_APK_PART_BYTES}),
    PRIMARY KEY (apk_id,part)
  );
`;

const apkFields = 'id,size,uploaded_at AS "uploadedAt"';
type ApkRow = { id: string; size: number; uploadedAt: Date | null };
const apkDetails = ({ id, size, uploadedAt }: ApkRow) => ({ id, size, uploadedAt, name: ANDROID_APK_NAME });
const invalidApk = 'فایل انتخاب‌شده یک APK معتبر نیست.';
const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const manifestName = Buffer.from('AndroidManifest.xml');

async function updateUpload<T>(database: MobileDatabase, update: (client: PoolClient) => Promise<T>) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    // Serialize upload changes while allowing readers to keep using the published APK.
    await client.query('LOCK TABLE telegram_apks IN SHARE ROW EXCLUSIVE MODE');
    const result = await update(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function readArchiveRange(client: PoolClient, id: string, start: number, end: number) {
  const first = Math.floor(start / ANDROID_APK_PART_BYTES);
  const last = Math.floor((end - 1) / ANDROID_APK_PART_BYTES);
  const offset = first * ANDROID_APK_PART_BYTES;
  const { rows } = await client.query<{ data: Buffer }>(`SELECT data FROM telegram_apk_parts
    WHERE apk_id=$1 AND part BETWEEN $2 AND $3 ORDER BY part`, [id, first, last]);
  return Buffer.concat(rows.map(row => row.data)).subarray(start - offset, end - offset);
}

async function hasAndroidManifest(client: PoolClient, { id, size }: ApkRow) {
  // APKs use a ZIP central directory. Read it without extracting any files.
  const tailStart = Math.max(0, size - (22 + 0xffff));
  const tail = await readArchiveRange(client, id, tailStart, size);
  let footer = tail.length - 22;
  while (footer >= 0) {
    if (tail.readUInt32LE(footer) === 0x06054b50 && footer + 22 + tail.readUInt16LE(footer + 20) === tail.length) break;
    footer--;
  }
  if (footer < 0) return false;

  const entries = tail.readUInt16LE(footer + 10);
  const length = tail.readUInt32LE(footer + 12);
  const start = tail.readUInt32LE(footer + 16);
  if (!entries || entries * 46 > length || start + length !== tailStart + footer) return false;

  const directory = await readArchiveRange(client, id, start, start + length);
  let found = false;
  let offset = 0;
  for (let entry = 0; entry < entries; entry++) {
    const nameStart = offset + 46;
    if (nameStart > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) return false;
    const nameEnd = nameStart + directory.readUInt16LE(offset + 28);
    offset = nameEnd + directory.readUInt16LE(offset + 30) + directory.readUInt16LE(offset + 32);
    if (offset > directory.length) return false;
    if (directory.subarray(nameStart, nameEnd).equals(manifestName)) found = true;
  }
  return found && offset === directory.length;
}

export async function handleTelegramApk(database: MobileDatabase, method: string, id: unknown, part: unknown,
  rawBody: unknown, res: Response) {
  const reply = (status: number, body: unknown) => res.status(status).json(body);
  if (method === 'GET' && id == null && part == null) {
    const { rows } = await database.query<ApkRow>(`SELECT ${apkFields} FROM telegram_apks WHERE uploaded_at IS NOT NULL`);
    return reply(200, { apk: rows[0] ? apkDetails(rows[0]) : null });
  }

  if (method === 'POST') {
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody as { size?: unknown } | undefined;
    const size = body?.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
      return reply(400, { message: 'یک فایل APK انتخاب کنید.' });
    }
    if (size > ANDROID_APK_MAX_BYTES) return reply(413, { message: 'حجم فایل APK بیشتر از حد مجاز است.' });
    const uploadId = randomUUID();
    await updateUpload(database, async client => {
      await client.query('DELETE FROM telegram_apks WHERE uploaded_at IS NULL');
      await client.query('INSERT INTO telegram_apks(id,size) VALUES($1,$2)', [uploadId, size]);
    });
    return reply(201, { id: uploadId });
  }

  if (method !== 'GET' && method !== 'PUT') return reply(405, { message: 'روش درخواست پشتیبانی نمی‌شود.' });
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    typeof part !== 'string' || !/^\d{1,2}$/.test(part) || Number(part) >= ANDROID_APK_MAX_BYTES / ANDROID_APK_PART_BYTES) {
    return reply(400, { message: 'شناسه یا شمارهٔ بخش فایل معتبر نیست.' });
  }
  const index = Number(part);

  if (method === 'GET') {
    const { rows } = await database.query<{ data: Buffer }>(`SELECT p.data FROM telegram_apk_parts p
      JOIN telegram_apks a ON a.id=p.apk_id WHERE p.apk_id=$1 AND p.part=$2 AND a.uploaded_at IS NOT NULL`, [id, index]);
    if (!rows[0]) return reply(404, { message: 'این بخش از نسخهٔ فعلی پیدا نشد. دوباره دانلود کنید.' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(Buffer.from(rows[0].data));
  }

  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > ANDROID_APK_PART_BYTES) {
    return reply(400, { message: 'بخش بارگذاری‌شده معتبر نیست.' });
  }

  const result = await updateUpload(database, async client => {
    const { rows: [apk] } = await client.query<ApkRow & { received: number }>(`SELECT ${apkFields},
      (SELECT COUNT(*)::int FROM telegram_apk_parts WHERE apk_id=$1) AS received FROM telegram_apks WHERE id=$1`, [id]);
    if (!apk) return { status: 409, body: { message: 'این آپلود دیگر فعال نیست. دوباره فایل را آپلود کنید.' } };

    const offset = index * ANDROID_APK_PART_BYTES;
    if (rawBody.length !== Math.min(ANDROID_APK_PART_BYTES, apk.size - offset)) {
      return { status: 400, body: { message: 'اندازهٔ بخش فایل معتبر نیست.' } };
    }
    if (index < apk.received) return { status: 200, body: { apk: apk.uploadedAt ? apkDetails(apk) : null } };
    if (index !== apk.received) return { status: 409, body: { message: 'ترتیب بخش‌های فایل معتبر نیست.' } };
    if (index === 0 && !rawBody.subarray(0, zipHeader.length).equals(zipHeader)) {
      return { status: 400, body: { message: invalidApk } };
    }

    await client.query('INSERT INTO telegram_apk_parts(apk_id,part,data) VALUES($1,$2,$3)', [id, index, rawBody]);
    if (offset + rawBody.length < apk.size) return { status: 200, body: { apk: null } };
    if (!(await hasAndroidManifest(client, apk))) {
      await client.query('DELETE FROM telegram_apks WHERE id=$1', [id]);
      return { status: 400, body: { message: invalidApk } };
    }

    await client.query('DELETE FROM telegram_apks WHERE uploaded_at IS NOT NULL');
    const { rows: [published] } = await client.query<ApkRow>(`UPDATE telegram_apks SET uploaded_at=NOW()
      WHERE id=$1 RETURNING ${apkFields}`, [id]);
    return { status: 200, body: { apk: apkDetails(published) } };
  });
  return reply(result.status, result.body);
}
