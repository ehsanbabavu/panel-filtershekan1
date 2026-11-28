import { useEffect, useState, type FormEvent } from 'react';
import { Download, Smartphone, Upload } from 'lucide-react';
import { ANDROID_APK_MAX_BYTES, ANDROID_APK_NAME, ANDROID_APK_PART_BYTES, type AndroidApk } from '../../shared/androidApk';
import { readApiResponse } from './apiResponse';

const mb = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' });
const formatSize = (bytes: number) => `${mb.format(bytes / (1024 * 1024))} مگابایت`;

async function apkRequest(token: string, options: RequestInit = {}, chunk?: { id: string; part: number }) {
  const query = new URLSearchParams({ action: 'android-apk' });
  if (chunk) {
    query.set('id', chunk.id);
    query.set('part', String(chunk.part));
  }
  const headers = new Headers(options.headers);
  headers.set('Authorization', 'Bearer ' + token);
  const response = await fetch('/api/telegram?' + query, { ...options, headers, cache: 'no-store' })
    .catch(() => { throw new Error('ارتباط با سرور برقرار نشد.'); });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.message || 'درخواست فایل اندروید انجام نشد.');
  }
  return response;
}

async function getCurrentApk(token: string, signal?: AbortSignal) {
  const response = await apkRequest(token, { signal });
  return (await readApiResponse<{ apk: AndroidApk | null }>(response)).apk;
}

export default function TelegramAndroidApk({ token, onNotify }: { token: string; onNotify: (message: string) => void }) {
  const [apk, setApk] = useState<AndroidApk | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [transfer, setTransfer] = useState<{ kind: 'upload' | 'download'; percent: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void getCurrentApk(token, controller.signal)
      .then(current => { if (!controller.signal.aborted) setApk(current); })
      .catch(() => { if (!controller.signal.aborted) setError('وضعیت فایل اندروید دریافت نشد.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || transfer || loading) return;
    const form = event.currentTarget;
    if (!file.size || file.size > ANDROID_APK_MAX_BYTES) {
      setError(`یک فایل APK با حجم حداکثر ${formatSize(ANDROID_APK_MAX_BYTES)} انتخاب کنید.`);
      return;
    }

    setError('');
    setTransfer({ kind: 'upload', percent: 0 });
    try {
      const started = await apkRequest(token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ size: file.size }),
      });
      const { id } = await readApiResponse<{ id: string }>(started);
      let published: AndroidApk | null = null;
      for (let offset = 0; offset < file.size; offset += ANDROID_APK_PART_BYTES) {
        const end = Math.min(file.size, offset + ANDROID_APK_PART_BYTES);
        const response = await apkRequest(token, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(offset, end),
        }, { id, part: offset / ANDROID_APK_PART_BYTES });
        ({ apk: published } = await readApiResponse<{ apk: AndroidApk | null }>(response));
        setTransfer({ kind: 'upload', percent: Math.round(end * 100 / file.size) });
      }
      if (!published) throw new Error('ذخیرهٔ فایل اندروید انجام نشد.');
      setApk(published);
      form.reset();
      setFile(null);
      onNotify('نسخهٔ جدید اندروید ذخیره شد.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'آپلود فایل اندروید انجام نشد.');
    } finally { setTransfer(null); }
  }

  async function download() {
    if (transfer) return;
    setError('');
    setTransfer({ kind: 'download', percent: 0 });
    try {
      const current = await getCurrentApk(token);
      setApk(current);
      if (!current) return;
      const parts: ArrayBuffer[] = [];
      for (let offset = 0; offset < current.size; offset += ANDROID_APK_PART_BYTES) {
        const response = await apkRequest(token, {}, { id: current.id, part: offset / ANDROID_APK_PART_BYTES });
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== Math.min(ANDROID_APK_PART_BYTES, current.size - offset)) {
          throw new Error('فایل کامل دریافت نشد. دوباره دانلود کنید.');
        }
        parts.push(bytes);
        setTransfer({ kind: 'download', percent: Math.round((offset + bytes.byteLength) * 100 / current.size) });
      }
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/vnd.android.package-archive' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = current.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'دانلود فایل اندروید انجام نشد.');
    } finally { setTransfer(null); }
  }

  return <section className="panel">
    <div className="panel-head">
      <div>
        <h2>آخرین نسخهٔ اندروید</h2>
        <p>فایل جدید با نام <bdi>{ANDROID_APK_NAME}</bdi> جایگزین نسخهٔ قبلی می‌شود.</p>
      </div>
      <Smartphone size={20}/>
    </div>
    {loading && <p className="telegram-hint" role="status">در حال دریافت وضعیت فایل…</p>}
    {!loading && !apk && !error && <p className="telegram-hint">هنوز فایلی آپلود نشده است.</p>}
    {apk && <dl className="telegram-details telegram-apk-details">
      <div><dt>نسخهٔ فعلی</dt><dd><bdi>{apk.name}</bdi> · {formatSize(apk.size)}</dd></div>
      <div><dt>زمان آپلود</dt><dd><time dateTime={apk.uploadedAt}>{date.format(new Date(apk.uploadedAt))}</time></dd></div>
    </dl>}
    {error && <div className="user-form-error" role="alert">{error}</div>}
    <form className="telegram-form" onSubmit={upload}>
      <label htmlFor="telegram-android-apk">فایل APK (حداکثر {formatSize(ANDROID_APK_MAX_BYTES)})
        <input id="telegram-android-apk" type="file" accept=".apk,application/vnd.android.package-archive" required
          disabled={loading || !!transfer} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(''); }}/>
      </label>
      {transfer && <progress className="telegram-apk-progress" value={transfer.percent} max={100}
        aria-label={transfer.kind === 'upload' ? 'پیشرفت آپلود' : 'پیشرفت دانلود'}/>}
      <div className="telegram-form-actions">
        {apk && <button type="button" className="soft-btn" disabled={!!transfer} onClick={download}>
          <Download size={15}/>{transfer?.kind === 'download' ? 'در حال دانلود…' : 'دانلود نسخهٔ فعلی'}
        </button>}
        <button className="primary-btn" disabled={loading || !!transfer || !file}>
          <Upload size={15}/>{transfer?.kind === 'upload' ? 'در حال آپلود…' : apk ? 'آپلود و جایگزینی' : 'آپلود فایل'}
        </button>
      </div>
    </form>
  </section>;
}
