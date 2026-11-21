import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, ArrowDownLeft, ArrowUpLeft, Bell, Check, CheckCircle2, ChevronDown, CircleHelp, Command, Copy, CreditCard, ExternalLink, Key, KeyRound, LayoutDashboard, LogOut, Menu, MessageCircle, MoreHorizontal, Pencil, Plus, RefreshCw, Save, Search, Send, ShieldCheck, Trash2, Users, Wifi, X } from 'lucide-react';
import './gateway.css';

type User = { id: string; name: string; username: string; status: string; plan: string; lastSeen: string; blocked?: boolean; subscriptionStartedAt?: string; subscriptionExpiresAt?: string; subscriptionQuotaBytes?: string; subscriptionUsedBytes?: string };
type UserSubscription = { userId: string; userName: string; username: string; planId: number; planName: string; durationDays: number; startedAt: string; expiresAt: string; quotaBytes: string; usedBytes: string; blocked: boolean; active: boolean };
type UserForm = { id?: string; name: string; username: string; plan: string; password: string };
const newUserForm: UserForm = { name: '', username: '', plan: 'آزمایشی', password: '' };
type Message = { id: string; userId: string; author: string; text: string; time: string; senderRole: 'admin' | 'user' };
type Conversation = { userId: string; name: string; username: string; lastMessage?: string; lastMessageAt?: string; unreadCount: number };
type ProxyEntry = { id: number; name: string; host: string; port: number; username: string; password: string; active: boolean; updatedAt?: string };
const sectionPaths: Record<string, string> = { dashboard: '/dashboard', users: '/users', plans: '/plans', subscriptions: '/subscriptions', socks: '/socks', chat: '/chat', gateway: '/payment-gateway' };
const pathSections = Object.fromEntries(Object.entries(sectionPaths).map(([section, path]) => [path, section])) as Record<string, string>;
function sectionFromPath(pathname: string) { return pathSections[pathname.replace(/\/$/, '')] || 'dashboard'; }

class ApiError extends Error {
  constructor(public status: number, message = 'دریافت اطلاعات با خطا مواجه شد.') { super(message); }
}

async function api<T>(url: string, token: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal });
  const result = await readApiResponse<T>(response);
  if (!response.ok) throw new ApiError(response.status, (result as any)?.message || `خطای سرور (HTTP ${response.status})`);
  return result;
}

async function readApiResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  if (!body) return {} as T;
  try { return JSON.parse(body) as T; }
  catch {
    const detail = body.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(`پاسخ API معتبر نیست (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
  }
}

function Login({ onLogin }: { onLogin: (token: string, username: string) => void }) {
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [showPassword, setShowPassword] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await result.json(); if (!result.ok) throw new Error(data.message || 'ورود انجام نشد.'); onLogin(data.token, data.username);
    } catch (e) { setError(e instanceof Error ? e.message : 'اتصال به سرور برقرار نشد.'); } finally { setBusy(false); }
  };
  return <main className="login-page"><div className="login-orb orb-a"/><div className="login-orb orb-b"/><section className="login-card">
    <div className="brand brand-login"><div className="brand-mark"><Wifi size={23}/></div><div><b>فیلترشکن</b><span>پنل مدیریت</span></div></div>
    <div className="login-heading"><span className="eyebrow">خوش آمدید</span><h1>ورود به حساب</h1><p>برای مدیریت سرویس، وارد حساب مدیر شوید.</p></div>
    <form onSubmit={submit} className="login-form"><label htmlFor="username">نام کاربری</label><div className="input-wrap"><Users size={18}/><input id="username" autoComplete="username" placeholder="نام کاربری مدیر" value={username} onChange={e => setUsername(e.target.value)} required/></div>
      <div className="password-label"><label htmlFor="password">رمز عبور</label><button type="button" className="text-btn" onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'پنهان کردن' : 'نمایش'}</button></div><div className="input-wrap"><ShieldCheck size={18}/><input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="رمز عبور خود را وارد کنید" value={password} onChange={e => setPassword(e.target.value)} required/></div>
      {error && <div className="login-error">{error}</div>}<button className="primary-btn login-submit" disabled={busy}>{busy ? 'در حال ورود...' : 'ورود به پنل'}<ArrowDownLeft size={17}/></button>
    </form><div className="login-foot"><ShieldCheck size={15}/> ورود امن و محافظت‌شده</div>
  </section><div className="login-copy">فیلترشکن <span>•</span> مدیریت ساده‌تر، ارتباط مطمئن‌تر</div></main>;
}

type BluePalConfig = { merchantId: string; baseUrl: string; customEndpoint: string; cardNumber: string; accountHolder: string; iban: string; webhookSecretConfigured: boolean; customWebhookUrl: string; enabled: boolean; apiKeyConfigured: boolean; updatedAt?: string | null };
function BluePalSettingsView({ token, onNotify }: { token: string; onNotify: (text: string) => void }) {
  const [config, setConfig] = useState<BluePalConfig>({ merchantId: '', baseUrl: 'https://blupal.top', customEndpoint: '/api/v1/invoices/create', cardNumber: '', accountHolder: '', iban: '', webhookSecretConfigured: false, customWebhookUrl: '', enabled: false, apiKeyConfigured: false });
  const [apiKey, setApiKey] = useState(''); const [clearApiKey, setClearApiKey] = useState(false); const [webhookSecret, setWebhookSecret] = useState(''); const [clearWebhookSecret, setClearWebhookSecret] = useState(false);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [testing, setTesting] = useState(false);
  const [error, setError] = useState(''); const [testResult, setTestResult] = useState<{ success: boolean; message: string; paymentUrl?: string } | null>(null);
  const [copiedWebhookUrl, setCopiedWebhookUrl] = useState(false);
  const systemWebhookUrl = `${window.location.origin}/api/payment/bluepal/webhook`;
  const activeWebhookUrl = config.customWebhookUrl.trim() || systemWebhookUrl;
  useEffect(() => {
    const controller = new AbortController();
    api<BluePalConfig>('/api/payment/bluepal/settings', token, controller.signal).then(setConfig)
      .catch(() => { if (!controller.signal.aborted) setError('خواندن تنظیمات درگاه انجام نشد.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(''); setTestResult(null);
    try {
      const response = await fetch('/api/payment/bluepal/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...config, apiKey, clearApiKey, webhookSecret, clearWebhookSecret }) });
      const result = await readApiResponse<BluePalConfig & { message?: string }>(response); if (!response.ok) throw new Error(result.message || `ذخیره تنظیمات انجام نشد (HTTP ${response.status}).`);
      setConfig(result); setApiKey(''); setClearApiKey(false); setWebhookSecret(''); setClearWebhookSecret(false); onNotify('تنظیمات بلوپال ذخیره شد.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'ذخیره تنظیمات انجام نشد.'); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true); setError(''); setTestResult(null);
    try {
      const response = await fetch('/api/payment/bluepal/test', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...config, apiKey, enabled: config.enabled }) });
      const result = await response.json();
      setTestResult({ success: response.ok && Boolean(result.success), message: result.message || 'پاسخی از وب‌سرویس بلوپال دریافت نشد.', paymentUrl: result.paymentUrl });
    } catch (reason) { setTestResult({ success: false, message: reason instanceof Error ? reason.message : 'تست اتصال انجام نشد.' }); }
    finally { setTesting(false); }
  };
  const copyWebhookUrl = async () => { try { await navigator.clipboard.writeText(activeWebhookUrl); setCopiedWebhookUrl(true); window.setTimeout(() => setCopiedWebhookUrl(false), 2000); } catch { setCopiedWebhookUrl(false); } };
  return <section className="panel full-panel gateway-settings"><div className="panel-head"><div><h2>تنظیمات درگاه بلوپال</h2><p>مشخصات API، اطلاعات کارت و تنظیمات وب‌هوک بلوپال.</p></div><span className={`gateway-status ${config.enabled && config.apiKeyConfigured ? 'is-ready' : ''}`}><i/>{config.enabled && config.apiKeyConfigured ? 'فعال' : config.enabled ? 'کلید ثبت نشده' : 'غیرفعال'}</span></div>
    {loading ? <div className="gateway-loading">در حال دریافت تنظیمات...</div> : <form className="gateway-form" onSubmit={save}>
      <label className="gateway-switch"><span><b>فعال‌سازی درگاه</b><small>این وضعیت برای درگاه‌های متصل به API قابل استفاده خواهد بود.</small></span><button type="button" role="switch" aria-checked={config.enabled} className={`access-switch ${config.enabled ? '' : 'is-blocked'}`} onClick={() => setConfig(current => ({ ...current, enabled: !current.enabled }))}><span/><b>{config.enabled ? 'فعال' : 'خاموش'}</b></button></label>
      <div className="gateway-grid">
        <label className="gateway-key-field">کلید دسترسی وب‌سرویس / توکن API بلوپال<input dir="ltr" type="password" autoComplete="new-password" value={apiKey} onChange={event => { setApiKey(event.target.value); setClearApiKey(false); }} placeholder={config.apiKeyConfigured ? 'کلید ذخیره شده؛ برای تعویض، کلید تازه وارد کنید' : 'توکن API بلوپال'}/><small>{config.apiKeyConfigured && !clearApiKey ? 'کلید فعلی محفوظ است و برای نگه‌داشتن آن این فیلد را خالی بگذارید.' : 'کلید فقط در سرور نگهداری می‌شود.'}</small></label>
        <label>نشانی پایه بلوپال<input dir="ltr" type="text" required value={config.baseUrl} onChange={event => setConfig(current => ({ ...current, baseUrl: event.target.value }))} placeholder="https://blupal.top"/></label>
        <label>مسیر صدور فاکتور سفارشی<input dir="ltr" type="text" required value={config.customEndpoint} onChange={event => setConfig(current => ({ ...current, customEndpoint: event.target.value }))} placeholder="/api/v1/invoices/create"/></label>
        {/bluepal\.ir/i.test(config.baseUrl) && <label>شناسه پذیرنده (Merchant ID)<input dir="ltr" autoComplete="off" required value={config.merchantId} onChange={event => setConfig(current => ({ ...current, merchantId: event.target.value }))} placeholder="شناسه پذیرنده BluePal"/></label>}
        <label><span className="gateway-field-title"><CreditCard size={14}/> شماره کارت (۱۶ رقم)</span><input dir="ltr" inputMode="numeric" value={config.cardNumber} onChange={event => setConfig(current => ({ ...current, cardNumber: event.target.value }))} placeholder="شماره کارت ثبت‌شده در بلوپال"/></label>
        <label><span className="gateway-field-title"><Users size={14}/> نام و نام خانوادگی صاحب حساب</span><input value={config.accountHolder} onChange={event => setConfig(current => ({ ...current, accountHolder: event.target.value }))} placeholder="نام صاحب حساب"/></label>
        <label>شماره شبا<input dir="ltr" value={config.iban} onChange={event => setConfig(current => ({ ...current, iban: event.target.value }))} placeholder="IR…"/></label>
      </div>
      {config.apiKeyConfigured && <button type="button" className="gateway-clear-key" onClick={() => { setClearApiKey(value => !value); setApiKey(''); }}>{clearApiKey ? 'لغو حذف کلید' : 'حذف کلید ذخیره‌شده'}</button>}
      <div className="gateway-webhook"><div><h3>آدرس وب‌هوک دریافت نتیجه پرداخت</h3><p>این آدرس را در بخش تنظیمات وب‌هوک پنل پذیرنده بلوپال وارد کنید.</p></div><div className="gateway-webhook-copy"><input type="url" readOnly dir="ltr" value={activeWebhookUrl}/><button type="button" className="soft-btn" onClick={copyWebhookUrl}>{copiedWebhookUrl ? <Check size={15}/> : <Copy size={15}/>} {copiedWebhookUrl ? 'کپی شد' : 'کپی آدرس'}</button></div><div className="gateway-grid"><label>آدرس وب‌هوک سفارشی (اختیاری)<input type="url" dir="ltr" value={config.customWebhookUrl} onChange={event => setConfig(current => ({ ...current, customWebhookUrl: event.target.value }))} placeholder="https://example.com/api/blupal/webhook"/><small>اگر خالی بماند آدرس سایت به‌صورت خودکار استفاده می‌شود.</small></label><label>کلید امضای وب‌هوک (اختیاری)<input type="password" dir="ltr" autoComplete="new-password" value={webhookSecret} onChange={event => { setWebhookSecret(event.target.value); setClearWebhookSecret(false); }} placeholder={config.webhookSecretConfigured ? 'کلید ذخیره شده؛ برای تعویض مقدار تازه وارد کنید' : 'کلید امضای وب‌هوک'}/><small>{config.webhookSecretConfigured && !clearWebhookSecret ? 'کلید فعلی محفوظ است؛ برای نگه‌داشتن آن فیلد را خالی بگذارید.' : 'در صورت تنظیم secret در پنل بلوپال وارد کنید.'}</small></label></div>{config.webhookSecretConfigured && <button type="button" className="gateway-clear-key" onClick={() => { setClearWebhookSecret(value => !value); setWebhookSecret(''); }}>{clearWebhookSecret ? 'لغو حذف secret' : 'حذف secret ذخیره‌شده'}</button>}</div>
      {error && <div className="user-form-error" role="alert">{error}</div>}
      {testResult && <div className={`gateway-test-result ${testResult.success ? 'is-success' : 'is-error'}`}>{testResult.success ? <CheckCircle2 size={17}/> : <AlertCircle size={17}/>}<span>{testResult.message}</span>{testResult.paymentUrl && <a href={testResult.paymentUrl} target="_blank" rel="noopener noreferrer">مشاهده درگاه <ExternalLink size={14}/></a>}</div>}
      <div className="gateway-actions"><button className="primary-btn" disabled={saving}>{saving ? <RefreshCw size={16} className="spin"/> : <Save size={16}/>} {saving ? 'در حال ذخیره...' : 'ذخیره تنظیمات بلوپال'}</button><button type="button" className="soft-btn" disabled={testing || (!config.apiKeyConfigured && !apiKey.trim())} onClick={test}>{testing ? <RefreshCw size={16} className="spin"/> : <KeyRound size={16}/>} صدور فاکتور واقعی با کلید Live</button></div>
      <p className="gateway-warning">این دکمه فاکتور قابل پرداخت ۱۰٬۰۰۰ تومانی می‌سازد. در blupal.top فقط کلید Live با پیشوند blu_live_ تراکنش واقعی ایجاد می‌کند؛ کلید blu_test_ فقط Sandbox می‌سازد. پرداخت فاکتور، تراکنش واقعی است.</p>
    </form>}
  </section>;
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('fs-token') || ''); const [admin, setAdmin] = useState(() => sessionStorage.getItem('fs-user') || 'ehsan');
  const [section, setSection] = useState(() => sectionFromPath(window.location.pathname)); const [users, setUsers] = useState<User[]>([]); const [plans, setPlans] = useState<any[]>([]); const [userSubscriptions, setUserSubscriptions] = useState<UserSubscription[]>([]); const [subscriptionBusy, setSubscriptionBusy] = useState<string[]>([]); const [subscriptionLoading, setSubscriptionLoading] = useState(false); const [subscriptionLoadError, setSubscriptionLoadError] = useState(''); const [conversations, setConversations] = useState<Conversation[]>([]); const [chatLoadError, setChatLoadError] = useState(''); const [unreadChatCount, setUnreadChatCount] = useState(0); const [selectedChatUserId, setSelectedChatUserId] = useState(''); const [search, setSearch] = useState(''); const [mobileMenu, setMobileMenu] = useState(false); const [messages, setMessages] = useState<Message[]>([]); const [draft, setDraft] = useState(''); const [toast, setToast] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => {
    const syncRoute = () => { const next = sectionFromPath(window.location.pathname); setSection(next); if (window.location.pathname !== sectionPaths[next]) window.history.replaceState({}, '', sectionPaths[next]); };
    window.addEventListener('popstate', syncRoute);
    if (window.location.pathname !== sectionPaths[section]) window.history.replaceState({}, '', sectionPaths[section]);
    return () => window.removeEventListener('popstate', syncRoute);
  }, []);
  const navigateTo = (next: string) => { const path = sectionPaths[next] || sectionPaths.dashboard; if (window.location.pathname !== path) window.history.pushState({}, '', path); setSection(next); };
  const [userModal, setUserModal] = useState(false); const [userForm, setUserForm] = useState<UserForm>(newUserForm); const [userBusy, setUserBusy] = useState(false); const [userError, setUserError] = useState('');
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    const refreshUsers = async () => {
      try {
        const rows = await api<User[]>('/api/users', token, controller.signal);
        if (!stopped) setUsers(rows);
      } catch (error) {
        if (!stopped && error instanceof ApiError && error.status === 401) {
          sessionStorage.removeItem('fs-token');
          sessionStorage.removeItem('fs-user');
          setToken('');
          stopped = true;
        }
      } finally {
        if (!stopped) {
          setLoading(false);
          timer = setTimeout(refreshUsers, 10000);
        }
      }
    };
    void refreshUsers();
    api<any[]>('/api/subscriptions', token, controller.signal).then(rows => { if (!stopped) setPlans(rows); }).catch(() => {});
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [token]);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let stopped = false;
    const refresh = () => api<UserSubscription[]>('/api/user-subscriptions', token, controller.signal).then(rows => { if (!stopped) { setUserSubscriptions(rows); setSubscriptionLoadError(''); } }).catch(error => { if (!stopped && !(error instanceof DOMException && error.name === 'AbortError')) setSubscriptionLoadError(error instanceof ApiError ? `دریافت اشتراک‌ها از سرور ناموفق بود (خطای ${error.status}).` : 'ارتباط با سرور اشتراک‌ها برقرار نشد.'); }).finally(() => { if (!stopped) setSubscriptionLoading(false); });
    setSubscriptionLoading(true); setSubscriptionLoadError('');
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { stopped = true; window.clearInterval(timer); controller.abort(); };
  }, [token]);
  useEffect(() => {
    if (!token) { setUnreadChatCount(0); return; }
    const controller = new AbortController(); let stopped = false;
    const refresh = () => api<{ count: number }>('/api/chat/unread-count', token, controller.signal).then(result => { if (!stopped) setUnreadChatCount(Number(result.count) || 0); }).catch(() => {});
    void refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { stopped = true; window.clearInterval(timer); controller.abort(); };
  }, [token]);
  useEffect(() => {
    if (!token || section !== 'chat') return;
    const controller = new AbortController(); let stopped = false;
    const refresh = () => api<Conversation[]>('/api/chat/conversations', token, controller.signal).then(rows => {
      if (stopped) return; if (!selectedChatUserId) setChatLoadError(''); setConversations(rows);
      if (!selectedChatUserId && rows.length) setSelectedChatUserId(String(rows[0].userId));
      if (selectedChatUserId && !rows.some(row => String(row.userId) === selectedChatUserId)) setSelectedChatUserId(rows.length ? String(rows[0].userId) : '');
    }).catch(error => { if (!stopped) setChatLoadError(error instanceof ApiError ? 'گفتگوها از سایت دریافت نشدند (خطای ' + error.status + ').' : 'ارتباط با سرویس چت برقرار نشد.'); });
    void refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { stopped = true; window.clearInterval(timer); controller.abort(); };
  }, [token, section, selectedChatUserId]);
  useEffect(() => {
    if (!token || section !== 'chat' || !selectedChatUserId) { setMessages([]); return; }
    const controller = new AbortController(); let stopped = false;
    const refresh = () => api<Message[]>(`/api/chat?userId=${encodeURIComponent(selectedChatUserId)}`, token, controller.signal).then(rows => {
      if (!stopped) { setChatLoadError(''); setMessages(rows.map(row => ({ ...row, time: new Date(row.time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) }))); }
    }).catch(error => { if (!stopped) setChatLoadError(error instanceof ApiError ? 'پیام‌های این گفتگو دریافت نشدند (خطای ' + error.status + ').' : 'ارتباط با سرویس چت برقرار نشد.'); });
    void refresh(); const timer = window.setInterval(refresh, 3000);
    return () => { stopped = true; window.clearInterval(timer); controller.abort(); };
  }, [token, section, selectedChatUserId]);
  const filteredUsers = useMemo(() => users.filter(u => `${u.name} ${u.username} ${u.plan}`.includes(search)), [users, search]);
  const login = (newToken: string, username: string) => { sessionStorage.setItem('fs-token', newToken); sessionStorage.setItem('fs-user', username); setAdmin(username); setToken(newToken); };
  const logout = () => { sessionStorage.clear(); setToken(''); navigateTo('dashboard'); };
  const notify = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 2400); };
  const openUserModal = (user?: User) => { setUserError(''); setUserForm(user ? { id: user.id, name: user.name, username: user.username, plan: user.plan, password: '' } : { ...newUserForm }); setUserModal(true); };
  const saveUser = async (event: React.FormEvent) => {
    event.preventDefault(); setUserBusy(true); setUserError('');
    const editing = Boolean(userForm.id);
    try {
      const response = await fetch(editing ? `/api/users?id=${encodeURIComponent(userForm.id!)}` : '/api/users', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(userForm),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'ذخیره کاربر انجام نشد.');
      setUsers(current => editing ? current.map(user => user.id === result.id ? result : user) : [result, ...current]);
      setUserModal(false); notify(editing ? 'اطلاعات کاربر ذخیره شد.' : 'حساب کاربر ساخته شد و برای ورود به اپ آماده است.');
    } catch (error) {
      setUserError(error instanceof Error ? error.message : 'ذخیره کاربر انجام نشد.');
    } finally { setUserBusy(false); }
  };
  const deleteUser = async (user: User) => {
    if (!window.confirm(`حساب «${user.name}» حذف شود؟ دسترسی این حساب در اپ هم قطع می‌شود.`)) return;
    try {
      const response = await fetch(`/api/users?id=${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'حذف کاربر انجام نشد.');
      setUsers(current => current.filter(item => item.id !== user.id)); notify('کاربر حذف شد و نشست‌های اپ او باطل شدند.');
    } catch (error) { notify(error instanceof Error ? error.message : 'حذف کاربر انجام نشد.'); }
  };
  const setUserBlocked = async (subscription: UserSubscription, blocked: boolean) => {
    setSubscriptionBusy(current => [...current, subscription.userId]);
    try {
      const response = await fetch('/api/users/block', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ userId: Number(subscription.userId), blocked }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'تغییر دسترسی کاربر انجام نشد.');
      if (Boolean(result.blocked) !== blocked) throw new Error('سرور وضعیت دسترسی را ذخیره نکرد.');
      setUserSubscriptions(current => current.map(item => String(item.userId) === String(subscription.userId) ? { ...item, blocked: Boolean(result.blocked) } : item));
      setUsers(current => current.map(user => user.id === subscription.userId ? { ...user, blocked, status: blocked ? 'آفلاین' : user.status } : user));
      notify(blocked ? 'دسترسی کاربر مسدود شد.' : 'دسترسی کاربر فعال شد.');
    } catch (error) { notify(error instanceof Error ? error.message : 'تغییر دسترسی انجام نشد.'); }
    finally { setSubscriptionBusy(current => current.filter(id => id !== subscription.userId)); }
  };
  const sendMessage = async (event: React.FormEvent) => { event.preventDefault(); if (!draft.trim() || !selectedChatUserId) return; try { const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ userId: Number(selectedChatUserId), message: draft }) }); const message = await response.json(); if (!response.ok) throw new Error(message.message || 'ارسال پیام انجام نشد.'); setMessages(current => [...current, { ...message, id: String(message.id), userId: String(message.userId), senderRole: 'admin', time: new Date(message.time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) }]); setDraft(''); } catch (error) { notify(error instanceof Error ? error.message : 'ارسال پیام انجام نشد.'); } };
  if (!token) return <Login onLogin={login}/>;
  const nav = [{ id: 'dashboard', label: 'داشبورد', icon: LayoutDashboard }, { id: 'users', label: 'کاربران', icon: Users, count: users.length }, { id: 'plans', label: 'پلن‌ها', icon: CreditCard }, { id: 'subscriptions', label: 'اشتراک‌ها', icon: ShieldCheck }, { id: 'socks', label: 'ساکس', icon: Wifi }, { id: 'chat', label: 'چت و پشتیبانی', icon: MessageCircle, count: unreadChatCount }, { id: 'gateway', label: 'تنظیمات بلوپال', icon: CreditCard }];
  const title = ({ dashboard: 'داشبورد', users: 'کاربران', plans: 'پلن‌ها', subscriptions: 'اشتراک‌ها', socks: 'ساکس', chat: 'چت و پشتیبانی', gateway: 'درگاه بلوپال' } as Record<string, string>)[section];
  return <div className="app-shell"><aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}><div className="brand"><div className="brand-mark"><Wifi size={22}/></div><div><b>فیلترشکن</b><span>پنل مدیریت</span></div><button className="icon-btn close-menu" onClick={() => setMobileMenu(false)}><X size={19}/></button></div>
    <div className="workspace"><div className="workspace-logo">F</div><div className="workspace-info"><b>فضای کاری اصلی</b><span>پلن تجاری</span></div><ChevronDown size={16} className="muted"/></div>
    <div className="nav-caption">منوی اصلی</div><nav>{nav.map(item => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => { navigateTo(item.id); setMobileMenu(false); }}><item.icon size={19}/><span>{item.label}</span>{item.count !== undefined && item.count > 0 && <small>{item.count}</small>}</button>)}</nav>
    <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><CircleHelp size={18}/></div><b>به راهنمایی نیاز دارید؟</b><p>تیم ما همیشه کنار شماست.</p><button onClick={() => navigateTo('chat')}>گفت‌وگو با پشتیبانی <ArrowUpLeft size={14}/></button></div><div className="profile"><div className="avatar admin-avatar">ا</div><div className="profile-info"><b>{admin}</b><span>مدیر کل</span></div><button className="icon-btn" title="خروج" onClick={logout}><LogOut size={17}/></button></div></div>
  </aside><div className={`mobile-scrim ${mobileMenu ? 'show' : ''}`} onClick={() => setMobileMenu(false)}/>
  <main className="main-area"><header className="topbar"><div className="topbar-left"><button className="icon-btn mobile-trigger" onClick={() => setMobileMenu(true)}><Menu size={21}/></button><div className="breadcrumb">صفحات <span>/</span> <b>{title}</b></div></div><div className="topbar-actions"><div className="status-pill"><i/> همه سیستم‌ها فعال</div><button className="icon-btn notification" onClick={() => notify('اعلان جدیدی ندارید.')}><Bell size={19}/><i/></button><div className="top-divider"/><div className="top-profile"><div className="avatar admin-avatar">ا</div><div><b>{admin}</b><span>مدیر سیستم</span></div><ChevronDown size={15}/></div></div></header>
    <div className="page-content"><div className="page-heading"><div><div className="welcome-line">چه خبر، {admin}؟ <span>✦</span></div><h1>{title}</h1><p>وضعیت سرویس و فعالیت کاربران را در یک نگاه ببینید.</p></div><div className="heading-date"><div className="date-dot"/><span>امروز</span><b>{new Intl.DateTimeFormat('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</b></div></div>
      {section === 'dashboard' && <><div className="stats-grid"><Stat icon={<Users size={20}/>} label="کل کاربران" value={new Intl.NumberFormat('fa-IR').format(users.length)} detail="حساب‌های ثبت‌شده در دیتابیس" tone="violet" trend="واقعی"/><Stat icon={<Activity size={20}/>} label="کاربران آنلاین" value={new Intl.NumberFormat('fa-IR').format(users.filter(user => user.status === 'آنلاین').length)} detail="متصل به VPN" tone="green" trend="لحظه‌ای"/><Stat icon={<CreditCard size={20}/>} label="اشتراک فعال" value={new Intl.NumberFormat('fa-IR').format(userSubscriptions.filter(item => item.active).length)} detail="بر اساس زمان اعتبار و حجم باقی‌مانده" tone="blue" trend="واقعی"/><Stat icon={<CreditCard size={20}/>} label="درآمد این ماه" value="۲۸٫۶ م" detail="نسبت به ماه گذشته" tone="amber" trend="+۱۸٪"/><Stat icon={<MessageCircle size={20}/>} label="چت‌های خوانده‌نشده" value={new Intl.NumberFormat('fa-IR').format(unreadChatCount)} detail="پیام‌های کاربران منتظر پاسخ" tone="violet" trend="پشتیبانی"/></div>
        <div className="dashboard-grid"><section className="panel users-panel"><div className="panel-head"><div><h2>کاربران اخیر</h2><p>آخرین وضعیت کاربران سرویس</p></div><button className="soft-btn" onClick={() => navigateTo('users')}>مشاهده همه <ArrowUpLeft size={15}/></button></div><UserTable users={users.slice(0, 5)} loading={loading}/></section><section className="panel activity-panel"><div className="panel-head"><div><h2>نمای کلی سرویس</h2><p>گزارش هفت روز گذشته</p></div><button className="icon-btn" onClick={() => notify('گزارش‌ها به‌روز هستند.')}><MoreHorizontal size={20}/></button></div><div className="chart-summary"><div><strong>۸٬۴۹۲</strong><span>اتصال موفق</span></div><span className="chart-growth"><ArrowUpLeft size={14}/> ۱۲٪</span></div><div className="chart"><div className="chart-y"><span>۱۰۰۰</span><span>۷۵۰</span><span>۵۰۰</span><span>۲۵۰</span><span>۰</span></div><div className="chart-plot"><div className="grid-lines"><i/><i/><i/><i/><i/></div><svg viewBox="0 0 560 180" preserveAspectRatio="none" aria-label="نمودار اتصال"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#7565ee" stopOpacity=".22"/><stop offset="1" stopColor="#7565ee" stopOpacity="0"/></linearGradient></defs><path d="M0 138 C35 130 43 103 80 112 S130 142 160 101 S207 93 240 107 S287 65 320 79 S368 105 400 69 S447 54 480 68 S525 24 560 31 L560 180 L0 180Z" fill="url(#fill)"/><path d="M0 138 C35 130 43 103 80 112 S130 142 160 101 S207 93 240 107 S287 65 320 79 S368 105 400 69 S447 54 480 68 S525 24 560 31" fill="none" stroke="#7666ed" strokeWidth="3" vectorEffect="non-scaling-stroke"/></svg><div className="chart-x"><span>شنبه</span><span>یکشنبه</span><span>دوشنبه</span><span>سه‌شنبه</span><span>چهارشنبه</span><span>پنجشنبه</span><span>جمعه</span></div></div></div></section></div>
        <section className="panel bottom-panel"><div className="panel-head"><div><h2>خلاصه امروز</h2><p>آمار عملکرد روز جاری</p></div><span className="date-chip">به‌روزرسانی لحظه‌ای <i/></span></div><div className="today-grid"><div><span>اتصال‌های جدید</span><b>۲۴۸</b><small className="positive">+۱۸٪ از دیروز</small></div><div><span>اشتراک تمدیدشده</span><b>۶۷</b><small className="positive">+۹٪ از دیروز</small></div><div><span>درخواست پشتیبانی</span><b>۱۲</b><small>۳ مورد پاسخ داده نشده</small></div><div><span>میانگین زمان اتصال</span><b>۲۴ <small>ms</small></b><small className="positive">عملکرد عالی</small></div></div></section></>}
      {section === 'users' && <section className="panel full-panel"><div className="panel-head"><div><h2>فهرست کاربران</h2><p>{users.length} حساب کاربری متصل به اپ</p></div><button className="primary-btn" onClick={() => openUserModal()}><Plus size={17}/> افزودن کاربر</button></div><div className="table-toolbar"><div className="search-box"><Search size={17}/><input placeholder="جست‌وجو بین کاربران..." value={search} onChange={e => setSearch(e.target.value)}/></div><button className="soft-btn" onClick={() => setSearch('')}>پاک‌کردن جست‌وجو <X size={15}/></button></div><UserTable users={filteredUsers} loading={loading} expanded onEdit={openUserModal} onDelete={deleteUser}/></section>}
      {section === 'plans' && <SubscriptionView token={token} plans={plans} onPlans={setPlans} onNotify={notify}/>}
      {section === 'subscriptions' && <UserSubscriptionsView token={token} plans={plans} subscriptions={userSubscriptions} loading={subscriptionLoading} loadError={subscriptionLoadError} busyIds={subscriptionBusy} onToggle={setUserBlocked} onUpdate={updated => setUserSubscriptions(current => current.map(item => String(item.userId) === String(updated.userId) ? { ...item, ...updated, userId: String(updated.userId), blocked: item.blocked, active: new Date(updated.expiresAt).getTime() > Date.now() && Number(updated.usedBytes) < Number(updated.quotaBytes) } : item))} onNotify={notify}/>}
      {section === 'socks' && <SocksView token={token} onNotify={notify}/>}
      {section === 'gateway' && <BluePalSettingsView token={token} onNotify={notify}/>}
      {section === 'chat' && <section className="panel chat-panel"><div className="admin-chat-layout"><aside className="chat-conversations"><div className="chat-list-heading"><div><h2>گفت‌وگوها</h2><span>{new Intl.NumberFormat('fa-IR').format(conversations.length)} کاربر</span></div>{unreadChatCount > 0 && <b className="chat-total-unread">{new Intl.NumberFormat('fa-IR').format(unreadChatCount)} خوانده‌نشده</b>}</div><div className="chat-list-scroll">{conversations.length ? conversations.map(conversation => <button type="button" key={conversation.userId} className={`chat-conversation ${selectedChatUserId === String(conversation.userId) ? 'selected' : ''}`} onClick={() => setSelectedChatUserId(String(conversation.userId))}><span className="chat-list-avatar">{(conversation.name || 'ک').slice(0, 1)}</span><span className="chat-list-copy"><b>{conversation.name}</b><small>{conversation.lastMessage || conversation.username}</small></span>{Number(conversation.unreadCount) > 0 && <i className="chat-unread-badge">{new Intl.NumberFormat('fa-IR').format(Number(conversation.unreadCount))}</i>}</button>) : <div className="chat-list-empty">{chatLoadError || 'هنوز گفت‌وگویی ثبت نشده است.'}</div>}</div></aside><div className="chat-thread"><div className="chat-heading"><div className="support-avatar"><MessageCircle size={20}/><i/></div><div className="admin-chat-head"><h2>{conversations.find(item => String(item.userId) === selectedChatUserId)?.name || 'پشتیبانی فیلترشکن'}</h2><span>{conversations.find(item => String(item.userId) === selectedChatUserId)?.username || 'یک گفت‌وگو را انتخاب کنید'}</span></div><button className="icon-btn chat-more" onClick={() => notify('گفت‌وگوها هر چند ثانیه تازه می‌شوند.')}><MoreHorizontal size={20}/></button></div><div className="chat-body">{messages.length ? messages.map(msg => { const mine = msg.senderRole === 'admin'; return <div key={msg.id} className={`message-row ${mine ? 'mine' : ''}`}><div className={`chat-avatar ${mine ? 'self' : ''}`}>{mine ? 'م' : (msg.author || 'ک').slice(0, 1)}</div><div className="message-content"><span className="message-author">{mine ? 'پشتیبانی' : msg.author}</span><div className="bubble">{msg.text}</div><span className="message-time">{msg.time}</span></div></div>; }) : <div className="empty-state">{selectedChatUserId ? 'پیامی در این گفت‌وگو نیست؛ اولین پیام را بفرستید.' : chatLoadError || 'برای شروع، یک گفت‌وگو را از فهرست انتخاب کنید.'}</div>}</div><form className="chat-compose" onSubmit={sendMessage}><button className="attach-btn" type="button" onClick={() => notify('ارسال فایل پشتیبانی نمی‌شود.')}><Plus size={20}/></button><input placeholder={selectedChatUserId ? 'پیام خود را بنویسید...' : 'ابتدا گفت‌وگو را انتخاب کنید'} value={draft} onChange={e => setDraft(e.target.value)} disabled={!selectedChatUserId}/><button className="send-btn" title="ارسال پیام" disabled={!selectedChatUserId}><Send size={17}/></button></form></div></div></section>}
      <footer className="page-footer"><span>© ۱۴۰۴ فیلترشکن</span><div><button onClick={() => notify('مرکز راهنما به‌زودی در دسترس خواهد بود.')}>راهنما</button><i/><button onClick={() => notify('وضعیت حریم خصوصی شما امن است.')}>حریم خصوصی</button><i/><button onClick={() => notify('نسخه ۱.۰.۰')}>نسخه ۱.۰.۰</button></div><span><Command size={13}/> ساخته‌شده برای مدیریت بهتر</span></footer>
    </div></main>{userModal && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setUserModal(false); }}><form className="user-dialog" onSubmit={saveUser}><div className="dialog-heading"><div><span>مدیریت حساب اپ</span><h2>{userForm.id ? 'ویرایش کاربر' : 'افزودن کاربر جدید'}</h2></div><button type="button" className="icon-btn" onClick={() => setUserModal(false)}><X size={18}/></button></div><label>نام نمایشی<input required minLength={2} maxLength={80} value={userForm.name} onChange={event => setUserForm({ ...userForm, name: event.target.value })} placeholder="نام و نام خانوادگی"/></label><label>ایمیل یا نام کاربری<input required value={userForm.username} onChange={event => setUserForm({ ...userForm, username: event.target.value })} placeholder="user@example.com"/></label><label>{userForm.id ? 'رمز تازه (اختیاری)' : 'رمز ورود اپ'}<input type="password" minLength={userForm.id && !userForm.password ? undefined : 8} autoComplete="new-password" required={!userForm.id} value={userForm.password} onChange={event => setUserForm({ ...userForm, password: event.target.value })} placeholder={userForm.id ? 'برای حفظ رمز قبلی خالی بگذارید' : 'حداقل ۸ نویسه'}/></label><div className="user-form-row"><label>اشتراک<select value={userForm.plan} onChange={event => setUserForm({ ...userForm, plan: event.target.value })}><option>آزمایشی</option><option>پایه</option><option>حرفه‌ای</option></select></label><label>وضعیت<input readOnly value="خودکار بر اساس اتصال VPN"/></label></div>{userError && <div className="user-form-error">{userError}</div>}<div className="dialog-actions"><button type="button" className="soft-btn" onClick={() => setUserModal(false)}>انصراف</button><button className="primary-btn" disabled={userBusy}>{userBusy ? 'در حال ذخیره...' : userForm.id ? 'ذخیره تغییرات' : 'ساخت حساب کاربر'}</button></div><p className="dialog-hint">کاربر می‌تواند با همین نام کاربری و رمز در اپ موبایل وارد شود.</p></form></div>}{toast && <div className="toast"><Check size={17}/>{toast}</div>}</div>;
}

function Stat({ icon, label, value, detail, tone, trend }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string; trend: string }) { return <section className="stat-card"><div className="stat-top"><span className={`stat-icon ${tone}`}>{icon}</span><button className="trend-pill"><ArrowUpLeft size={13}/>{trend}</button></div><span className="stat-label">{label}</span><strong>{value}</strong><span className="stat-detail">{detail}</span></section>; }
function lastSeenLabel(user: User) {
  if (user.status === 'آنلاین') return 'هم‌اکنون';
  const time = new Date(user.lastSeen);
  if (Number.isNaN(time.getTime())) return user.lastSeen;
  return time.toLocaleString('fa-IR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function UserTable({ users, loading, expanded = false, onEdit, onDelete }: { users: User[]; loading: boolean; expanded?: boolean; onEdit?: (user: User) => void; onDelete?: (user: User) => void }) { return <div className="table-scroll"><table><thead><tr><th>کاربر</th><th>وضعیت</th><th>نوع اشتراک</th><th>آخرین اتصال</th>{expanded && <th>عملیات</th>}</tr></thead><tbody>{loading ? <tr><td colSpan={expanded ? 5 : 4} className="empty-state">در حال دریافت اطلاعات...</td></tr> : users.length ? users.map(user => <tr key={user.id}><td><div className="user-cell"><div className={`avatar user-${user.id}`}>{user.name.slice(0, 1)}</div><div><b>{user.name}</b><span>{user.username}</span></div></div></td><td><span className={`status ${user.status === 'آنلاین' ? 'online' : 'offline'}`}><i/>{user.status}</span></td><td><span className={`plan-chip ${user.plan === 'حرفه‌ای' ? 'pro' : user.plan === 'پایه' ? 'basic' : 'trial'}`}>{user.plan}</span></td><td className="last-seen">{lastSeenLabel(user)}</td>{expanded && <td><div className="user-actions"><button className="icon-btn" title="ویرایش کاربر" onClick={() => onEdit?.(user)}><Pencil size={16}/></button><button className="icon-btn danger-action" title="حذف کاربر" onClick={() => onDelete?.(user)}><Trash2 size={16}/></button></div></td>}</tr>) : <tr><td colSpan={expanded ? 5 : 4} className="empty-state">کاربری پیدا نشد.</td></tr>}</tbody></table></div>; }
function SocksView({ token, onNotify }: { token: string; onNotify: (text: string) => void }) {
  const [proxies, setProxies] = useState<ProxyEntry[]>([]); const [draft, setDraft] = useState<Partial<ProxyEntry> | null>(null);
  const [visiblePasswords, setVisiblePasswords] = useState<number[]>([]); const [showDraftPassword, setShowDraftPassword] = useState(false);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const refresh = async (signal?: AbortSignal) => { const rows = await api<ProxyEntry[]>('/api/proxies', token, signal); setProxies(rows); };
  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch(() => {}).finally(() => setLoading(false));
    return () => controller.abort();
  }, [token]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!draft) return; setSaving(true); setError('');
    try {
      const editing = Boolean(draft.id); const response = await fetch(`/api/proxies${editing ? `?id=${draft.id}` : ''}`, { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...draft, port: Number(draft.port), active: draft.active ?? true }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || 'ذخیره ساکس انجام نشد.');
      await refresh(); setDraft(null); onNotify('ساکس ذخیره شد. اپ‌ها از میان ساکس‌های فعال به‌صورت تصادفی انتخاب می‌کنند.');
    } catch (error) { setError(error instanceof Error ? error.message : 'ذخیره ساکس انجام نشد.'); }
    finally { setSaving(false); }
  };
  const toggleActive = async (proxy: ProxyEntry) => {
    try { const response = await fetch(`/api/proxies?id=${proxy.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...proxy, active: !proxy.active }) }); const result = await response.json(); if (!response.ok) throw new Error(result.message || 'تغییر وضعیت انجام نشد.'); setProxies(current => current.map(item => item.id === proxy.id ? result : item)); }
    catch (error) { onNotify(error instanceof Error ? error.message : 'تغییر وضعیت انجام نشد.'); }
  };
  const remove = async (proxy: ProxyEntry) => {
    if (!window.confirm(`ساکس «${proxy.name}» حذف شود؟`)) return;
    try { const response = await fetch(`/api/proxies?id=${proxy.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); const result = await response.json(); if (!response.ok) throw new Error(result.message || 'حذف ساکس انجام نشد.'); setProxies(current => current.filter(item => item.id !== proxy.id)); onNotify('ساکس حذف شد.'); }
    catch (error) { onNotify(error instanceof Error ? error.message : 'حذف ساکس انجام نشد.'); }
  };
  const openNew = () => { setError(''); setShowDraftPassword(false); setDraft({ name: '', host: '', port: 1080, username: '', password: '', active: true }); };
  return <><section className="panel full-panel"><div className="panel-head"><div><h2>مدیریت ساکس‌ها</h2><p>اپ موبایل بعد از ورود، یکی از ساکس‌های فعال را به‌صورت تصادفی دریافت می‌کند.</p></div><button className="primary-btn" onClick={openNew}><Plus size={16}/> افزودن ساکس</button></div><div className="table-scroll"><table><thead><tr><th>نام</th><th>IP / میزبان</th><th>پورت</th><th>نام کاربری</th><th>رمز عبور</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="empty-state">در حال دریافت فهرست ساکس‌ها...</td></tr> : proxies.length ? proxies.map(proxy => { const passwordVisible = visiblePasswords.includes(proxy.id); return <tr key={proxy.id}><td><b>{proxy.name}</b></td><td>{proxy.host}</td><td>{proxy.port.toLocaleString('fa-IR')}</td><td>{proxy.username || 'بدون احراز هویت'}</td><td><div className="password-cell"><span>{passwordVisible ? (proxy.password || 'بدون رمز') : '••••••••'}</span><button type="button" className="text-btn" aria-label={passwordVisible ? 'پنهان کردن رمز' : 'نمایش رمز'} onClick={() => setVisiblePasswords(current => passwordVisible ? current.filter(id => id !== proxy.id) : [...current, proxy.id])}>{passwordVisible ? 'پنهان' : 'نمایش'}</button></div></td><td><button type="button" role="switch" aria-checked={proxy.active} className={`access-switch ${proxy.active ? '' : 'is-blocked'}`} onClick={() => toggleActive(proxy)}><span/><b>{proxy.active ? 'فعال' : 'غیرفعال'}</b></button></td><td><div className="user-actions"><button type="button" className="icon-btn" title="ویرایش ساکس" onClick={() => { setError(''); setShowDraftPassword(false); setDraft({ ...proxy }); }}><Pencil size={16}/></button><button type="button" className="icon-btn danger-action" title="حذف ساکس" onClick={() => remove(proxy)}><Trash2 size={16}/></button></div></td></tr>; }) : <tr><td colSpan={7} className="empty-state">هنوز ساکسی اضافه نشده است.</td></tr>}</tbody></table></div></section>
    {draft && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setDraft(null); }}><form className="user-dialog" onSubmit={save}><div className="dialog-heading"><div><span>مدیریت پراکسی سرور</span><h2>{draft.id ? 'ویرایش ساکس' : 'ساکس جدید'}</h2></div><button type="button" className="icon-btn" onClick={() => setDraft(null)}><X size={18}/></button></div><label>نام ساکس<input required minLength={2} maxLength={80} value={draft.name || ''} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="مثلاً سرور آلمان ۱"/></label><label>آدرس IP یا میزبان<input required maxLength={253} value={draft.host || ''} onChange={event => setDraft({ ...draft, host: event.target.value })} placeholder="203.0.113.10"/></label><div className="user-form-row"><label>پورت<input type="number" min="1" max="65535" required value={draft.port || ''} onChange={event => setDraft({ ...draft, port: Number(event.target.value) })}/></label><label>نام کاربری<input autoComplete="off" value={draft.username || ''} onChange={event => setDraft({ ...draft, username: event.target.value })}/></label></div><label>رمز عبور<div className="password-input-row"><input type={showDraftPassword ? 'text' : 'password'} autoComplete="new-password" value={draft.password || ''} onChange={event => setDraft({ ...draft, password: event.target.value })}/><button type="button" className="text-btn" onClick={() => setShowDraftPassword(value => !value)}>{showDraftPassword ? 'پنهان کردن' : 'نمایش'}</button></div></label>{error && <div className="user-form-error">{error}</div>}<div className="dialog-actions"><button type="button" className="soft-btn" onClick={() => setDraft(null)}>انصراف</button><button className="primary-btn" disabled={saving}>{saving ? 'در حال ذخیره...' : 'ذخیره ساکس'}</button></div></form></div>}</>;
}
function UserSubscriptionsView({ token, plans, subscriptions, loading, loadError, busyIds, onToggle, onUpdate, onNotify }: { token: string; plans: any[]; subscriptions: UserSubscription[]; loading: boolean; loadError: string; busyIds: string[]; onToggle: (subscription: UserSubscription, blocked: boolean) => void; onUpdate: (subscription: any) => void; onNotify: (text: string) => void }) {
  const [draft, setDraft] = useState<UserSubscription | null>(null);
  const [quotaMegabytes, setQuotaMegabytes] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [planId, setPlanId] = useState(0);
  const [saving, setSaving] = useState(false);
  const date = (value: string) => value ? new Date(value).toLocaleDateString('fa-IR', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const megabytes = (bytes: string) => `${(Number(bytes || 0) / 1048576).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} مگابایت`;
  const openEdit = (subscription: UserSubscription) => { setDraft(subscription); setQuotaMegabytes(Number(subscription.quotaBytes) / 1048576); setDurationDays(Number(subscription.durationDays) || 30); setPlanId(Number(subscription.planId) || Number(plans[0]?.id) || 0); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!draft) return; setSaving(true);
    try {
      const response = await fetch('/api/user-subscriptions', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ userId: Number(draft.userId), planId, durationDays, quotaBytes: Math.round(quotaMegabytes * 1048576) }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || 'ویرایش اشتراک انجام نشد.');
      onUpdate(result); onNotify('اشتراک کاربر به‌روزرسانی شد.'); setDraft(null);
    } catch (error) { onNotify(error instanceof Error ? error.message : 'ویرایش اشتراک انجام نشد.'); }
    finally { setSaving(false); }
  };
  return <><section className="panel full-panel"><div className="panel-head"><div><h2>اشتراک‌های کاربران</h2><p>اشتراک‌های واگذارشده، بازهٔ اعتبار، حجم مصرف‌شده و دسترسی اتصال کاربران</p></div><span className="date-chip"><i/>{subscriptions.length.toLocaleString('fa-IR')} اشتراک فعال و غیرفعال</span></div>{loadError && <div className="user-form-error" role="alert">{loadError}</div>}<div className="table-scroll"><table><thead><tr><th>کاربر</th><th>پلن</th><th>شروع</th><th>پایان</th><th>مصرف / کل (مگابایت)</th><th>وضعیت</th><th>دسترسی</th><th>عملیات</th></tr></thead><tbody>{subscriptions.length ? subscriptions.map(subscription => <tr key={subscription.userId}><td><div className="user-cell"><div className="avatar">{subscription.userName.slice(0, 1)}</div><div><b>{subscription.userName}</b><span>{subscription.username}</span></div></div></td><td><span className={`plan-chip ${subscription.planName === 'حرفه‌ای' ? 'pro' : subscription.planName === 'پایه' ? 'basic' : 'trial'}`}>{subscription.planName || '—'}</span></td><td>{date(subscription.startedAt)}</td><td>{date(subscription.expiresAt)}</td><td>{megabytes(subscription.usedBytes)} / {megabytes(subscription.quotaBytes)}</td><td><span className={`status ${subscription.active && !subscription.blocked ? 'online' : 'offline'}`}><i/>{subscription.blocked ? 'مسدود' : subscription.active ? 'فعال' : 'پایان‌یافته'}</span></td><td><button type="button" role="switch" aria-checked={!subscription.blocked} aria-label={`${subscription.blocked ? 'فعال‌سازی' : 'مسدودسازی'} دسترسی ${subscription.userName}`} disabled={busyIds.includes(String(subscription.userId))} className={`access-switch ${subscription.blocked ? 'is-blocked' : ''}`} onClick={() => onToggle(subscription, !subscription.blocked)}><span/><b>{subscription.blocked ? 'مسدود' : 'مجاز'}</b></button></td><td><button type="button" className="icon-btn" title="ویرایش اشتراک" onClick={() => openEdit(subscription)}><Pencil size={16}/></button></td></tr>) : <tr><td colSpan={8} className="empty-state">{loading ? 'در حال دریافت اشتراک‌های ثبت‌شده در سایت...' : loadError ? 'دریافت اشتراک‌ها ناموفق بود.' : 'هنوز اشتراکی برای کاربران ثبت نشده است.'}</td></tr>}</tbody></table></div></section>
    {draft && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setDraft(null); }}><form className="user-dialog" onSubmit={save}><div className="dialog-heading"><div><span>مدیریت اشتراک کاربر</span><h2>{draft.userName}</h2></div><button type="button" className="icon-btn" onClick={() => setDraft(null)}><X size={18}/></button></div><label>پلن اشتراک<select required value={planId} onChange={event => setPlanId(Number(event.target.value))}>{plans.filter(plan => plan.active).map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label><div className="user-form-row"><label>حجم کل (مگابایت)<input type="number" min="1" step="1" required value={quotaMegabytes} onChange={event => setQuotaMegabytes(Number(event.target.value))}/></label><label>مدت اعتبار (روز)<input type="number" min="1" max="3650" required value={durationDays} onChange={event => setDurationDays(Number(event.target.value))}/></label></div><p className="dialog-hint">تغییر حجم، پلن یا مدت، مصرف فعلی کاربر را حفظ می‌کند.</p><div className="dialog-actions"><button type="button" className="soft-btn" onClick={() => setDraft(null)}>انصراف</button><button className="primary-btn" disabled={saving || !planId}>{saving ? 'در حال ذخیره...' : 'ذخیره اشتراک'}</button></div></form></div>}</>;
}

function SubscriptionView({ token, plans, onPlans, onNotify }: { token: string; plans: any[]; onPlans: (plans: any[]) => void; onNotify: (text: string) => void }) {
  const [draft, setDraft] = useState<any | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const save = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try {
    const editing = Boolean(draft.id); const { quotaMegabytes, featuresText, ...planData } = draft; const response = await fetch(`/api/subscriptions${editing ? `?id=${draft.id}` : ''}`, { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...planData, quotaBytes: Math.round(Number(quotaMegabytes) * 1048576), features: String(featuresText || '').split('\n').map((item: string) => item.trim()).filter(Boolean) }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.message || 'ذخیره اشتراک انجام نشد.'); onPlans(editing ? plans.map(plan => plan.id === result.id ? { ...result, users: draft.users } : plan) : [...plans, { ...result, users: 0 }]); setDraft(null); onNotify('اطلاعات اشتراک ذخیره شد.');
  } catch (e) { setError(e instanceof Error ? e.message : 'ذخیره اشتراک انجام نشد.'); } finally { setBusy(false); } };
  const deletePlan = async (plan: any) => {
    if (!window.confirm(`پلن «${plan.name}» حذف شود؟ پلن‌های ثبت‌شده در سابقهٔ اشتراک کاربران قابل حذف نیستند.`)) return;
    try {
      const response = await fetch(`/api/subscriptions?id=${encodeURIComponent(plan.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || 'حذف پلن انجام نشد.');
      onPlans(plans.filter(item => item.id !== plan.id)); onNotify('پلن حذف شد.');
    } catch (error) { onNotify(error instanceof Error ? error.message : 'حذف پلن انجام نشد.'); }
  };
  const fmt = (bytes: number) => `${(bytes / 1048576).toLocaleString('fa-IR', { maximumFractionDigits: 2 })} مگابایت`;
  return <><section className="panel full-panel"><div className="panel-head"><div><h2>پلن‌های اشتراک</h2><p>حجم، مدت اعتبار، قیمت و دستگاه مجاز از دیتابیس خوانده می‌شوند.</p></div><button className="primary-btn" onClick={() => setDraft({ name: '', description: '', priceIrr: 0, quotaMegabytes: 10240, durationDays: 30, simultaneousDevices: 1, active: true, featuresText: '' })}><Plus size={16}/> ساخت اشتراک</button></div><div className="subscription-cards">{plans.map((plan, index) => <section className="panel plan-card" key={plan.id}><div className="plan-card-top"><div className={`plan-symbol ${['violet','blue','amber'][index % 3]}`}><CreditCard size={19}/></div><div className="user-actions"><button className="icon-btn" title="ویرایش پلن" onClick={() => setDraft({ ...plan, quotaMegabytes: Number(plan.quotaBytes) / 1048576, featuresText: (plan.features || []).join('\n') })}><Pencil size={17}/></button><button className="icon-btn danger-action" title="حذف پلن" onClick={() => deletePlan(plan)}><Trash2 size={16}/></button></div></div><h2>{plan.name}</h2><p>{plan.description}</p><div className="plan-price"><b>{Number(plan.priceIrr) ? Number(plan.priceIrr).toLocaleString('fa-IR') : 'رایگان'}</b>{Number(plan.priceIrr) > 0 && <span> تومان</span>}</div><div className="plan-users"><Users size={15}/>{Number(plan.users).toLocaleString('fa-IR')} کاربر</div><hr/><div className="feature"><Activity size={15}/>{fmt(Number(plan.quotaBytes))} حجم</div><div className="feature"><Check size={15}/>{Number(plan.durationDays).toLocaleString('fa-IR')} روز اعتبار</div><div className="feature"><Users size={15}/>{Number(plan.simultaneousDevices).toLocaleString('fa-IR')} دستگاه هم‌زمان</div>{(plan.features || []).map((feature: string) => <div className="feature" key={feature}><Check size={15}/>{feature}</div>)}</section>)}</div></section>
  {draft && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setDraft(null); }}><form className="user-dialog" onSubmit={save}><div className="dialog-heading"><div><span>مدیریت اشتراک</span><h2>{draft.id ? 'ویرایش پلن' : 'پلن جدید'}</h2></div><button type="button" className="icon-btn" onClick={() => setDraft(null)}><X size={18}/></button></div><label>نام اشتراک<input required minLength={2} maxLength={80} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label><label>توضیح<input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label><div className="user-form-row"><label>قیمت (تومان)<input type="number" min="0" required value={draft.priceIrr} onChange={e => setDraft({ ...draft, priceIrr: Number(e.target.value) })}/></label><label>حجم (مگابایت)<input type="number" min="1" step="1" required value={draft.quotaMegabytes} onChange={e => setDraft({ ...draft, quotaMegabytes: Number(e.target.value) })}/></label></div><div className="user-form-row"><label>مدت (روز)<input type="number" min="1" required value={draft.durationDays} onChange={e => setDraft({ ...draft, durationDays: Number(e.target.value) })}/></label><label>دستگاه هم‌زمان<input type="number" min="1" required value={draft.simultaneousDevices} onChange={e => setDraft({ ...draft, simultaneousDevices: Number(e.target.value) })}/></label></div><label>ویژگی‌ها (هر مورد یک خط)<textarea value={draft.featuresText} onChange={e => setDraft({ ...draft, featuresText: e.target.value })}/></label>{error && <div className="user-form-error">{error}</div>}<div className="dialog-actions"><button type="button" className="soft-btn" onClick={() => setDraft(null)}>انصراف</button><button className="primary-btn" disabled={busy}>{busy ? 'در حال ذخیره...' : 'ذخیره اشتراک'}</button></div></form></div>}</>;
}

export default App;

