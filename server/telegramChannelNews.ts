import { randomInt } from 'node:crypto';
import Parser from 'rss-parser';
import { ChannelError, httpsUrl } from './telegramChannelContent.js';
import { feedImageUrl, readNewsBody } from './telegramChannelImages.js';

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

type FeedMedia = { $?: { url?: string; type?: string; medium?: string; width?: string } };
type FeedItem = {
  media?: FeedMedia[]; thumbnails?: FeedMedia[];
  groups?: { 'media:content'?: FeedMedia[]; 'media:thumbnail'?: FeedMedia[] }[];
  richContent?: string;
};
const parser = new Parser<Record<string, never>, FeedItem>({ customFields: { item: [
  ['media:content', 'media', { keepArray: true }],
  ['media:thumbnail', 'thumbnails', { keepArray: true }],
  ['media:group', 'groups', { keepArray: true }],
  ['content:encoded', 'richContent'],
] } });
const maxFeedBytes = 1024 * 1024;
const maxNewsAge = 72 * 60 * 60 * 1000;
const publishedDate = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'long', timeZone: 'Asia/Tehran' });
const categoryLabels: Record<NewsCategory, string> = { technology: 'فناوری', politics: 'خبر سیاسی' };

export function channelSourceUrl(value: unknown) {
  const url = typeof value === 'string' && value.length <= 600 && httpsUrl(value);
  if (!url || url.port || !feeds.some(feed => feed.hostname === url.hostname.replace(/^www\./, ''))) {
    throw new ChannelError(400, 'پیوند منبع خبر معتبر نیست.');
  }
  url.search = '';
  url.hash = '';
  return url.href;
}

function plainText(value: unknown, limit: number) {
  return typeof value === 'string'
    ? value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

async function readFeed(feed: Feed, request: typeof fetch) {
  const response = await request(feed.url, {
    redirect: 'error', signal: AbortSignal.timeout(6000), headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
  });
  const xml = await readNewsBody(response, maxFeedBytes);
  return xml ? (await parser.parseString(xml.toString('utf8'))).items : [];
}

export async function findChannelNews(request: typeof fetch, now: Date, exclude: Set<string>, chooseCategory = () => randomInt(categories.length)) {
  const preferred = categories[chooseCategory()];
  const nowMs = now.getTime();
  const candidates = await Promise.all(feeds.map(async feed => {
    const items = await readFeed(feed, request).catch(() => []);
    return items.flatMap(item => {
      const article = httpsUrl(item.link || '');
      const timestamp = Date.parse(item.isoDate || item.pubDate || '');
      if (!article || article.port || article.hostname.replace(/^www\./, '') !== feed.hostname ||
        !Number.isFinite(timestamp) || timestamp < nowMs - maxNewsAge || timestamp > nowMs + 5 * 60 * 1000) return [];
      article.search = '';
      article.hash = '';
      const sourceUrl = article.href;
      const title = plainText(item.title || '', 300);
      const summary = plainText(item.contentSnippet || item.summary || item.content || '', 2600);
      if (!title || summary.length < 25 || sourceUrl.length > 600 || exclude.has(sourceUrl) ||
        (feed.accepts && !feed.accepts(item, article, title, summary))) return [];
      return [{ category: feed.category, publisher: feed.publisher, sourceUrl, timestamp, title, summary, item }];
    });
  }));
  const latest = candidates.flat().sort((a, b) => b.timestamp - a.timestamp);
  const selected = latest.find(item => item.category === preferred) || latest[0];
  if (!selected) throw new ChannelError(502, 'خبر تازه‌ای از منابع فناوری یا سیاست دریافت نشد. کمی بعد دوباره تلاش کنید.');
  const { category, publisher, sourceUrl, timestamp, title, summary, item } = selected;
  const media = [
    ...(item.media || []), ...(item.groups || []).flatMap(group => group['media:content'] || []),
    ...(item.thumbnails || []), ...(item.groups || []).flatMap(group => group['media:thumbnail'] || []),
  ].flatMap(image => image?.$ ? [image.$] : [])
    .sort((left, right) => (Number(right.width) || 0) - (Number(left.width) || 0));
  if (item.enclosure?.type?.startsWith('image/')) media.unshift(item.enclosure);
  const imageUrl = feedImageUrl(sourceUrl, media, [item.content, item.richContent, item.summary].filter(Boolean).join('\n'));
  return {
    topic: categoryLabels[category], sourceUrl, imageUrl,
    attribution: `${publisher} · ${publishedDate.format(timestamp)}`,
    source: `رسانه: ${publisher}\nتاریخ انتشار: ${new Date(timestamp).toISOString()}\nعنوان: ${title}\nخلاصهٔ خبر: ${summary}`,
  };
}
