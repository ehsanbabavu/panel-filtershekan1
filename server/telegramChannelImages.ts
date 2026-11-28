import { httpsUrl } from './telegramChannelContent.js';

const imageHosts: Record<string, readonly string[]> = {
  'theverge.com': ['platform.theverge.com', 'cdn.vox-cdn.com', 'duet-cdn.vox-cdn.com'],
  'arstechnica.com': ['cdn.arstechnica.net', 'cdn.arstechnica.com'],
  'wired.com': ['media.wired.com', 'assets.wired.com'],
  'theguardian.com': ['i.guim.co.uk', 'media.guim.co.uk'],
  'aljazeera.com': ['www.aljazeera.com', 'aljazeera.net'],
};

export function newsImageUrl(value: unknown, sourceUrl: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) return null;
  try {
    const article = new URL(sourceUrl);
    const address = new URL(value.trim().replace(/&amp;/gi, '&').replace(/&#38;|&#x26;/gi, '&'), article);
    const allowed = imageHosts[article.hostname.replace(/^www\./, '')] || [];
    const url = httpsUrl(address.href);
    if (!url || url.port || !(url.hostname === article.hostname || allowed.includes(url.hostname))) return null;
    url.hash = '';
    return url.href.length <= 2000 ? url.href : null;
  } catch { return null; }
}

export async function readNewsBody(response: Response, limit: number, allowPartial = false) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const available = limit - total;
      if (value.length > available) {
        await reader.cancel();
        if (!allowPartial) return null;
        chunks.push(value.subarray(0, available));
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function attributes(tag: string) {
  const result: Record<string, string> = Object.create(null);
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  }
  return result;
}

export function feedImageUrl(sourceUrl: string, media: { url?: string; type?: string; medium?: string }[], html: string) {
  for (const image of media) {
    if ((image.type && !image.type.startsWith('image/')) || (image.medium && image.medium !== 'image')) continue;
    const url = newsImageUrl(image.url, sourceUrl);
    if (url) return url;
  }
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const image = attributes(tag[0]);
    const url = newsImageUrl(image['data-src'] || image.src, sourceUrl);
    if (url) return url;
  }
  return null;
}

export async function readArticleImage(sourceUrl: string, request: typeof fetch) {
  try {
    const response = await request(sourceUrl, {
      redirect: 'error', signal: AbortSignal.timeout(4000), headers: { Accept: 'text/html' },
    });
    const body = await readNewsBody(response, 256 * 1024, true);
    if (!body) return null;
    const meta = Array.from(body.toString('utf8').matchAll(/<meta\b[^>]*>/gi), tag => attributes(tag[0]));
    for (const key of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
      for (const tag of meta) {
        if ((tag.property || tag.name || '').toLowerCase() !== key) continue;
        const url = newsImageUrl(tag.content, sourceUrl);
        if (url) return url;
      }
    }
  } catch { /* News without an accessible image can still be published. */ }
  return null;
}

export async function downloadNewsImage(imageUrl: string, request: typeof fetch) {
  try {
    const response = await request(imageUrl, {
      redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'image/jpeg, image/png' },
    });
    const bytes = await readNewsBody(response, 8 * 1024 * 1024);
    if (!bytes || bytes.length < 16) return null;
    const format = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'jpeg'
      : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png' : null;
    if (!format) return null;
    return { blob: new Blob([new Uint8Array(bytes)], { type: 'image/' + format }), filename: 'news.' + format };
  } catch { return null; }
}
