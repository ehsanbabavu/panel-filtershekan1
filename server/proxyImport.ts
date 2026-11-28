import type { MobileDatabase } from './presence.js';
import { parseProxyImport, ProxyImportError } from '../shared/proxyImport.js';
import { proxyTable, type ProxyTable } from './proxyList.js';

export async function importProxies(database: MobileDatabase, content: unknown, table: ProxyTable = 'proxy_servers') {
  const entries = parseProxyImport(content);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    // Serialize numbering with all other writes, including simultaneous uploads.
    await client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    const existing = await client.query<{ count: string; lastNumber: string }>(`SELECT COUNT(*)::text AS count,
      COALESCE(MAX(substring(translate(name, '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789')
        FROM '^ساکس ([0-9]+)$')::numeric), 0)::text AS "lastNumber" FROM ${table}`);
    const count = BigInt(existing.rows[0].count), lastNumber = BigInt(existing.rows[0].lastNumber);
    const start = count > lastNumber ? count : lastNumber;
    const proxies = entries.map((entry, index) => ({ ...entry, name: `ساکس ${start + BigInt(index) + 1n}` }));
    if (proxies.some(proxy => proxy.name.length > 80)) throw new ProxyImportError('شمارهٔ نام ساکس از حد مجاز بیشتر است.');
    const inserted = await client.query(`INSERT INTO ${table}(name,host,port,username,password,active)
      SELECT proxy->>'name',proxy->>'host',(proxy->>'port')::integer,proxy->>'username',proxy->>'password',TRUE
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS input(proxy,position) ORDER BY position
      RETURNING id,name,host,port,username,password,active,updated_at AS "updatedAt"`, [JSON.stringify(proxies)]);
    await client.query('COMMIT');
    return { count: inserted.rows.length, proxies: inserted.rows };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function createProxyImportHandler(database: MobileDatabase) {
  return async (req: any, res: any) => {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      return res.status(201).json(await importProxies(database, body?.content, proxyTable(req)));
    } catch (error) {
      if (error instanceof ProxyImportError || error instanceof SyntaxError) {
        return res.status(400).json({ message: error instanceof ProxyImportError ? error.message : 'محتوای درخواست معتبر نیست.' });
      }
      throw error;
    }
  };
}
