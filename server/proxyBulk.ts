import type { MobileDatabase } from './presence.js';

function validId(value: unknown): value is number | string {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

export function createProxyBulkHandler(database: MobileDatabase) {
  return async (req: any, res: any) => {
    if (req.method !== 'PATCH' && req.method !== 'DELETE') {
      return res.status(405).json({ message: 'روش درخواست پشتیبانی نمی‌شود.' });
    }
    let body: any;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { return res.status(400).json({ message: 'محتوای درخواست معتبر نیست.' }); }
    if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.length > 10000 || !body.ids.every(validId)) {
      return res.status(400).json({ message: 'بین ۱ تا ۱۰٬۰۰۰ ساکس معتبر را انتخاب کنید.' });
    }
    const ids = [...new Set<string>(body.ids.map(String))];
    if (req.method === 'DELETE') {
      const result = await database.query('DELETE FROM proxy_servers WHERE id=ANY($1::bigint[]) RETURNING id', [ids]);
      return res.status(200).json({ count: result.rows.length, ids: result.rows.map(row => String(row.id)) });
    }
    if (typeof body.active !== 'boolean') {
      return res.status(400).json({ message: 'وضعیت فعال یا غیرفعال معتبر نیست.' });
    }
    const result = await database.query(`UPDATE proxy_servers SET active=$2,updated_at=NOW()
      WHERE id=ANY($1::bigint[]) RETURNING id,active,updated_at AS "updatedAt"`, [ids, body.active]);
    return res.status(200).json({ count: result.rows.length, ids: result.rows.map(row => String(row.id)), proxies: result.rows });
  };
}
