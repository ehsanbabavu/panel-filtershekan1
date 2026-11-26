import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Link2, RefreshCw, Save, Send, Unplug } from 'lucide-react';
import { readApiResponse } from './apiResponse';
import './telegram.css';

type Settings = { tokenConfigured: boolean; webhookUrl: string; enabled: boolean; botId: string | null;
  botUsername: string; botName: string; lastReceivedAt: string | null };
type Connection = Settings & { connected: boolean; registeredUrl?: string; pendingUpdates: number; lastError?: string; lastErrorAt?: string | null };
export default function TelegramView({ token, onNotify }: { token: string; onNotify: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [botToken, setBotToken] = useState('');
  const [webhookUrl, setWebhookUrl] = useState(() => window.location.origin + '/api/telegram?action=webhook');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function request<T>(action: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch('/api/telegram?action=' + action, {
      method, cache: 'no-store', signal, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await readApiResponse<T & { message?: string }>(response);
    if (!response.ok) throw new Error(result.message || 'درخواست تلگرام انجام نشد.');
    return result;
  }

  useEffect(() => {
    const controller = new AbortController(); let stopped = false;
    const loadSettings = async () => {
      try { const result = await request<Settings>('settings', 'GET', undefined, controller.signal);
        if (!stopped) { setSettings(result); setWebhookUrl(result.webhookUrl || window.location.origin + '/api/telegram?action=webhook'); }
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : 'تنظیمات دریافت نشدند.'); }
      finally { if (!stopped) setLoading(false); }
    };
    void loadSettings();
    return () => { stopped = true; controller.abort(); };
  }, [token]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy('save'); setError('');
    try { const result = await request<Settings>('settings', 'PUT', { botToken, webhookUrl });
      setSettings(result); setWebhookUrl(result.webhookUrl); setBotToken(''); setConnection(null);
      onNotify('تنظیمات تلگرام ذخیره شد. اکنون اتصال ربات را ثبت کنید.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تنظیمات ذخیره نشدند.'); }
    finally { setBusy(''); }
  };
  const changeConnection = async (action: 'connect' | 'disconnect' | 'status') => {
    if (action === 'disconnect' && !window.confirm('دریافت پیام‌های ربات در پنل قطع شود؟ پیام‌های قبلی حفظ می‌شوند.')) return;
    setBusy(action); setError('');
    try {
      if (action === 'status') { const result = await request<Connection>('status'); setConnection(result); setSettings(result); }
      else { const result = await request<Settings>(action, 'POST'); setSettings(result); setConnection(null);
        onNotify(action === 'connect' ? 'ربات متصل شد. گفت‌وگوها در بخش «پشتیبانی» نمایش داده می‌شوند.' : 'اتصال وب‌هوک تلگرام قطع شد.'); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'ارتباط با تلگرام انجام نشد.'); }
    finally { setBusy(''); }
  };
  const date = (value?: string | null) => value ? new Date(value).toLocaleString('fa-IR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const unsaved = Boolean(botToken.trim() || (settings && webhookUrl.trim() !== settings.webhookUrl));

  return <div className="telegram-page">
    <div className="telegram-setup-grid">
      <section className="panel full-panel"><div className="panel-head"><div><h2>اتصال ربات تلگرام</h2><p>توکن ربات و آدرس دریافت پیام‌ها را تنظیم کنید.</p></div><Send size={21}/></div>
        <div className="telegram-guide"><b>راه‌اندازی در سه مرحله</b><ol><li>در تلگرام از <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">BotFather</a> یک ربات بسازید و توکن را بگیرید.</li><li>توکن و آدرس وب‌هوک همین سایت را ذخیره کنید و «اتصال ربات» را بزنید.</li><li>در تلگرام دکمهٔ «پشتیبانی» ربات را بزنید و پیام بفرستید. برای دیدن پیام و پاسخ‌گویی، «پشتیبانی» را از منوی «تلگرام» در پنل باز کنید.</li></ol></div>
        {error && <div className="user-form-error" role="alert">{error}</div>}
        <form className="telegram-form" onSubmit={save}><label>توکن ربات<input type="password" dir="ltr" autoComplete="new-password" value={botToken} disabled={loading || Boolean(busy) || Boolean(settings?.enabled)} onChange={event => setBotToken(event.target.value)} placeholder={settings?.tokenConfigured ? 'توکن ذخیره شده؛ برای حفظ آن خالی بگذارید' : '123456789:AA...'} required={!settings?.tokenConfigured}/></label>
          <label>آدرس وب‌هوک<input type="url" dir="ltr" required value={webhookUrl} disabled={loading || Boolean(busy) || Boolean(settings?.enabled)} onChange={event => setWebhookUrl(event.target.value)}/></label>
          <div className="telegram-form-actions"><button type="button" className="soft-btn" onClick={() => { void navigator.clipboard.writeText(webhookUrl).then(() => onNotify('آدرس وب‌هوک کپی شد.')).catch(() => setError('کپی آدرس انجام نشد.')); }}><Copy size={14}/>کپی آدرس</button><button className="primary-btn" disabled={loading || Boolean(busy) || Boolean(settings?.enabled)}><Save size={15}/>{busy === 'save' ? 'در حال ذخیره...' : 'ذخیره تنظیمات'}</button></div>
          <p className="telegram-hint">آدرس باید روی دامنه عمومی سایت و با HTTPS در دسترس باشد. برای تغییر تنظیمات، ابتدا اتصال فعلی را قطع کنید.</p>
        </form>
      </section>
      <section className="panel full-panel"><div className="panel-head"><div><h2>وضعیت اتصال</h2><p>ثبت وب‌هوک و آخرین دریافت از تلگرام</p></div><span className={'status ' + (settings?.enabled && connection?.connected !== false ? 'online' : 'offline')}><i/>{loading ? 'در حال دریافت...' : connection ? connection.connected ? 'متصل' : 'قطع' : settings?.enabled ? 'وب‌هوک ثبت شده' : 'متصل نشده'}</span></div>
        <dl className="telegram-details"><div><dt>ربات</dt><dd>{settings?.botUsername ? <a href={'https://t.me/' + settings.botUsername} target="_blank" rel="noreferrer" dir="ltr">@{settings.botUsername}<ExternalLink size={12}/></a> : '—'}</dd></div><div><dt>توکن</dt><dd>{settings?.tokenConfigured ? 'ذخیره شده' : 'وارد نشده'}</dd></div><div><dt>آخرین پیام دریافتی</dt><dd>{date(settings?.lastReceivedAt)}</dd></div><div><dt>پیام‌های در انتظار تحویل</dt><dd>{connection ? connection.pendingUpdates.toLocaleString('fa-IR') : 'پس از بررسی وضعیت'}</dd></div></dl>
        {connection?.lastError && <div className="user-form-error" role="alert">آخرین خطای تحویل تلگرام: {connection.lastError}<small>{date(connection.lastErrorAt)}</small></div>}
        {connection?.registeredUrl && connection.registeredUrl !== settings?.webhookUrl && <p className="telegram-hint">وب‌هوک ربات به آدرس دیگری متصل است. برای دریافت پیام در این پنل، اتصال را دوباره ثبت کنید.</p>}
        {unsaved && <p className="telegram-hint">ابتدا تغییرات تنظیمات را ذخیره کنید.</p>}
        <div className="telegram-connection-actions"><button className="primary-btn" disabled={loading || Boolean(busy) || !settings?.tokenConfigured || unsaved} onClick={() => void changeConnection('connect')}><Link2 size={15}/>{busy === 'connect' ? 'در حال اتصال...' : settings?.enabled ? 'ثبت دوباره وب‌هوک' : 'اتصال ربات'}</button><button className="soft-btn" disabled={loading || Boolean(busy) || !settings?.tokenConfigured} onClick={() => void changeConnection('status')}><RefreshCw size={14}/>{busy === 'status' ? 'در حال بررسی...' : 'بررسی وضعیت'}</button><button className="soft-btn danger-action" disabled={loading || Boolean(busy) || !settings?.enabled} onClick={() => void changeConnection('disconnect')}><Unplug size={14}/>{busy === 'disconnect' ? 'در حال قطع...' : 'قطع اتصال'}</button></div>
      </section>
    </div>
  </div>;
}
