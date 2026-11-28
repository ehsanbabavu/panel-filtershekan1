export class TelegramError extends Error {
  constructor(message: string, readonly deliveryUncertain = false, readonly status?: number) { super(message); }
}

export function createTelegramClient(telegramFetch: typeof fetch = fetch) {
  return async function callTelegram(token: string, method: string, body: unknown = {}) {
    let response: Response;
    const multipart = body instanceof FormData;
    try {
      response = await telegramFetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: multipart ? undefined : { 'Content-Type': 'application/json' },
        body: multipart ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
    } catch { throw new TelegramError('ارتباط با تلگرام برقرار نشد. دوباره تلاش کنید.', true); }
    let payload: any;
    try { payload = await response.json(); } catch { throw new TelegramError('پاسخ تلگرام معتبر نیست.', true); }
    if (!response.ok || payload?.ok !== true) {
      const description = String(payload?.description || 'درخواست ناموفق بود.').split(token).join('[توکن پنهان]');
      throw new TelegramError('تلگرام درخواست را نپذیرفت: ' + description.slice(0, 500),
        payload?.ok !== false || response.status >= 500, response.status);
    }
    return payload.result;
  };
}
