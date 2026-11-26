import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Link2, Megaphone, RefreshCw, Save, Send, Sparkles } from 'lucide-react';
import { readApiResponse } from './apiResponse';
import './telegram.css';

type Delivery = {
  id: string; channelId: string; channelTitle: string; mode: 'manual' | 'automatic';
  status: 'pending' | 'sent' | 'failed' | 'uncertain'; text: string; error: string; messageId: string | null; createdAt: string;
};
type ChannelPanel = {
  channel: { channelId: string; channelTitle: string; channelUsername: string; topic: string; model: string;
    automatic: boolean; revision: number };
  botUsername: string; channelReady: boolean; aiConfigured: boolean; schedulerConfigured: boolean; history: Delivery[];
};
const deliveryStatus = {
  pending: 'در حال ارسال', sent: 'ارسال شد', failed: 'ناموفق', uncertain: 'نتیجهٔ ارسال نامشخص',
};
const date = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' });

function postLink(post: Delivery, username: string) {
  if (!post.messageId) return null;
  return username ? `https://t.me/${username}/${post.messageId}`
    : `https://t.me/c/${post.channelId.slice(4)}/${post.messageId}`;
}

async function channelRequest<T>(token: string, action: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/telegram?action=channel-' + action, {
    method, cache: 'no-store', signal, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await readApiResponse<T & { message?: string }>(response);
  if (!response.ok) throw new Error(result.message || 'درخواست کانال تلگرام انجام نشد.');
  return result;
}

export default function TelegramChannelView({ token, onNotify }: { token: string; onNotify: (message: string) => void }) {
  const [panel, setPanel] = useState<ChannelPanel | null>(null);
  const [form, setForm] = useState({ target: '', topic: '', model: '', automatic: false });
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const attempt = useRef<{ id: string; text: string; revision: number; settled: boolean } | null>(null);

  function applySettings(result: ChannelPanel) {
    setPanel(result);
    const { channelId, topic, model, automatic } = result.channel;
    setForm({ target: channelId, topic, model, automatic });
  }

  useEffect(() => {
    const controller = new AbortController();
    void channelRequest<ChannelPanel>(token, 'settings', 'GET', undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) applySettings(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);

  async function run(action: string, operation: () => Promise<void>) {
    setBusy(action);
    setError('');
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'عملیات انجام نشد.'); }
    finally { setBusy(''); }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void run('save', async () => {
      const result = await channelRequest<ChannelPanel>(token, 'settings', 'PUT', { ...form, revision: panel?.channel.revision });
      applySettings(result);
      onNotify('تنظیمات کانال ذخیره شد.');
    });
  }

  function generate() {
    void run('preview', async () => {
      const result = await channelRequest<{ text: string }>(token, 'preview', 'POST', {
        topic: form.topic, model: form.model, source: source.trim(), sourceUrl: sourceUrl.trim(),
      });
      setDraft(result.text);
      onNotify('متن پیشنهادی آماده است.');
    });
  }

  function send(event: FormEvent) {
    event.preventDefault();
    if (!panel || !draft.trim()) return;
    const text = draft.trim();
    const revision = panel.channel.revision;
    if (!attempt.current || attempt.current.text !== text || attempt.current.revision !== revision) {
      attempt.current = { id: crypto.randomUUID(), text, revision, settled: false };
    }
    const current = attempt.current;
    if (current.settled) return;
    void run('send', async () => {
      const { delivery } = await channelRequest<{ delivery: Delivery }>(token, 'send', 'POST', { text, revision, requestId: current.id });
      current.settled = delivery.status === 'sent' || delivery.status === 'uncertain';
      setPanel(previous => previous && { ...previous, history: [delivery, ...previous.history.filter(item => item.id !== delivery.id)].slice(0, 30) });
      if (delivery.status === 'sent') {
        setDraft('');
        attempt.current = null;
        onNotify('پیام در کانال منتشر شد.');
      } else if (delivery.status === 'failed') {
        attempt.current = null;
        setError(delivery.error || 'پیام در کانال منتشر نشد.');
      } else {
        setError(delivery.status === 'pending' ? 'درخواست انتشار در حال انجام است.'
          : 'نتیجهٔ ارسال مشخص نیست. وضعیت پیام را در خود کانال بررسی کنید.');
      }
    });
  }

  const saved = panel?.channel;
  const busyOrLoading = Boolean(busy) || loading;
  const canGenerate = panel?.aiConfigured && form.topic.trim() && form.model.trim();
  const unchangedTarget = form.target.trim() === (saved?.channelId || '');
  const canSend = panel?.channelReady && unchangedTarget && draft.trim()
    && !(attempt.current?.settled && attempt.current.text === draft.trim() && attempt.current.revision === saved?.revision);
  const autoAvailable = panel?.aiConfigured && panel.schedulerConfigured && Boolean(form.model.trim());

  return <div className="telegram-page telegram-channel-page">
    {error && <div className="user-form-error" role="alert">{error}</div>}
    <div className="telegram-setup-grid">
      <section className="panel full-panel">
        <div className="panel-head"><div><h2>تنظیمات کانال</h2><p>مقصد و موضوع انتشار خودکار</p></div><Megaphone size={20}/></div>
        <form className="telegram-form" onSubmit={save}>
          <label>نام کاربری یا شناسهٔ کانال
            <input dir="ltr" value={form.target} onChange={event => setForm({ ...form, target: event.target.value })}
              placeholder="@channel یا -100…" required maxLength={160} disabled={busyOrLoading}/>
          </label>
          <p className="telegram-hint">ربات {panel?.botUsername ? <b dir="ltr">@{panel.botUsername}</b> : 'ثبت‌شده در «اتصال ربات»'} را مدیر کانال کنید و مجوز ارسال پیام را بدهید.</p>
          {saved?.channelId && <p className="telegram-channel-destination">
            <span className={`status ${panel?.channelReady ? 'online' : 'offline'}`}><i/>{panel?.channelReady ? 'کانال ثبت‌شده' : 'نیاز به بررسی ربات'}</span>
            {saved.channelUsername ? <a dir="auto" href={`https://t.me/${saved.channelUsername}`} target="_blank" rel="noreferrer">{saved.channelTitle} <ExternalLink size={12}/></a> : <strong dir="auto">{saved.channelTitle}</strong>}
          </p>}
          <label>موضوع پست‌ها
            <textarea rows={2} value={form.topic} onChange={event => setForm({ ...form, topic: event.target.value })}
              required maxLength={500} disabled={busyOrLoading}/>
          </label>
          <label>مدل متنی AvalAI
            <input dir="ltr" value={form.model} onChange={event => setForm({ ...form, model: event.target.value })}
              placeholder="gpt-5-mini" maxLength={100} disabled={busyOrLoading}/>
          </label>
          {panel && !panel.aiConfigured && <p className="telegram-hint">برای تولید متن، کلید AvalAI را در تنظیمات سرور وارد کنید.</p>}
          {panel && !panel.schedulerConfigured && <p className="telegram-hint">برای انتشار خودکار، کلید زمان‌بندی Vercel را تنظیم کنید.</p>}
          <label className="telegram-channel-toggle">
            <input type="checkbox" checked={form.automatic} onChange={event => setForm({ ...form, automatic: event.target.checked })}
              disabled={busyOrLoading || (!form.automatic && !autoAvailable)}/>
            انتشار خودکار هر روز حوالی ساعت ۲۰ به وقت تهران
          </label>
          <div className="telegram-form-actions">
            <button type="button" className="soft-btn" disabled={busyOrLoading || !panel?.channelReady || !unchangedTarget}
              onClick={() => void run('verify', async () => {
                const result = await channelRequest<{ title: string }>(token, 'verify', 'POST');
                onNotify(`مجوز ارسال به «${result.title}» تأیید شد.`);
              })}><Link2 size={15}/>{busy === 'verify' ? 'در حال بررسی…' : 'بررسی دسترسی'}</button>
            <button className="primary-btn" disabled={busyOrLoading || !panel || (form.automatic && !autoAvailable)}>
              <Save size={15}/>{busy === 'save' ? 'در حال ذخیره…' : 'ذخیره تنظیمات'}
            </button>
          </div>
        </form>
      </section>
      <section className="panel full-panel">
        <div className="panel-head"><div><h2>نوشتن پیام</h2><p>ارسال دستی یا تولید پیش‌نمایش با هوش مصنوعی</p></div><Send size={20}/></div>
        <form className="telegram-form" onSubmit={send}>
          <details className="telegram-channel-source">
            <summary>افزودن منبع برای تولید پیش‌نمایش</summary>
            <label>نشانی منبع<input type="url" dir="ltr" value={sourceUrl} maxLength={600}
              onChange={event => setSourceUrl(event.target.value)} disabled={busyOrLoading} placeholder="https://…"/></label>
            <label>متن منبع<textarea rows={3} value={source} maxLength={8000}
              onChange={event => setSource(event.target.value)} disabled={busyOrLoading}/></label>
          </details>
          <button type="button" className="soft-btn" disabled={busyOrLoading || !canGenerate}
            onClick={generate}><Sparkles size={15}/>{busy === 'preview' ? 'در حال تولید…' : 'تولید پیش‌نمایش'}</button>
          <label>متن پیام
            <textarea rows={9} required value={draft} maxLength={4096} onChange={event => setDraft(event.target.value)}
              disabled={busyOrLoading} placeholder="پیام را بنویسید یا پیش‌نمایش تولیدشده را ویرایش کنید."/>
          </label>
          <div className="telegram-channel-compose">
            <span>{draft.length.toLocaleString('fa-IR')} از ۴۰۹۶ نویسه</span>
            <button className="primary-btn" disabled={busyOrLoading || !canSend}><Send size={15}/>{busy === 'send' ? 'در حال ارسال…' : 'ارسال به کانال'}</button>
          </div>
          {!unchangedTarget && <p className="telegram-hint">برای ارسال، ابتدا مقصد را ذخیره کنید.</p>}
        </form>
      </section>
    </div>
    <section className="panel full-panel">
      <div className="panel-head"><div><h2>تاریخچهٔ ارسال</h2></div>
        <button type="button" className="soft-btn" disabled={busyOrLoading} onClick={() => void run('refresh', async () => {
          const result = await channelRequest<ChannelPanel>(token, 'settings');
          if (!panel || panel.channel.revision !== result.channel.revision) applySettings(result);
          else setPanel(result);
        })}><RefreshCw size={14}/>به‌روزرسانی</button>
      </div>
      {!panel?.history.length ? <p className="empty-state">{loading ? 'در حال دریافت…' : 'هنوز ارسالی ثبت نشده است.'}</p>
        : <ul className="telegram-channel-history">{panel.history.map(post => {
          const href = postLink(post, saved?.channelId === post.channelId ? saved.channelUsername : '');
          return <li key={post.id}>
            <div><b>{post.channelTitle}</b><small>{post.mode === 'automatic' ? 'خودکار' : 'دستی'} · {date.format(new Date(post.createdAt))}</small></div>
            {post.text && <p dir="auto">{post.text}</p>}
            <div><span className={`status ${post.status === 'sent' ? 'online' : 'offline'}`}><i/>{deliveryStatus[post.status]}</span>
              {href && <a href={href} target="_blank" rel="noreferrer">دیدن در تلگرام <ExternalLink size={12}/></a>}</div>
            {post.error && <small>{post.error}</small>}
          </li>;
        })}</ul>}
    </section>
  </div>;
}
