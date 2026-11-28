import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Link2, Megaphone, RefreshCw, Save, Send, Sparkles, Trash2 } from 'lucide-react';
import { readApiResponse } from './apiResponse';
import SocksView from './SocksView';
import './telegram.css';

type Delivery = {
  id: string; channelId: string; channelTitle: string; mode: 'manual' | 'automatic';
  status: 'pending' | 'sent' | 'failed' | 'uncertain'; text: string; error: string; messageId: string | null; createdAt: string;
  sourceUrl: string | null;
};
type ChannelPanel = {
  channel: { channelId: string; channelTitle: string; channelUsername: string; model: string;
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

export default function TelegramChannelView({ token, onNotify, onOpenSettings }: {
  token: string; onNotify: (message: string) => void; onOpenSettings: () => void;
}) {
  const [panel, setPanel] = useState<ChannelPanel | null>(null);
  const [form, setForm] = useState({ target: '', model: '', automatic: false });
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState<{ sourceUrl: string; attribution: string; imageUrl: string | null } | null>(null);
  const [unavailableImage, setUnavailableImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const attempt = useRef<{ id: string; text: string; sourceUrl: string | null; imageUrl: string | null; revision: number; settled: boolean } | null>(null);

  function applySettings(result: ChannelPanel) {
    setPanel(result);
    const { channelId, model, automatic } = result.channel;
    setForm({ target: channelId, model, automatic });
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
      const result = await channelRequest<{ text: string; sourceUrl: string; attribution: string; imageUrl: string | null }>(
        token, 'preview', 'POST', { model: form.model });
      setDraft(result.text);
      setSource(result);
      setUnavailableImage(null);
      onNotify('متن پیشنهادی آماده است.');
    });
  }

  function removeFromHistory(post: Delivery) {
    if (!window.confirm('این رکورد از تاریخچهٔ پنل حذف شود؟ پیام منتشرشده در کانال تلگرام باقی می‌ماند.')) return;
    void run('delete:' + post.id, async () => {
      const { history } = await channelRequest<{ history: Delivery[] }>(token, 'history', 'DELETE', { id: post.id });
      setPanel(previous => previous && { ...previous, history });
      onNotify('رکورد از تاریخچه حذف شد.');
    });
  }

  function send(event: FormEvent) {
    event.preventDefault();
    if (!panel || !draft.trim()) return;
    const text = draft.trim();
    const sourceUrl = source?.sourceUrl ?? null;
    const imageUrl = source?.imageUrl ?? null;
    const revision = panel.channel.revision;
    if (!attempt.current || attempt.current.text !== text || attempt.current.sourceUrl !== sourceUrl ||
      attempt.current.imageUrl !== imageUrl || attempt.current.revision !== revision) {
      attempt.current = { id: crypto.randomUUID(), text, sourceUrl, imageUrl, revision, settled: false };
    }
    const current = attempt.current;
    if (current.settled) return;
    void run('send', async () => {
      const { delivery } = await channelRequest<{ delivery: Delivery }>(token, 'send', 'POST', { text, sourceUrl, imageUrl, revision, requestId: current.id });
      current.settled = delivery.status === 'sent' || delivery.status === 'uncertain';
      setPanel(previous => previous && { ...previous, history: [delivery, ...previous.history.filter(item => item.id !== delivery.id)].slice(0, 30) });
      if (delivery.status === 'sent') {
        setDraft('');
        setSource(null);
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
  const canGenerate = panel?.aiConfigured && form.model.trim();
  const unchangedTarget = form.target.trim() === (saved?.channelId || '');
  const canSend = panel?.channelReady && unchangedTarget && draft.trim()
    && !(attempt.current?.settled && attempt.current.text === draft.trim() &&
      attempt.current.sourceUrl === (source?.sourceUrl ?? null) && attempt.current.imageUrl === (source?.imageUrl ?? null) &&
      attempt.current.revision === saved?.revision);
  const autoAvailable = panel?.aiConfigured && panel.schedulerConfigured && Boolean(form.model.trim());

  return <div className="telegram-page telegram-channel-page">
    {error && <div className="user-form-error" role="alert">{error}</div>}
    <div className="telegram-setup-grid">
      <section className="panel full-panel">
        <div className="panel-head"><div><h2>تنظیمات کانال</h2><p>مقصد و زمان‌بندی انتشار خودکار</p></div><Megaphone size={20}/></div>
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
          <label>مدل متنی AvalAI
            <input dir="ltr" value={form.model} onChange={event => setForm({ ...form, model: event.target.value })}
              placeholder="gpt-5-mini" maxLength={100} disabled={busyOrLoading}/>
          </label>
          {panel && !panel.aiConfigured && <div className="telegram-connection-notice">
            <span>برای تولید متن، کلید AvalAI را ثبت کنید.</span>
            <button type="button" className="soft-btn" onClick={onOpenSettings}>تنظیمات تلگرام</button>
          </div>}
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
          <button type="button" className="soft-btn" disabled={busyOrLoading || !canGenerate}
            onClick={generate}><Sparkles size={15}/>{busy === 'preview' ? 'در حال دریافت و خلاصه‌سازی…' : 'تولید پیش‌نمایش خبر'}</button>
          <p className="telegram-hint">موضوع بین فناوری و سیاست انتخاب می‌شود. عکس از همان خبر برداشته می‌شود و دکمهٔ منبع و پیوند ساکس زیر خبر می‌آیند.</p>
          {source?.imageUrl && source.imageUrl !== unavailableImage && <img className="telegram-channel-news-image"
            src={source.imageUrl} alt="عکس منبع خبر" referrerPolicy="no-referrer" onError={() => setUnavailableImage(source.imageUrl)}/>}
          {source?.imageUrl && draft.trim().length > 1024 && <p className="telegram-hint">تلگرام برای متن همراه عکس تا ۱۰۲۴ نویسه می‌پذیرد. این متن به‌تنهایی ارسال می‌شود.</p>}
          <label>متن پیام
            <textarea rows={9} required value={draft} maxLength={4096} onChange={event => {
              setDraft(event.target.value);
              if (!event.target.value.trim()) setSource(null);
            }}
              disabled={busyOrLoading} placeholder="پیام را بنویسید یا پیش‌نمایش تولیدشده را ویرایش کنید."/>
          </label>
          {source && <div className="telegram-channel-history-actions">
            <a href={source.sourceUrl} target="_blank" rel="noreferrer">منبع خبر · {source.attribution}</a>
            <button type="button" className="soft-btn" disabled={busyOrLoading} onClick={() => setSource(null)}>برداشتن پیوند</button>
          </div>}
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
          const text = post.sourceUrl && post.text.endsWith('\n' + post.sourceUrl)
            ? post.text.slice(0, -(post.sourceUrl.length + 1)) : post.text;
          return <li key={post.id}>
            <div><b>{post.channelTitle}</b><small>{post.mode === 'automatic' ? 'خودکار' : 'دستی'} · {date.format(new Date(post.createdAt))}</small></div>
            {text && <p dir="auto">{text}</p>}
            <div><span className={`status ${post.status === 'sent' ? 'online' : 'offline'}`}><i/>{deliveryStatus[post.status]}</span>
              <span className="telegram-channel-history-actions">
                {href && <a href={href} target="_blank" rel="noreferrer">دیدن در تلگرام <ExternalLink size={12}/></a>}
                {post.sourceUrl && <a href={post.sourceUrl} target="_blank" rel="noreferrer">منبع خبر <ExternalLink size={12}/></a>}
                <button type="button" className="soft-btn danger-action" disabled={busyOrLoading || post.status === 'pending'}
                  onClick={() => removeFromHistory(post)}><Trash2 size={13}/>{busy === 'delete:' + post.id ? 'در حال حذف…' : 'حذف از تاریخچه'}</button>
              </span></div>
            {post.error && <small>{post.error}</small>}
          </li>;
        })}</ul>}
    </section>
    <SocksView token={token} onNotify={onNotify} telegram/>
  </div>;
}
