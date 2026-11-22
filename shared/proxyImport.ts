export const MAX_PROXY_IMPORT_BYTES = 1024 * 1024;
export const MAX_PROXY_IMPORT_ROWS = 10000;

export type ImportedProxy = { host: string; port: number; username: string; password: string };

export class ProxyImportError extends Error {}

export function parseProxyImport(content: unknown): ImportedProxy[] {
  if (typeof content !== 'string') throw new ProxyImportError('محتوای فایل TXT معتبر نیست.');
  if (new TextEncoder().encode(content).length > MAX_PROXY_IMPORT_BYTES) {
    throw new ProxyImportError('حجم فایل TXT باید حداکثر ۱ مگابایت باشد.');
  }
  const proxies: ImportedProxy[] = [];
  const lines = content.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const fail = (message: string): never => { throw new ProxyImportError(`خط ${(index + 1).toLocaleString('fa-IR')}: ${message}`); };
    const fields = line.match(/^(\[[^\]]+\]|[^:]+):([^:]+):([^:]*):(.*)$/);
    if (!fields) fail('قالب باید IP:PORT:USERNAME:PASSWORD باشد.');
    const [, address, portText, username, password] = fields!;
    const host = address.trim().replace(/^\[([^\]]+)\]$/, '$1');
    const port = Number(portText.trim());
    if (!host || host.length > 253 || /\s|\u0000/.test(host)) fail('آدرس IP یا میزبان معتبر نیست.');
    if (!/^\d+$/.test(portText.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) {
      fail('پورت باید عددی بین ۱ و ۶۵۵۳۵ باشد.');
    }
    if (username.length > 255 || password.length > 512 || /\u0000/.test(username + password)) {
      fail('نام کاربری یا رمز عبور معتبر نیست.');
    }
    proxies.push({ host, port, username, password });
    if (proxies.length > MAX_PROXY_IMPORT_ROWS) fail('هر فایل می‌تواند حداکثر ۱۰٬۰۰۰ ساکس داشته باشد.');
  }
  if (!proxies.length) throw new ProxyImportError('فایل TXT هیچ ساکسی ندارد.');
  return proxies;
}
