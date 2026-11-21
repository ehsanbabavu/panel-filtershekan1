type Database = { query: (sql: string, values?: unknown[]) => Promise<any> };

export type BluePalConfig = { api_key: string; merchant_id: string; base_url: string; enabled: boolean };

function send(res: any, status: number, body: unknown) {
  return res.status(status).json(body);
}

function validBaseUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value || 'https://www.bluepal.ir').trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'bluepal.ir' || host.endsWith('.bluepal.ir'))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safePaymentUrl(value: unknown): string {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'bluepal.ir' || host.endsWith('.bluepal.ir')) ? url.toString() : '';
  } catch {
    return '';
  }
}

export async function readBluePalConfig(database: Database): Promise<BluePalConfig | null> {
  const result = await database.query('SELECT api_key,merchant_id,base_url,enabled FROM bluepal_settings WHERE id=1');
  return (result.rows[0] as BluePalConfig | undefined) || null;
}

export async function requestBluePalPayment(config: BluePalConfig, args: { amount: number; callbackUrl: string; description: string }) {
  const baseUrl = validBaseUrl(config.base_url);
  if (!config.enabled || !config.api_key || !config.merchant_id || !baseUrl) throw new Error('درگاه بلوپال در پنل تنظیم یا فعال نشده است.');
  const response = await fetch(`${baseUrl}/api/v1/payments/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.api_key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchant_id: config.merchant_id, amount: args.amount, callback_url: args.callbackUrl, description: args.description }),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  let payload: any = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { message: raw.slice(0, 300) }; }
  const data = payload?.data || payload;
  const paymentUrl = safePaymentUrl(data?.payment_url);
  if (!response.ok || Number(data?.result) !== 100 || !data?.track_id || !paymentUrl) {
    throw new Error(String(data?.message || data?.error || `پاسخ بلوپال معتبر نبود (HTTP ${response.status}).`).slice(0, 500));
  }
  return { trackId: String(data.track_id), paymentUrl };
}

export async function verifyBluePalPayment(config: BluePalConfig, trackId: string, expectedAmount: number) {
  const baseUrl = validBaseUrl(config.base_url);
  if (!config.enabled || !config.api_key || !baseUrl) throw new Error('درگاه بلوپال در دسترس نیست.');
  const response = await fetch(`${baseUrl}/api/v1/payments/verify/${encodeURIComponent(trackId)}`, {
    headers: { Authorization: `Bearer ${config.api_key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  let payload: any = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
  const data = payload?.data || payload;
  const status = String(data?.status || '').toLowerCase();
  const paid = response.ok && [100, 201].includes(Number(data?.result)) && status === 'success';
  if (!paid) return { paid: false, reason: status || String(data?.message || data?.error || 'pending') };
  const amount = Number(data?.amount);
  if (!Number.isSafeInteger(amount) || amount !== expectedAmount) throw new Error('مبلغ تاییدشده با مبلغ فاکتور تطابق ندارد.');
  return { paid: true, reference: String(data?.ref_id || data?.reference_id || data?.transaction_id || trackId), amount };
}

async function readConfig(database: Database) {
  const result = await database.query(`SELECT merchant_id AS "merchantId",base_url AS "baseUrl",enabled,
    (api_key <> '') AS "apiKeyConfigured",updated_at AS "updatedAt" FROM bluepal_settings WHERE id=1`);
  return result.rows[0] || {
    merchantId: '', baseUrl: 'https://www.bluepal.ir', enabled: false, apiKeyConfigured: false, updatedAt: null,
  };
}

export async function handleBluePalAdminRequest(pathname: string, method: string, req: any, res: any, database: Database) {
  if (pathname === '/api/payment/bluepal/settings' && method === 'GET') {
    return send(res, 200, await readConfig(database));
  }

  if (pathname === '/api/payment/bluepal/settings' && method === 'PUT') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const merchantId = typeof body.merchantId === 'string' ? body.merchantId.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const baseUrl = validBaseUrl(body.baseUrl);
    if (merchantId.length > 200 || apiKey.length > 1024 || !baseUrl || typeof body.enabled !== 'boolean' ||
      (body.clearApiKey !== undefined && typeof body.clearApiKey !== 'boolean')) {
      return send(res, 400, { message: 'شناسه پذیرنده، کلید API یا نشانی HTTPS بلوپال معتبر نیست.' });
    }
    const saved = await database.query(`INSERT INTO bluepal_settings(id,api_key,merchant_id,base_url,enabled)
      VALUES(1,CASE WHEN $5 THEN '' ELSE $1 END,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET
        api_key=CASE WHEN $5 THEN '' WHEN $1<>'' THEN $1 ELSE bluepal_settings.api_key END,
        merchant_id=EXCLUDED.merchant_id,base_url=EXCLUDED.base_url,enabled=EXCLUDED.enabled,updated_at=NOW()
      RETURNING merchant_id AS "merchantId",base_url AS "baseUrl",enabled,(api_key<>'') AS "apiKeyConfigured",updated_at AS "updatedAt"`,
    [apiKey, merchantId, baseUrl, body.enabled, body.clearApiKey === true]);
    return send(res, 200, saved.rows[0]);
  }

  if (pathname === '/api/payment/bluepal/test' && method === 'POST') {
    const result = await database.query('SELECT api_key,merchant_id,base_url FROM bluepal_settings WHERE id=1');
    const config = result.rows[0];
    if (!config?.api_key || !config?.merchant_id) {
      return send(res, 400, { message: 'ابتدا کلید API و شناسه پذیرنده بلوپال را ذخیره کنید.' });
    }
    const baseUrl = validBaseUrl(config.base_url);
    if (!baseUrl) return send(res, 400, { message: 'نشانی سرویس بلوپال معتبر نیست.' });

    const forwardedProtocol = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const forwardedHost = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
    const callbackUrl = String(process.env.PUBLIC_BASE_URL || (forwardedHost ? `${forwardedProtocol}://${forwardedHost}` : 'https://example.com')).replace(/\/+$/, '') + '/';
    const response = await fetch(`${baseUrl}/api/v1/payments/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.api_key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant_id: config.merchant_id, amount: 1000, callback_url: callbackUrl, description: 'تست اتصال پنل فیلترشکن' }),
      signal: AbortSignal.timeout(20000),
    });
    const raw = await response.text();
    let payload: any = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { message: raw.slice(0, 300) }; }
    const data = payload?.data || payload;
    const paymentUrl = safePaymentUrl(data?.payment_url);
    if (!response.ok || Number(data?.result) !== 100 || !data?.track_id || !paymentUrl) {
      const message = data?.message || data?.error || `پاسخ بلوپال معتبر نبود (HTTP ${response.status}).`;
      return send(res, response.ok ? 502 : response.status, { success: false, message: String(message).slice(0, 500) });
    }
    return send(res, 200, {
      success: true,
      trackId: String(data.track_id),
      paymentUrl,
      message: `اتصال برقرار شد و درخواست پرداخت ${String(data.track_id)} ساخته شد.`,
    });
  }

  return null;
}
