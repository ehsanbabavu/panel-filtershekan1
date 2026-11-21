type Database = { query: (sql: string, values?: unknown[]) => Promise<any> };

export type BluePalConfig = { api_key: string; merchant_id: string; base_url: string; custom_endpoint: string; card_number?: string; enabled: boolean };

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
  if (/bluepal\.ir/i.test(config.base_url) && (!custom || custom === '/api/v1/invoices/create' || custom === '/v1/invoices/create')) {
    return `${base}/v1/payments/request`;
  }
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
  const result = await database.query('SELECT api_key,merchant_id,base_url,custom_endpoint,card_number,account_holder,iban,webhook_secret,custom_webhook_url,enabled FROM bluepal_settings WHERE id=1');
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
  const amountToman = Number(args.amount);
  if (!Number.isSafeInteger(amountToman) || amountToman < 10000 || amountToman > 50000000) throw new Error('مبلغ پلن باید بین ۱۰٬۰۰۰ و ۵۰٬۰۰۰٬۰۰۰ تومان باشد.');
  return requestBluePalInvoice(config, { amountToman, callbackUrl: args.callbackUrl, description: args.description });
}

async function requestBluePalInvoice(config: BluePalConfig, args: { amountToman: number; callbackUrl?: string; description?: string }) {
  if (!config.api_key) throw new Error('کلید API بلوپال وارد نشده است.');
  const isModern = /bluepal\.ir/i.test(config.base_url);
  if (isModern && !config.merchant_id) throw new Error('شناسه Merchant ID در تنظیمات وارد نشده است.');
  const endpoint = createInvoiceUrl(config);
  const modern = isModern;
  const amountToman = args.amountToman;
  const amountRial = amountToman * 10;
  const cardNumber = String(config.card_number || '').replace(/\D/g, '');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...(modern ? { Authorization: `Bearer ${config.api_key}` } : { 'X-API-Key': config.api_key }), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(modern
      ? { merchant_id: config.merchant_id, amount: amountToman, callback_url: args.callbackUrl || '', description: args.description || 'خرید اشتراک فیلترشکن' }
      : { amount: amountRial, ...(cardNumber ? { card_number: cardNumber } : {}) }),
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
  const finalAmountRial = modern ? amountRial : (Number(data?.final_amount) || Number(data?.amount) || amountRial);
  const mode = String(data?.mode || (/^blu_test_/i.test(config.api_key) ? 'sandbox' : /^blu_live_/i.test(config.api_key) ? 'live' : 'unknown')).toLowerCase();
  return { trackId: String(modern ? modernTrack : invoiceId), paymentUrl: modern ? modernPaymentUrl : paymentUrl, amountRial: finalAmountRial, expiresAt: data?.expires_at || null, mode };
}

export async function verifyBluePalPayment(config: BluePalConfig, trackId: string, expectedAmount: number) {
  if (!config.enabled || !config.api_key) throw new Error('درگاه بلوپال در دسترس نیست.');
  const modern = /bluepal\.ir/i.test(config.base_url);
  const modernRoot = (validBaseUrl(config.base_url) || 'https://www.bluepal.ir').replace(/\/api$/i, '');
  const response = await fetch(modern ? `${modernRoot}/api/v1/payments/verify/${encodeURIComponent(trackId)}` : `${apiBase(config.base_url)}/v1/invoices/${encodeURIComponent(trackId)}`, {
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
  const providerAmount = Number(data?.final_amount ?? data?.amount);
  const amountRial = modern ? providerAmount * 10 : providerAmount;
  if (!Number.isSafeInteger(amountRial) || amountRial !== expectedAmount) throw new Error('مبلغ تاییدشده با مبلغ فاکتور تطابق ندارد.');
  return { paid: true, reference: String(data?.ref_id || data?.reference_id || data?.transaction_id || trackId), amount: amountRial };
}

async function readConfig(database: Database) {
  const result = await database.query(`SELECT merchant_id AS "merchantId",base_url AS "baseUrl",custom_endpoint AS "customEndpoint",
    card_number AS "cardNumber",account_holder AS "accountHolder",iban,webhook_secret AS "webhookSecret",custom_webhook_url AS "customWebhookUrl",enabled,
    (api_key <> '') AS "apiKeyConfigured",updated_at AS "updatedAt" FROM bluepal_settings WHERE id=1`);
  return result.rows[0] || {
    merchantId: '', baseUrl: 'https://blupal.top', customEndpoint: '/api/v1/invoices/create', cardNumber: '', accountHolder: '', iban: '', webhookSecret: '', customWebhookUrl: '', enabled: false, apiKeyConfigured: false, updatedAt: null,
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
    const cardNumber = typeof body.cardNumber === 'string' ? body.cardNumber.trim() : '';
    const accountHolder = typeof body.accountHolder === 'string' ? body.accountHolder.trim() : '';
    const iban = typeof body.iban === 'string' ? body.iban.trim() : '';
    const webhookSecret = typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : '';
    const customWebhookUrl = typeof body.customWebhookUrl === 'string' ? body.customWebhookUrl.trim() : '';
    if (merchantId.length > 200 || apiKey.length > 1024 || !baseUrl || customEndpoint.length > 500 || typeof body.enabled !== 'boolean' ||
      cardNumber.length > 64 || accountHolder.length > 200 || iban.length > 64 || webhookSecret.length > 1024 || customWebhookUrl.length > 2048 ||
      (customWebhookUrl && !/^https:\/\//i.test(customWebhookUrl)) || (body.clearApiKey !== undefined && typeof body.clearApiKey !== 'boolean')) {
      return send(res, 400, { message: 'شناسه پذیرنده، کلید API یا نشانی HTTPS بلوپال معتبر نیست.' });
    }
    if (/bluepal\.ir/i.test(baseUrl) && !merchantId) return send(res, 400, { message: 'برای درگاه BluePal شناسه Merchant ID هم لازم است.' });
    try { createInvoiceUrl({ api_key: '', merchant_id: '', base_url: baseUrl, custom_endpoint: customEndpoint, enabled: true }); }
    catch (error: any) { return send(res, 400, { message: String(error?.message || 'مسیر فاکتور بلوپال معتبر نیست.') }); }
    const saved = await database.query(`INSERT INTO bluepal_settings(id,api_key,merchant_id,base_url,custom_endpoint,card_number,account_holder,iban,webhook_secret,custom_webhook_url,enabled)
      VALUES(1,CASE WHEN $11 THEN '' ELSE $1 END,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(id) DO UPDATE SET
        api_key=CASE WHEN $11 THEN '' WHEN $1<>'' THEN $1 ELSE bluepal_settings.api_key END,
        merchant_id=EXCLUDED.merchant_id,base_url=EXCLUDED.base_url,custom_endpoint=EXCLUDED.custom_endpoint,card_number=EXCLUDED.card_number,
        account_holder=EXCLUDED.account_holder,iban=EXCLUDED.iban,webhook_secret=CASE WHEN $12 THEN '' WHEN $8<>'' THEN $8 ELSE bluepal_settings.webhook_secret END,
        custom_webhook_url=EXCLUDED.custom_webhook_url,enabled=EXCLUDED.enabled,updated_at=NOW()
      RETURNING merchant_id AS "merchantId",base_url AS "baseUrl",custom_endpoint AS "customEndpoint",card_number AS "cardNumber",
        account_holder AS "accountHolder",iban,custom_webhook_url AS "customWebhookUrl",(webhook_secret<>'') AS "webhookSecretConfigured",
        enabled,(api_key<>'') AS "apiKeyConfigured",updated_at AS "updatedAt"`,
    [apiKey, merchantId, baseUrl, customEndpoint, cardNumber, accountHolder, iban, webhookSecret, customWebhookUrl, body.enabled, body.clearApiKey === true, body.clearWebhookSecret === true]);
    return send(res, 200, saved.rows[0]);
  }

  if (pathname === '/api/payment/bluepal/test' && method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const storedResult = await database.query('SELECT api_key,merchant_id,base_url,custom_endpoint,enabled FROM bluepal_settings WHERE id=1');
    const stored = storedResult.rows[0] || {};
    const config = {
      ...stored,
      api_key: String(body.apiKey || stored.api_key || '').trim(),
      merchant_id: String(body.merchantId || stored.merchant_id || '').trim(),
      base_url: String(body.baseUrl || stored.base_url || 'https://blupal.top').trim(),
      custom_endpoint: String(body.customEndpoint || stored.custom_endpoint || '/api/v1/invoices/create').trim(),
      enabled: body.enabled === undefined ? stored.enabled : body.enabled === true,
    };
    if (!config.api_key) {
      return send(res, 400, { message: 'ابتدا کلید API بلوپال را وارد کنید.' });
    }
    if (!/bluepal\.ir/i.test(config.base_url) && /^blu_test_/i.test(config.api_key)) {
      return send(res, 400, { success: false, mode: 'sandbox', message: 'کلید ذخیره‌شده آزمایشی است و فاکتور Sandbox می‌سازد. برای ساخت فاکتور واقعی، کلید Live با پیشوند blu_live_ را در تنظیمات وارد و ذخیره کنید.' });
    }
    try {
      const invoice = await requestBluePalInvoice(config, { amountToman: 10000, callbackUrl: '', description: 'تست اتصال درگاه فیلترشکن' });
      if (invoice.mode === 'sandbox') {
        return send(res, 409, { success: false, mode: invoice.mode, trackId: invoice.trackId, paymentUrl: invoice.paymentUrl,
          message: 'بلوپال با کلید آزمایشی فاکتور Sandbox ساخت. برای حالت واقعی، کلید Live را در تنظیمات ذخیره کنید.' });
      }
      return send(res, 200, { success: true, trackId: invoice.trackId, paymentUrl: invoice.paymentUrl,
        message: `${invoice.mode === 'live' ? 'فاکتور واقعی' : 'فاکتور'} با موفقیت ساخته شد؛ شناسه ${invoice.trackId} — مبلغ حداقل درگاه ۱۰٬۰۰۰ تومان.` });
    } catch (error: any) {
      return send(res, 502, { success: false, message: String(error?.message || 'ارتباط با بلوپال ناموفق بود.').slice(0, 500) });
    }
  }

  return null;
}
