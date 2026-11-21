type Database = { query: (sql: string, values?: unknown[]) => Promise<any> };

export type BluePalConfig = { api_key: string; merchant_id: string; base_url: string; custom_endpoint: string; enabled: boolean };

function send(res: any, status: number, body: unknown) {
  return res.status(status).json(body);
}

function validBaseUrl(value: unknown): string | null {
  try {
    let input = String(value || 'https://blupal.top').trim();
    if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    const supportedHost = host === 'blupal.top' || host.endsWith('.blupal.top') || host === 'bluepal.ir' || host.endsWith('.bluepal.ir');
    if (url.protocol !== 'https:' || !supportedHost) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function apiBase(value: unknown) {
  const base = validBaseUrl(value) || 'https://blupal.top';
  return /\/api$/i.test(base) ? base : `${base}/api`;
}

function createInvoiceUrl(config: BluePalConfig) {
  const base = apiBase(config.base_url);
  const custom = String(config.custom_endpoint || '').trim();
  if (!custom || custom === '/api/v1/invoices/create' || custom === '/v1/invoices/create') return `${base}/v1/invoices/create`;
  if (/^https:\/\//i.test(custom)) {
    const url = new URL(custom);
    const host = url.hostname.toLowerCase();
    const supportedHost = host === 'blupal.top' || host.endsWith('.blupal.top') || host === 'bluepal.ir' || host.endsWith('.bluepal.ir');
    if (url.protocol !== 'https:' || !supportedHost) throw new Error('نشانی سفارشی فاکتور باید روی دامنهٔ امن بلوپال باشد.');
    return url.toString();
  }
  const path = custom.startsWith('/') ? custom : `/${custom}`;
  return path === '/api' || path.startsWith('/api/') ? `${base.replace(/\/api$/i, '')}${path}` : `${base}${path}`;
}

export async function readBluePalConfig(database: Database): Promise<BluePalConfig | null> {
  const result = await database.query('SELECT api_key,merchant_id,base_url,custom_endpoint,enabled FROM bluepal_settings WHERE id=1');
  return (result.rows[0] as BluePalConfig | undefined) || null;
}

function configuredPaymentUrl(value: unknown) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch { return ''; }
}

export async function requestBluePalPayment(config: BluePalConfig, args: { amount: number; callbackUrl: string; description: string }) {
  if (!config.enabled || !config.api_key) throw new Error('درگاه بلوپال در پنل تنظیم یا فعال نشده است.');
  const amount = Math.round(args.amount * 10);
  if (amount < 100000 || amount > 500000000) throw new Error('مبلغ پلن باید بین ۱۰٬۰۰۰ و ۵۰٬۰۰۰٬۰۰۰ تومان باشد.');
  return requestBluePalInvoice(config, amount);
}

async function requestBluePalInvoice(config: BluePalConfig, amount: number) {
  if (!config.enabled || !config.api_key) throw new Error('درگاه بلوپال در پنل تنظیم یا فعال نشده است.');
  const isModern = /bluepal\.ir/i.test(config.base_url);
  if (isModern && !config.merchant_id) throw new Error('شناسه Merchant ID در تنظیمات وارد نشده است.');
  const endpoint = createInvoiceUrl(config);
  const modern = isModern;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...(modern ? { Authorization: `Bearer ${config.api_key}` } : { 'X-API-Key': config.api_key }), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(modern ? { merchant_id: config.merchant_id, amount: Math.round(amount / 10), callback_url: '', description: 'خرید اشتراک فیلترشکن' } : { amount }),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  let payload: any = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { message: raw.slice(0, 300) }; }
  const data = payload?.data || (typeof payload?.result === 'object' ? payload.result : null) || payload;
  const invoiceId = data?.invoice_id ?? data?.id;
  const paymentUrl = configuredPaymentUrl(data?.payment_link || data?.payment_url || data?.url || data?.link);
  const modernTrack = data?.track_id;
  const modernPaymentUrl = configuredPaymentUrl(data?.payment_url);
  if (!response.ok || payload?.success === false || (modern ? (!modernTrack || !modernPaymentUrl) : (invoiceId === undefined || invoiceId === null || !paymentUrl))) {
    throw new Error(String(data?.message || data?.error || `پاسخ بلوپال معتبر نبود (HTTP ${response.status}).`).slice(0, 500));
  }
  const finalAmountRial = Number(data?.final_amount) || (modern ? Math.round(Number(data?.amount ?? amount / 10) * 10) : Number(data?.amount)) || amount;
  return { trackId: String(modern ? modernTrack : invoiceId), paymentUrl: modern ? modernPaymentUrl : paymentUrl, amountRial: finalAmountRial, expiresAt: data?.expires_at || null };
}

export async function verifyBluePalPayment(config: BluePalConfig, trackId: string, expectedAmount: number) {
  if (!config.enabled || !config.api_key) throw new Error('درگاه بلوپال در دسترس نیست.');
  const modern = /bluepal\.ir/i.test(config.base_url);
  const response = await fetch(modern ? `${apiBase(config.base_url)}/api/v1/payments/verify/${encodeURIComponent(trackId)}` : `${apiBase(config.base_url)}/v1/invoices/${encodeURIComponent(trackId)}`, {
    headers: { ...(modern ? { Authorization: `Bearer ${config.api_key}` } : { 'X-API-Key': config.api_key }), Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  let payload: any = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
  const data = payload?.data || payload;
  const status = String(data?.status || '').toLowerCase();
  const paid = response.ok && (modern ? [100, 201].includes(Number(data?.result)) && status === 'success' : payload?.success !== false && ['paid', 'completed', 'successful', 'success'].includes(status));
  if (!paid) return { paid: false, reason: status || String(data?.message || data?.error || 'pending') };
  const amount = Number(data?.final_amount ?? data?.amount);
  if (!Number.isSafeInteger(amount) || amount !== expectedAmount) throw new Error('مبلغ تاییدشده با مبلغ فاکتور تطابق ندارد.');
  return { paid: true, reference: String(data?.ref_id || data?.reference_id || data?.transaction_id || trackId), amount };
}

async function readConfig(database: Database) {
  const result = await database.query(`SELECT merchant_id AS "merchantId",base_url AS "baseUrl",custom_endpoint AS "customEndpoint",enabled,
    (api_key <> '') AS "apiKeyConfigured",updated_at AS "updatedAt" FROM bluepal_settings WHERE id=1`);
  return result.rows[0] || {
    merchantId: '', baseUrl: 'https://blupal.top', customEndpoint: '/api/v1/invoices/create', enabled: false, apiKeyConfigured: false, updatedAt: null,
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
    const customEndpoint = typeof body.customEndpoint === 'string' ? body.customEndpoint.trim() : '/api/v1/invoices/create';
    if (merchantId.length > 200 || apiKey.length > 1024 || !baseUrl || customEndpoint.length > 500 || typeof body.enabled !== 'boolean' ||
      (body.clearApiKey !== undefined && typeof body.clearApiKey !== 'boolean')) {
      return send(res, 400, { message: 'شناسه پذیرنده، کلید API یا نشانی HTTPS بلوپال معتبر نیست.' });
    }
    if (/bluepal\.ir/i.test(baseUrl) && !merchantId) return send(res, 400, { message: 'برای درگاه BluePal شناسه Merchant ID هم لازم است.' });
    try { createInvoiceUrl({ api_key: '', merchant_id: '', base_url: baseUrl, custom_endpoint: customEndpoint, enabled: true }); }
    catch (error: any) { return send(res, 400, { message: String(error?.message || 'مسیر فاکتور بلوپال معتبر نیست.') }); }
    const saved = await database.query(`INSERT INTO bluepal_settings(id,api_key,merchant_id,base_url,custom_endpoint,enabled)
      VALUES(1,CASE WHEN $6 THEN '' ELSE $1 END,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET
        api_key=CASE WHEN $6 THEN '' WHEN $1<>'' THEN $1 ELSE bluepal_settings.api_key END,
        merchant_id=EXCLUDED.merchant_id,base_url=EXCLUDED.base_url,custom_endpoint=EXCLUDED.custom_endpoint,enabled=EXCLUDED.enabled,updated_at=NOW()
      RETURNING merchant_id AS "merchantId",base_url AS "baseUrl",custom_endpoint AS "customEndpoint",enabled,(api_key<>'') AS "apiKeyConfigured",updated_at AS "updatedAt"`,
    [apiKey, merchantId, baseUrl, customEndpoint, body.enabled, body.clearApiKey === true]);
    return send(res, 200, saved.rows[0]);
  }

  if (pathname === '/api/payment/bluepal/test' && method === 'POST') {
    const result = await database.query('SELECT api_key,merchant_id,base_url,custom_endpoint,enabled FROM bluepal_settings WHERE id=1');
    const config = result.rows[0];
    if (!config?.api_key || !config?.enabled) {
      return send(res, 400, { message: 'ابتدا کلید API بلوپال را ذخیره و درگاه را فعال کنید.' });
    }
    try {
      const invoice = await requestBluePalInvoice(config, 100000);
      return send(res, 200, { success: true, trackId: invoice.trackId, paymentUrl: invoice.paymentUrl,
        message: `فاکتور تست واقعی با موفقیت ساخته شد؛ شناسه ${invoice.trackId} — مبلغ حداقل درگاه ۱۰٬۰۰۰ تومان.` });
    } catch (error: any) {
      return send(res, 502, { success: false, message: String(error?.message || 'ارتباط با بلوپال ناموفق بود.').slice(0, 500) });
    }
  }

  return null;
}
