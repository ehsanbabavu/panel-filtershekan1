import type { MobileDatabase } from './presence.js';

const proxyColumns = 'id,name,host,port,username,password,active,updated_at AS "updatedAt"';

function proxyQuery(req: { originalUrl?: string; url?: string }) {
  return new URL(req.originalUrl || req.url || '/', 'http://localhost').searchParams;
}

export type ProxyTable = 'proxy_servers' | 'telegram_channel_proxies';

export function proxyTable(req: Parameters<typeof proxyQuery>[0]): ProxyTable {
  return proxyQuery(req).get('scope') === 'telegram' ? 'telegram_channel_proxies' : 'proxy_servers';
}

export function createProxyListHandler(database: MobileDatabase) {
  return async (req: any, res: any) => {
    const table = proxyTable(req);
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      const result = await database.query(
        `SELECT ${proxyColumns} FROM ${table} ORDER BY id ASC`);
      return res.json(result.rows);
    }
    if (!['POST', 'PATCH', 'DELETE'].includes(method)) {
      return res.status(405).json({ message: 'روش درخواست پشتیبانی نمی‌شود.' });
    }

    const id = Number(proxyQuery(req).get('id'));
    if (method !== 'POST' && (!Number.isSafeInteger(id) || id < 1)) {
      return res.status(400).json({ message: 'شناسه ساکس معتبر نیست.' });
    }
    if (method === 'DELETE') {
      const result = await database.query(`DELETE FROM ${table} WHERE id=$1 RETURNING id`, [id]);
      if (!result.rows[0]) return res.status(404).json({ message: 'ساکس پیدا نشد.' });
      return res.json({ success: true, id: result.rows[0].id });
    }

    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    const port = Number(body.port);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const active = body.active === undefined ? true : body.active;
    if (name.length < 2 || name.length > 80 || !host || host.length > 253 || /\s/.test(host) ||
        !Number.isInteger(port) || port < 1 || port > 65535 || username.length > 255 || password.length > 512 || typeof active !== 'boolean') {
      return res.status(400).json({ message: 'مشخصات ساکس معتبر نیست.' });
    }

    const values = [name, host, port, username, password, active];
    if (method === 'POST') {
      const result = await database.query(`INSERT INTO ${table}(name,host,port,username,password,active)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING ${proxyColumns}`, values);
      return res.status(201).json(result.rows[0]);
    }
    const result = await database.query(`UPDATE ${table} SET name=$1,host=$2,port=$3,username=$4,password=$5,active=$6,updated_at=NOW()
      WHERE id=$7 RETURNING ${proxyColumns}`, [...values, id]);
    if (!result.rows[0]) return res.status(404).json({ message: 'ساکس پیدا نشد.' });
    return res.json(result.rows[0]);
  };
}
