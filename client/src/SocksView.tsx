import { useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { MAX_PROXY_IMPORT_BYTES, parseProxyImport } from '../../shared/proxyImport';
import { readApiResponse } from './apiResponse';

type ProxyEntry = { id: string; name: string; host: string; port: number; username: string; password: string; active: boolean; updatedAt?: string };

export default function SocksView({ token, onNotify, telegram = false }: {
  token: string; onNotify: (text: string) => void; telegram?: boolean;
}) {
  const [proxies, setProxies] = useState<ProxyEntry[]>([]);
  const [draft, setDraft] = useState<Partial<ProxyEntry> | null>(null);
  const [visiblePasswords, setVisiblePasswords] = useState<string[]>([]);
  const [showDraftPassword, setShowDraftPassword] = useState(false);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [loadError, setLoadError] = useState('');
  const [importing, setImporting] = useState(false), [importError, setImportError] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false), [bulkError, setBulkError] = useState('');
  const importInput = useRef<HTMLInputElement>(null), selectAllInput = useRef<HTMLInputElement>(null);
  const importBusy = useRef(false), bulkPending = useRef(false);
  const busy = saving || importing || bulkBusy;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const chosenIds = useMemo(() => proxies.filter(proxy => selectedSet.has(String(proxy.id))).map(proxy => String(proxy.id)), [proxies, selectedSet]);
  const allSelected = proxies.length > 0 && chosenIds.length === proxies.length;
  const partiallySelected = chosenIds.length > 0 && !allSelected;

  useEffect(() => { if (selectAllInput.current) selectAllInput.current.indeterminate = partiallySelected; }, [partiallySelected]);
  useEffect(() => {
    const currentIds = new Set(proxies.map(proxy => String(proxy.id)));
    setSelectedIds(current => current.filter(id => currentIds.has(id)));
  }, [proxies]);

  const request = async <T,>(url: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> => {
    const scopedUrl = telegram ? url + (url.includes('?') ? '&' : '?') + 'scope=telegram' : url;
    const response = await fetch(scopedUrl, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', signal,
    });
    const result = await readApiResponse<T>(response);
    if (!response.ok) throw new Error((result as any)?.message || `درخواست انجام نشد (HTTP ${response.status}).`);
    return result;
  };
  const refresh = async (signal?: AbortSignal) => { setProxies(await request<ProxyEntry[]>('/api/proxies', 'GET', undefined, signal)); };
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    refresh(controller.signal).catch(error => { if (!controller.signal.aborted) setLoadError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, telegram]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!draft || busy) return;
    setSaving(true); setError('');
    try {
      await request(`/api/proxies${draft.id ? `?id=${draft.id}` : ''}`, draft.id ? 'PATCH' : 'POST', { ...draft, port: Number(draft.port), active: draft.active ?? true });
      await refresh(); setDraft(null); onNotify('ساکس ذخیره شد.');
    } catch (error) { setError(error instanceof Error ? error.message : 'ذخیره ساکس انجام نشد.'); }
    finally { setSaving(false); }
  };
  const toggleActive = async (proxy: ProxyEntry) => {
    if (busy) return; setSaving(true);
    try {
      const result = await request<ProxyEntry>(`/api/proxies?id=${proxy.id}`, 'PATCH', { ...proxy, active: !proxy.active });
      setProxies(current => current.map(item => item.id === proxy.id ? result : item));
    } catch (error) { onNotify(error instanceof Error ? error.message : 'تغییر وضعیت انجام نشد.'); }
    finally { setSaving(false); }
  };
  const remove = async (proxy: ProxyEntry) => {
    if (busy || !window.confirm(`ساکس «${proxy.name}» حذف شود؟`)) return; setSaving(true);
    try { await request(`/api/proxies?id=${proxy.id}`, 'DELETE'); setProxies(current => current.filter(item => item.id !== proxy.id)); onNotify('ساکس حذف شد.'); }
    catch (error) { onNotify(error instanceof Error ? error.message : 'حذف ساکس انجام نشد.'); }
    finally { setSaving(false); }
  };
  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (!file || importBusy.current || busy) return;
    importBusy.current = true; setImporting(true); setImportError('');
    try {
      if (!/\.txt$/i.test(file.name)) throw new Error('لطفاً یک فایل TXT انتخاب کنید.');
      if (file.size > MAX_PROXY_IMPORT_BYTES) throw new Error('حجم فایل TXT باید حداکثر ۱ مگابایت باشد.');
      const content = await file.text(); parseProxyImport(content);
      const result = await request<{ count: number; proxies: ProxyEntry[] }>('/api/proxies/import', 'POST', { content });
      setProxies(current => [...current, ...result.proxies]);
      onNotify(`${result.count.toLocaleString('fa-IR')} ساکس به‌ترتیب به انتهای فهرست اضافه شد.`);
    } catch (error) { setImportError(error instanceof Error ? error.message : 'خواندن یا آپلود فایل انجام نشد.'); }
    finally { importBusy.current = false; setImporting(false); }
  };
  const bulkAction = async (action: 'activate' | 'deactivate' | 'delete') => {
    if (busy || bulkPending.current || !chosenIds.length) return;
    if (action === 'delete' && !window.confirm(`${chosenIds.length.toLocaleString('fa-IR')} ساکس انتخاب‌شده حذف شود؟`)) return;
    bulkPending.current = true; setBulkBusy(true); setBulkError('');
    try {
      const result = await request<{ count: number; ids: string[]; proxies?: Partial<ProxyEntry>[] }>(
        '/api/proxies/bulk', action === 'delete' ? 'DELETE' : 'PATCH',
        { ids: chosenIds, ...(action === 'delete' ? {} : { active: action === 'activate' }) },
      );
      if (action === 'delete') {
        const deleted = new Set(result.ids.map(String));
        setProxies(current => current.filter(proxy => !deleted.has(String(proxy.id))));
        setVisiblePasswords(current => current.filter(id => !deleted.has(id)));
      } else {
        const updates = new Map((result.proxies || []).map(proxy => [String(proxy.id), proxy]));
        setProxies(current => current.map(proxy => updates.has(String(proxy.id)) ? { ...proxy, ...updates.get(String(proxy.id)) } : proxy));
      }
      setSelectedIds([]);
      const verb = action === 'delete' ? 'حذف' : action === 'activate' ? 'فعال' : 'غیرفعال';
      onNotify(`${result.count.toLocaleString('fa-IR')} ساکس ${verb} شد.`);
    } catch (error) { setBulkError(error instanceof Error ? error.message : 'عملیات گروهی انجام نشد.'); }
    finally { bulkPending.current = false; setBulkBusy(false); }
  };
  const toggleSelection = (id: string) => { setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]); };
  const openNew = () => { setError(''); setShowDraftPassword(false); setDraft({ name: '', host: '', port: 1080, username: '', password: '', active: true }); };

  return <><section className="panel full-panel">
    <div className="panel-head socks-panel-head">
      <div><h2>{telegram ? 'ساکس' : 'مدیریت ساکس‌ها'}</h2><p>{telegram
        ? 'از ساکس‌های فعال این جدول، یکی تصادفی زیر هر خبر قرار می‌گیرد. لینک و اطلاعات اتصال برای اعضای کانال قابل مشاهده‌اند.'
        : 'اپ موبایل بعد از ورود، یکی از ساکس‌های فعال را به‌صورت تصادفی دریافت می‌کند.'}</p></div>
      <div className="socks-panel-actions">
        <input ref={importInput} type="file" accept=".txt,text/plain" hidden aria-label="فایل TXT ساکس‌ها" onChange={importFile} disabled={loading || busy}/>
        <button type="button" className="soft-btn" onClick={() => importInput.current?.click()} disabled={loading || busy}><Upload size={16}/>{importing ? 'در حال آپلود...' : 'آپلود فایل TXT'}</button>
        <button className="primary-btn" onClick={openNew} disabled={busy}><Plus size={16}/> افزودن ساکس</button>
      </div>
    </div>
    <div className="socks-import-hint"><span>هر خط: <code dir="ltr">IP:PORT:USERNAME:PASSWORD</code></span><span>ساکس‌ها با نام و شمارهٔ خودکار به انتهای فهرست اضافه می‌شوند؛ ساکس‌های قبلی حفظ می‌شوند.</span></div>
    {[loadError, importError, bulkError].filter(Boolean).map((message, index) => <div key={index} className="user-form-error socks-import-error" role="alert">{message}</div>)}
    <div className="socks-bulk-toolbar" role="region" aria-label="عملیات گروهی ساکس‌ها" aria-busy={bulkBusy}>
      <span>{chosenIds.length.toLocaleString('fa-IR')} ساکس انتخاب شده</span>
      <div className="socks-bulk-actions">
        <button type="button" className="soft-btn" onClick={() => bulkAction('activate')} disabled={busy || !chosenIds.length}>فعال‌کردن انتخاب‌شده‌ها</button>
        <button type="button" className="soft-btn" onClick={() => bulkAction('deactivate')} disabled={busy || !chosenIds.length}>غیرفعال‌کردن انتخاب‌شده‌ها</button>
        <button type="button" className="soft-btn danger-action" onClick={() => bulkAction('delete')} disabled={busy || !chosenIds.length}><Trash2 size={14}/> حذف انتخاب‌شده‌ها</button>
        <button type="button" className="soft-btn" onClick={() => setSelectedIds([])} disabled={busy || !chosenIds.length}>لغو انتخاب</button>
      </div>
      {bulkBusy && <span role="status">در حال انجام عملیات...</span>}
    </div>
    <div className="table-scroll"><table className="socks-table"><thead><tr>
      <th className="socks-select-cell"><input ref={selectAllInput} type="checkbox" aria-label="انتخاب همهٔ ساکس‌ها" aria-checked={partiallySelected ? 'mixed' : allSelected} checked={allSelected} disabled={loading || busy || !proxies.length} onChange={() => setSelectedIds(allSelected ? [] : proxies.map(proxy => String(proxy.id)))}/></th>
      <th>نام</th><th>IP / میزبان</th><th>پورت</th><th>نام کاربری</th><th>رمز عبور</th><th>وضعیت</th><th>عملیات</th>
    </tr></thead><tbody>{loading ? <tr><td colSpan={8} className="empty-state">در حال دریافت فهرست ساکس‌ها...</td></tr> : proxies.length ? proxies.map(proxy => {
      const id = String(proxy.id), passwordVisible = visiblePasswords.includes(id);
      return <tr key={id} className={selectedSet.has(id) ? 'socks-row-selected' : ''}>
        <td className="socks-select-cell"><input type="checkbox" aria-label={`انتخاب ${proxy.name}`} checked={selectedSet.has(id)} onChange={() => toggleSelection(id)} disabled={busy}/></td>
        <td><b>{proxy.name}</b></td><td dir="ltr">{proxy.host}</td><td>{proxy.port.toLocaleString('fa-IR')}</td><td dir="ltr">{proxy.username || 'بدون احراز هویت'}</td>
        <td><div className="password-cell"><span>{passwordVisible ? (proxy.password || 'بدون رمز') : '••••••••'}</span><button type="button" className="text-btn" aria-label={passwordVisible ? 'پنهان کردن رمز' : 'نمایش رمز'} onClick={() => setVisiblePasswords(current => passwordVisible ? current.filter(value => value !== id) : [...current, id])}>{passwordVisible ? 'پنهان' : 'نمایش'}</button></div></td>
        <td><button type="button" role="switch" aria-checked={proxy.active} className={`access-switch ${proxy.active ? '' : 'is-blocked'}`} onClick={() => toggleActive(proxy)} disabled={busy}><span/><b>{proxy.active ? 'فعال' : 'غیرفعال'}</b></button></td>
        <td><div className="user-actions"><button type="button" className="icon-btn" title="ویرایش ساکس" disabled={busy} onClick={() => { setError(''); setShowDraftPassword(false); setDraft({ ...proxy }); }}><Pencil size={16}/></button><button type="button" className="icon-btn danger-action" title="حذف ساکس" disabled={busy} onClick={() => remove(proxy)}><Trash2 size={16}/></button></div></td>
      </tr>;
    }) : <tr><td colSpan={8} className="empty-state">هنوز ساکسی اضافه نشده است.</td></tr>}</tbody></table></div>
  </section>
    {draft && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setDraft(null); }}><form className="user-dialog" onSubmit={save}>
      <div className="dialog-heading"><div><span>مدیریت پراکسی سرور</span><h2>{draft.id ? 'ویرایش ساکس' : 'ساکس جدید'}</h2></div><button type="button" className="icon-btn" disabled={saving} onClick={() => setDraft(null)}><X size={18}/></button></div>
      <label>نام ساکس<input required minLength={2} maxLength={80} value={draft.name || ''} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="مثلاً سرور آلمان ۱"/></label>
      <label>آدرس IP یا میزبان<input required maxLength={253} value={draft.host || ''} onChange={event => setDraft({ ...draft, host: event.target.value })} placeholder="203.0.113.10"/></label>
      <div className="user-form-row"><label>پورت<input type="number" min="1" max="65535" required value={draft.port || ''} onChange={event => setDraft({ ...draft, port: Number(event.target.value) })}/></label><label>نام کاربری<input autoComplete="off" value={draft.username || ''} onChange={event => setDraft({ ...draft, username: event.target.value })}/></label></div>
      <label>رمز عبور<div className="password-input-row"><input type={showDraftPassword ? 'text' : 'password'} autoComplete="new-password" value={draft.password || ''} onChange={event => setDraft({ ...draft, password: event.target.value })}/><button type="button" className="text-btn" onClick={() => setShowDraftPassword(value => !value)}>{showDraftPassword ? 'پنهان کردن' : 'نمایش'}</button></div></label>
      {error && <div className="user-form-error">{error}</div>}
      <div className="dialog-actions"><button type="button" className="soft-btn" disabled={saving} onClick={() => setDraft(null)}>انصراف</button><button className="primary-btn" disabled={saving}>{saving ? 'در حال ذخیره...' : 'ذخیره ساکس'}</button></div>
    </form></div>}
  </>;
}
