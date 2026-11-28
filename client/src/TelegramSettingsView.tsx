import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Save } from 'lucide-react';
import TelegramAndroidApk from './TelegramAndroidApk';
import './telegram.css';

type AiSettings = { saved: boolean; configured: boolean };

export default function TelegramSettingsView({ token, onNotify }: { token: string; onNotify: (message: string) => void }) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/telegram?action=channel-ai-settings', {
      headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error();
      const result: AiSettings = await response.json();
      if (!controller.signal.aborted) setSettings(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError('وضعیت کلید AvalAI دریافت نشد.');
    });
    return () => controller.abort();
  }, [token]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/telegram?action=channel-ai-settings', {
        method: 'PUT', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      if (!response.ok) {
        setError(response.status === 400 ? 'کلید AvalAI را بدون فاصله یا سطر جدید وارد کنید.' :
          response.status === 401 ? 'برای ادامه دوباره وارد حساب مدیر شوید.' : 'ذخیرهٔ کلید AvalAI انجام نشد.');
        return;
      }
      const result: AiSettings = await response.json();
      setSettings(result);
      setApiKey('');
      onNotify('کلید AvalAI ذخیره شد.');
    } catch { setError('ذخیرهٔ کلید AvalAI انجام نشد.'); }
    finally { setSaving(false); }
  }

  return <div className="telegram-page telegram-setup-grid">
    <section className="panel">
      <div className="panel-head">
        <div><h2>تنظیمات هوش مصنوعی تلگرام</h2><p>کلید AvalAI برای تولید متن پست‌های کانال</p></div>
        <KeyRound size={20}/>
      </div>
      {error && <div className="user-form-error" role="alert">{error}</div>}
      <form className="telegram-form" onSubmit={save}>
        <label htmlFor="telegram-avalai-key">کلید AvalAI <code dir="ltr">AVALAI_API_KEY</code>
          <input id="telegram-avalai-key" type="password" dir="ltr" autoComplete="new-password"
            spellCheck={false} value={apiKey} required maxLength={512} disabled={saving}
            onChange={event => setApiKey(event.target.value)}
            placeholder={settings?.saved ? 'برای جایگزینی، کلید جدید را وارد کنید' : 'کلید AvalAI را وارد کنید'}/>
        </label>
        {settings && <p className="telegram-hint" role="status">{settings.saved ? 'کلید در پنل ذخیره شده است.'
          : settings.configured ? 'کلید از تنظیمات سرور خوانده می‌شود.' : 'کلید AvalAI هنوز تنظیم نشده است.'}</p>}
        <div className="telegram-form-actions">
          <button className="primary-btn" disabled={saving || !apiKey.trim()}>
            <Save size={15}/>{saving ? 'در حال ذخیره…' : 'ذخیرهٔ کلید'}
          </button>
        </div>
      </form>
    </section>
    <TelegramAndroidApk token={token} onNotify={onNotify}/>
  </div>;
}
