import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowUpLeft, Bell, Check, ChevronDown, CircleHelp, Command, CreditCard, LayoutDashboard, LogOut, Menu, MessageCircle, MoreHorizontal, Pencil, Plus, Search, Send, Settings, ShieldCheck, Trash2, Users, Wifi, X } from 'lucide-react';

type User = { id: string; name: string; username: string; status: string; plan: string; lastSeen: string; subscriptionStartedAt?: string; subscriptionExpiresAt?: string; subscriptionQuotaBytes?: string; subscriptionUsedBytes?: string };
type UserForm = { id?: string; name: string; username: string; plan: string; password: string };
const newUserForm: UserForm = { name: '', username: '', plan: 'آزمایشی', password: '' };
type Message = { author: string; text: string; time: string };
const initialMessages: Message[] = [
  { author: 'شما', text: 'سلام، وقت بخیر! وضعیت اتصال کاربران چطور است؟', time: '۱۰:۲۴' },
  { author: 'پشتیبانی', text: 'سلام، وقت شما هم بخیر. همه سرورها در وضعیت پایدار هستند و اتصال کاربران بدون مشکل برقرار است.', time: '۱۰:۲۶' },
  { author: 'شما', text: 'عالیه، ممنون از پیگیریتون 🙌', time: '۱۰:۲۸' },
  { author: 'پشتیبانی', text: 'خواهش می‌کنم. اگر موردی بود همین‌جا پیام بدید، در خدمتیم.', time: '۱۰:۲۹' },
];

class ApiError extends Error {
  constructor(public status: number) { super('دریافت اطلاعات با خطا مواجه شد.'); }
}

async function api<T>(url: string, token: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
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

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('fs-token') || ''); const [admin, setAdmin] = useState(() => sessionStorage.getItem('fs-user') || 'ehsan');
  const [section, setSection] = useState('dashboard'); const [users, setUsers] = useState<User[]>([]); const [plans, setPlans] = useState<any[]>([]); const [search, setSearch] = useState(''); const [mobileMenu, setMobileMenu] = useState(false); const [messages, setMessages] = useState(initialMessages); const [draft, setDraft] = useState(''); const [toast, setToast] = useState(''); const [loading, setLoading] = useState(false);
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
    api<Message[]>('/api/chat', token, controller.signal).then(rows => {
      if (!stopped && rows.length) setMessages(rows.map(row => ({ ...row, time: new Date(row.time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) })));
    }).catch(() => {});
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [token]);
  const filteredUsers = useMemo(() => users.filter(u => `${u.name} ${u.username} ${u.plan}`.includes(search)), [users, search]);
  const login = (newToken: string, username: string) => { sessionStorage.setItem('fs-token', newToken); sessionStorage.setItem('fs-user', username); setAdmin(username); setToken(newToken); };
  const logout = () => { sessionStorage.clear(); setToken(''); setSection('dashboard'); };
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
  const sendMessage = async (event: React.FormEvent) => { event.preventDefault(); if (!draft.trim()) return; try { const message = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ message: draft }) }).then(r => r.json()); setMessages(current => [...current, { author: message.author, text: message.text, time: new Date(message.time).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) }]); setDraft(''); } catch { notify('ارسال پیام انجام نشد.'); } };
  if (!token) return <Login onLogin={login}/>;
  const nav = [{ id: 'dashboard', label: 'داشبورد', icon: LayoutDashboard }, { id: 'users', label: 'کاربران', icon: Users, count: users.length }, { id: 'subscriptions', label: 'اشتراک‌ها', icon: CreditCard }, { id: 'chat', label: 'چت و پشتیبانی', icon: MessageCircle, dot: true }];
  const title = ({ dashboard: 'داشبورد', users: 'کاربران', subscriptions: 'اشتراک‌ها', chat: 'چت و پشتیبانی' } as Record<string, string>)[section];
  return <div className="app-shell"><aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}><div className="brand"><div className="brand-mark"><Wifi size={22}/></div><div><b>فیلترشکن</b><span>پنل مدیریت</span></div><button className="icon-btn close-menu" onClick={() => setMobileMenu(false)}><X size={19}/></button></div>
    <div className="workspace"><div className="workspace-logo">F</div><div className="workspace-info"><b>فضای کاری اصلی</b><span>پلن تجاری</span></div><ChevronDown size={16} className="muted"/></div>
    <div className="nav-caption">منوی اصلی</div><nav>{nav.map(item => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => { setSection(item.id); setMobileMenu(false); }}><item.icon size={19}/><span>{item.label}</span>{item.count !== undefined && <small>{item.count}</small>}{item.dot && <i className="nav-dot"/>}</button>)}</nav>
    <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><CircleHelp size={18}/></div><b>به راهنمایی نیاز دارید؟</b><p>تیم ما همیشه کنار شماست.</p><button onClick={() => setSection('chat')}>گفت‌وگو با پشتیبانی <ArrowUpLeft size={14}/></button></div><button className="nav-item settings-link" onClick={() => notify('تنظیمات به‌زودی در دسترس خواهد بود.')}><Settings size={19}/><span>تنظیمات</span></button><div className="profile"><div className="avatar admin-avatar">ا</div><div className="profile-info"><b>{admin}</b><span>مدیر کل</span></div><button className="icon-btn" title="خروج" onClick={logout}><LogOut size={17}/></button></div></div>
  </aside><div className={`mobile-scrim ${mobileMenu ? 'show' : ''}`} onClick={() => setMobileMenu(false)}/>
  <main className="main-area"><header className="topbar"><div className="topbar-left"><button className="icon-btn mobile-trigger" onClick={() => setMobileMenu(true)}><Menu size={21}/></button><div className="breadcrumb">صفحات <span>/</span> <b>{title}</b></div></div><div className="topbar-actions"><div className="status-pill"><i/> همه سیستم‌ها فعال</div><button className="icon-btn notification" onClick={() => notify('اعلان جدیدی ندارید.')}><Bell size={19}/><i/></button><div className="top-divider"/><div className="top-profile"><div className="avatar admin-avatar">ا</div><div><b>{admin}</b><span>مدیر سیستم</span></div><ChevronDown size={15}/></div></div></header>
    <div className="page-content"><div className="page-heading"><div><div className="welcome-line">چه خبر، {admin}؟ <span>✦</span></div><h1>{title}</h1><p>وضعیت سرویس و فعالیت کاربران را در یک نگاه ببینید.</p></div><div className="heading-date"><div className="date-dot"/><span>امروز</span><b>{new Intl.DateTimeFormat('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</b></div></div>
      {section === 'dashboard' && <><div className="stats-grid"><Stat icon={<Users size={20}/>} label="کل کاربران" value={new Intl.NumberFormat('fa-IR').format(users.length)} detail="حساب‌های ثبت‌شده در دیتابیس" tone="violet" trend="واقعی"/><Stat icon={<Activity size={20}/>} label="کاربران آنلاین" value={new Intl.NumberFormat('fa-IR').format(users.filter(user => user.status === 'آنلاین').length)} detail="متصل به VPN" tone="green" trend="لحظه‌ای"/><Stat icon={<CreditCard size={20}/>} label="اشتراک فعال" value="۹۴۲" detail="۷۵٪ از کل کاربران" tone="blue" trend="+۵٪"/><Stat icon={<CreditCard size={20}/>} label="درآمد این ماه" value="۲۸٫۶ م" detail="نسبت به ماه گذشته" tone="amber" trend="+۱۸٪"/></div>
        <div className="dashboard-grid"><section className="panel users-panel"><div className="panel-head"><div><h2>کاربران اخیر</h2><p>آخرین وضعیت کاربران سرویس</p></div><button className="soft-btn" onClick={() => setSection('users')}>مشاهده همه <ArrowUpLeft size={15}/></button></div><UserTable users={users.slice(0, 5)} loading={loading}/></section><section className="panel activity-panel"><div className="panel-head"><div><h2>نمای کلی سرویس</h2><p>گزارش هفت روز گذشته</p></div><button className="icon-btn" onClick={() => notify('گزارش‌ها به‌روز هستند.')}><MoreHorizontal size={20}/></button></div><div className="chart-summary"><div><strong>۸٬۴۹۲</strong><span>اتصال موفق</span></div><span className="chart-growth"><ArrowUpLeft size={14}/> ۱۲٪</span></div><div className="chart"><div className="chart-y"><span>۱۰۰۰</span><span>۷۵۰</span><span>۵۰۰</span><span>۲۵۰</span><span>۰</span></div><div className="chart-plot"><div className="grid-lines"><i/><i/><i/><i/><i/></div><svg viewBox="0 0 560 180" preserveAspectRatio="none" aria-label="نمودار اتصال"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#7565ee" stopOpacity=".22"/><stop offset="1" stopColor="#7565ee" stopOpacity="0"/></linearGradient></defs><path d="M0 138 C35 130 43 103 80 112 S130 142 160 101 S207 93 240 107 S287 65 320 79 S368 105 400 69 S447 54 480 68 S525 24 560 31 L560 180 L0 180Z" fill="url(#fill)"/><path d="M0 138 C35 130 43 103 80 112 S130 142 160 101 S207 93 240 107 S287 65 320 79 S368 105 400 69 S447 54 480 68 S525 24 560 31" fill="none" stroke="#7666ed" strokeWidth="3" vectorEffect="non-scaling-stroke"/></svg><div className="chart-x"><span>شنبه</span><span>یکشنبه</span><span>دوشنبه</span><span>سه‌شنبه</span><span>چهارشنبه</span><span>پنجشنبه</span><span>جمعه</span></div></div></div></section></div>
        <section className="panel bottom-panel"><div className="panel-head"><div><h2>خلاصه امروز</h2><p>آمار عملکرد روز جاری</p></div><span className="date-chip">به‌روزرسانی لحظه‌ای <i/></span></div><div className="today-grid"><div><span>اتصال‌های جدید</span><b>۲۴۸</b><small className="positive">+۱۸٪ از دیروز</small></div><div><span>اشتراک تمدیدشده</span><b>۶۷</b><small className="positive">+۹٪ از دیروز</small></div><div><span>درخواست پشتیبانی</span><b>۱۲</b><small>۳ مورد پاسخ داده نشده</small></div><div><span>میانگین زمان اتصال</span><b>۲۴ <small>ms</small></b><small className="positive">عملکرد عالی</small></div></div></section></>}
      {section === 'users' && <section className="panel full-panel"><div className="panel-head"><div><h2>فهرست کاربران</h2><p>{users.length} حساب کاربری متصل به اپ</p></div><button className="primary-btn" onClick={() => openUserModal()}><Plus size={17}/> افزودن کاربر</button></div><div className="table-toolbar"><div className="search-box"><Search size={17}/><input placeholder="جست‌وجو بین کاربران..." value={search} onChange={e => setSearch(e.target.value)}/></div><button className="soft-btn" onClick={() => setSearch('')}>پاک‌کردن جست‌وجو <X size={15}/></button></div><UserTable users={filteredUsers} loading={loading} expanded onEdit={openUserModal} onDelete={deleteUser}/></section>}
      {section === 'subscriptions' && <SubscriptionView token={token} plans={plans} onPlans={setPlans} onNotify={notify}/>}
      {section === 'chat' && <section className="panel chat-panel"><div className="chat-heading"><div className="support-avatar"><MessageCircle size={20}/><i/></div><div><h2>پشتیبانی فیلترشکن</h2><p><i/> آنلاین و آماده پاسخ‌گویی</p></div><button className="icon-btn chat-more" onClick={() => notify('گفت‌وگو امن و رمزگذاری‌شده است.')}><MoreHorizontal size={20}/></button></div><div className="chat-body"><div className="chat-date"><span>امروز</span></div>{messages.map((msg, i) => <div key={`${i}-${msg.time}`} className={`message-row ${msg.author === 'شما' ? 'mine' : ''}`}><div className={`chat-avatar ${msg.author === 'شما' ? 'self' : ''}`}>{msg.author === 'شما' ? 'ش' : 'پ'}</div><div className="message-content"><span className="message-author">{msg.author}</span><div className="bubble">{msg.text}</div><span className="message-time">{msg.time}</span></div></div>)}</div><form className="chat-compose" onSubmit={sendMessage}><button className="attach-btn" type="button" onClick={() => notify('ارسال فایل به‌زودی فعال می‌شود.')}><Plus size={20}/></button><input placeholder="پیام خود را بنویسید..." value={draft} onChange={e => setDraft(e.target.value)}/><button className="send-btn" title="ارسال پیام"><Send size={17}/></button></form></section>}
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
function SubscriptionView({ token, plans, onPlans, onNotify }: { token: string; plans: any[]; onPlans: (plans: any[]) => void; onNotify: (text: string) => void }) {
  const [draft, setDraft] = useState<any | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const save = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try {
    const editing = Boolean(draft.id); const response = await fetch(`/api/subscriptions${editing ? `?id=${draft.id}` : ''}`, { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...draft, features: String(draft.featuresText || '').split('\n').map((item: string) => item.trim()).filter(Boolean) }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.message || 'ذخیره اشتراک انجام نشد.'); onPlans(editing ? plans.map(plan => plan.id === result.id ? result : plan) : [...plans, result]); setDraft(null); onNotify('اطلاعات اشتراک ذخیره شد.');
  } catch (e) { setError(e instanceof Error ? e.message : 'ذخیره اشتراک انجام نشد.'); } finally { setBusy(false); } };
  const fmt = (bytes: number) => bytes >= 1073741824 ? `${(bytes / 1073741824).toLocaleString('fa-IR')} گیگابایت` : `${(bytes / 1048576).toLocaleString('fa-IR')} مگابایت`;
  return <><section className="panel full-panel"><div className="panel-head"><div><h2>پلن‌های اشتراک</h2><p>حجم، مدت اعتبار، قیمت و دستگاه مجاز از دیتابیس خوانده می‌شوند.</p></div><button className="primary-btn" onClick={() => setDraft({ name: '', description: '', priceIrr: 0, quotaBytes: 10737418240, durationDays: 30, simultaneousDevices: 1, active: true, featuresText: '' })}><Plus size={16}/> ساخت اشتراک</button></div><div className="subscription-cards">{plans.map((plan, index) => <section className="panel plan-card" key={plan.id}><div className="plan-card-top"><div className={`plan-symbol ${['violet','blue','amber'][index % 3]}`}><CreditCard size={19}/></div><button className="icon-btn" onClick={() => setDraft({ ...plan, featuresText: (plan.features || []).join('\n') })}><Pencil size={17}/></button></div><h2>{plan.name}</h2><p>{plan.description}</p><div className="plan-price"><b>{Number(plan.priceIrr) ? Number(plan.priceIrr).toLocaleString('fa-IR') : 'رایگان'}</b>{Number(plan.priceIrr) > 0 && <span> تومان</span>}</div><div className="plan-users"><Users size={15}/>{Number(plan.users).toLocaleString('fa-IR')} کاربر</div><hr/><div className="feature"><Activity size={15}/>{fmt(Number(plan.quotaBytes))} حجم</div><div className="feature"><Check size={15}/>{Number(plan.durationDays).toLocaleString('fa-IR')} روز اعتبار</div><div className="feature"><Users size={15}/>{Number(plan.simultaneousDevices).toLocaleString('fa-IR')} دستگاه هم‌زمان</div>{(plan.features || []).map((feature: string) => <div className="feature" key={feature}><Check size={15}/>{feature}</div>)}</section>)}</div></section>
  {draft && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setDraft(null); }}><form className="user-dialog" onSubmit={save}><div className="dialog-heading"><div><span>مدیریت اشتراک</span><h2>{draft.id ? 'ویرایش پلن' : 'پلن جدید'}</h2></div><button type="button" className="icon-btn" onClick={() => setDraft(null)}><X size={18}/></button></div><label>نام اشتراک<input required minLength={2} maxLength={80} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label><label>توضیح<input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label><div className="user-form-row"><label>قیمت (تومان)<input type="number" min="0" required value={draft.priceIrr} onChange={e => setDraft({ ...draft, priceIrr: Number(e.target.value) })}/></label><label>حجم (بایت)<input type="number" min="1" required value={draft.quotaBytes} onChange={e => setDraft({ ...draft, quotaBytes: Number(e.target.value) })}/></label></div><div className="user-form-row"><label>مدت (روز)<input type="number" min="1" required value={draft.durationDays} onChange={e => setDraft({ ...draft, durationDays: Number(e.target.value) })}/></label><label>دستگاه هم‌زمان<input type="number" min="1" required value={draft.simultaneousDevices} onChange={e => setDraft({ ...draft, simultaneousDevices: Number(e.target.value) })}/></label></div><label>ویژگی‌ها (هر مورد یک خط)<textarea value={draft.featuresText} onChange={e => setDraft({ ...draft, featuresText: e.target.value })}/></label>{error && <div className="user-form-error">{error}</div>}<div className="dialog-actions"><button type="button" className="soft-btn" onClick={() => setDraft(null)}>انصراف</button><button className="primary-btn" disabled={busy}>{busy ? 'در حال ذخیره...' : 'ذخیره اشتراک'}</button></div></form></div>}</>;
}

export default App;

