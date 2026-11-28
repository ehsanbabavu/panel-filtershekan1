import { randomInt } from 'node:crypto';
import Parser from 'rss-parser';
import { ChannelError, httpsUrl } from './telegramChannelContent.js';

const categories = ['technology', 'politics'] as const;
type NewsCategory = typeof categories[number];
type Feed = {
  category: NewsCategory; publisher: string; url: string; hostname: string;
  accepts?: (item: Parser.Item, url: URL, title: string, summary: string) => boolean;
};

const technologyNews = (item: Parser.Item, url: URL, title: string) =>
  !/\b(?:black friday|cyber monday|discounts?|promo codes?|gift (?:guide|picks))\b/i.test(title) &&
  !/^\/(?:shopping|science)\//.test(url.pathname) &&
  !(item.categories || []).some(category => ['Politics', 'Science', 'Gear / Deals'].includes(category));

const politicalTerms = /\b(?:government|presiden\w*|prime minister|parliament|elections?|minister\w*|sanctions|politic\w*|diploma\w*|ceasefire|peace talks|legislat\w*)\b/i;

const feeds: Feed[] = [
  { category: 'technology', publisher: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', hostname: 'theverge.com', accepts: technologyNews },
  { category: 'technology', publisher: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', hostname: 'arstechnica.com', accepts: technologyNews },
  { category: 'technology', publisher: 'WIRED', url: 'https://www.wired.com/feed/category/business/latest/rss', hostname: 'wired.com', accepts: technologyNews },
  { category: 'politics', publisher: 'The Guardian', url: 'https://www.theguardian.com/politics/rss', hostname: 'theguardian.com',
    accepts: (_item, url) => !url.pathname.startsWith('/commentisfree/') },
  { category: 'politics', publisher: 'The Guardian', url: 'https://www.theguardian.com/world/rss', hostname: 'theguardian.com',
    accepts: (_item, url, title, summary) => url.pathname.startsWith('/world/') && politicalTerms.test(title + ' ' + summary) },
  { category: 'politics', publisher: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', hostname: 'aljazeera.com',
    accepts: (_item, url, title, summary) => url.pathname.startsWith('/news/') && politicalTerms.test(title + ' ' + summary) },
];

const parser = new Parser();
const maxFeedBytes = 1024 * 1024;
const maxNewsAge = 72 * 60 * 60 * 1000;
const publishedDate = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'long', timeZone: 'Asia/Tehran' });
const categoryLabels: Record<NewsCategory, string> = { technology: 'فناوری', politics: 'خبر سیاسی' };

function plainText(value: unknown, limit: number) {
  return typeof value === 'string'
    ? value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

async function readFeed(feed: Feed, request: typeof fetch) {
  const response = await request(feed.url, {
    redirect: 'error', signal: AbortSignal.timeout(6000), headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return [];
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let xml = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxFeedBytes) {
        await reader.cancel();
        return [];
      }
      xml += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  const result = await parser.parseString(xml + decoder.decode());
  return result.items;
}

export async function findChannelNews(request: typeof fetch, now: Date, exclude: Set<string>, chooseCategory = () => randomInt(categories.length)) {
  const preferred = categories[chooseCategory()];
  const nowMs = now.getTime();
  const candidates = await Promise.all(feeds.map(async feed => {
    const items = await readFeed(feed, request).catch(() => []);
    return items.flatMap(item => {
      const article = httpsUrl(item.link || '');
      const timestamp = Date.parse(item.isoDate || item.pubDate || '');
      if (!article || article.hostname.replace(/^www\./, '') !== feed.hostname ||
        !Number.isFinite(timestamp) || timestamp < nowMs - maxNewsAge || timestamp > nowMs + 5 * 60 * 1000) return [];
      article.search = '';
      article.hash = '';
      const sourceUrl = article.href;
      const title = plainText(item.title || '', 300);
      const summary = plainText(item.contentSnippet || item.summary || item.content || '', 2600);
      if (!title || summary.length < 25 || sourceUrl.length > 600 || exclude.has(sourceUrl) ||
        (feed.accepts && !feed.accepts(item, article, title, summary))) return [];
      return [{ category: feed.category, publisher: feed.publisher, sourceUrl, timestamp, title, summary }];
    });
  }));
  const latest = candidates.flat().sort((a, b) => b.timestamp - a.timestamp);
  const selected = latest.find(item => item.category === preferred) || latest[0];
  if (!selected) throw new ChannelError(502, 'خبر تازه‌ای از منابع فناوری یا سیاست دریافت نشد. کمی بعد دوباره تلاش کنید.');
  const { category, publisher, sourceUrl, timestamp, title, summary } = selected;
  return {
    topic: categoryLabels[category], sourceUrl,
    attribution: `${publisher} · ${publishedDate.format(timestamp)}`,
    source: `رسانه: ${publisher}\nتاریخ انتشار: ${new Date(timestamp).toISOString()}\nعنوان: ${title}\nخلاصهٔ خبر: ${summary}`,
  };
}
