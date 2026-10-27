import * as cheerio from 'cheerio';
import type { PageSnapshot } from '../../../shared/webreports/types';

type Parsed = Omit<
  PageSnapshot,
  'url' | 'finalUrl' | 'statusCode' | 'contentType' | 'responseMs' | 'sizeBytes' | 'redirectChain' | 'timedOut' | 'inconclusive'
> & { links: string[] };

export function parseHtml(html: string, pageUrl: string): Parsed {
  const $ = cheerio.load(html);
  const schemaTypes: string[] = [];
  const schemaErrors: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      collectSchema(JSON.parse(raw), schemaTypes);
    } catch {
      schemaErrors.push('Invalid JSON-LD');
    }
  });
  $('script, style, noscript, svg').remove();

  const headings = $('h1, h2, h3')
    .toArray()
    .slice(0, 40)
    .map((el) => {
      const tag = ((el as { tagName?: string }).tagName || (el as { name?: string }).name || '').toLowerCase();
      return {
        level: Number(tag.replace('h', '')) || 0,
        text: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 180),
      };
    })
    .filter((heading) => heading.text);
  const h1 = headings.filter((heading) => heading.level === 1).map((heading) => heading.text).slice(0, 10);
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const links = $('a[href]')
    .toArray()
    .slice(0, 200)
    .map((el) => $(el).attr('href') || '')
    .filter(Boolean);
  let imagesMissingAlt = 0;
  let imageCount = 0;
  $('img').each((_, el) => {
    imageCount += 1;
    const alt = $(el).attr('alt');
    if (alt === undefined) imagesMissingAlt += 1;
  });
  const robotsMeta = $('meta[name="robots"]').attr('content') || null;
  const canonical = $('link[rel="canonical"]').attr('href') || null;
  const hreflang = $('link[rel="alternate"][hreflang]')
    .toArray()
    .slice(0, 20)
    .map((el) => ({ lang: $(el).attr('hreflang') || '', href: $(el).attr('href') || '' }));
  const author = $('meta[name="author"]').attr('content') || null;
  const published = $('meta[property="article:published_time"]').attr('content') || $('time[datetime]').attr('datetime') || null;
  const modified = $('meta[property="article:modified_time"]').attr('content') || null;
  const hrefs = links.map((href) => href.toLowerCase());

  let detectedLogo: string | null = null;
  let detectedCompanyName: string | null = $('meta[property="og:site_name"]').attr('content')?.trim() || null;

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).text();
      const parsed = JSON.parse(raw);
      const walk = (item: unknown): void => {
        if (!item || typeof item !== 'object') return;
        if (Array.isArray(item)) {
          item.forEach(walk);
          return;
        }
        const record = item as Record<string, unknown>;
        const type = String(record['@type'] || '');
        if (/Organization|Corporation|LocalBusiness|Brand|WebSite/i.test(type)) {
          if (!detectedCompanyName && typeof record.name === 'string') {
            detectedCompanyName = record.name.trim();
          }
          if (!detectedLogo) {
            if (typeof record.logo === 'string') detectedLogo = record.logo;
            else if (record.logo && typeof (record.logo as Record<string, unknown>).url === 'string') {
              detectedLogo = (record.logo as Record<string, unknown>).url as string;
            } else if (typeof record.image === 'string') {
              detectedLogo = record.image;
            }
          }
        }
        if (record['@graph']) walk(record['@graph']);
      };
      walk(parsed);
    } catch {}
  });

  if (!detectedLogo) {
    const appleIcon = $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').attr('href');
    const highResIcon = $('link[rel="icon"][sizes="192x192"], link[rel="icon"][sizes="512x512"]').attr('href');
    const headerLogo = $('header img[src*="logo" i], nav img[src*="logo" i], a[class*="brand" i] img, a[class*="logo" i] img, img[alt*="logo" i]').first().attr('src');
    const ogImg = $('meta[property="og:image"]').attr('content');
    const candidate = appleIcon || highResIcon || headerLogo || ogImg;
    if (candidate) {
      try {
        detectedLogo = new URL(candidate, pageUrl).href;
      } catch {
        detectedLogo = candidate;
      }
    }
  }

  return {
    title: $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 500) || null,
    metaDescription: ($('meta[name="description"]').attr('content') || '').trim().slice(0, 500) || null,
    canonical: canonical ? canonical.slice(0, 2048) : null,
    h1,
    headings,
    wordCount: text ? text.split(' ').filter(Boolean).length : 0,
    internalLinks: [],
    externalLinks: [],
    imagesMissingAlt,
    imageCount,
    schemaTypes: Array.from(new Set(schemaTypes)).slice(0, 30),
    schemaErrors: schemaErrors.slice(0, 5),
    robotsMeta,
    viewport: $('meta[name="viewport"]').attr('content') || null,
    hreflang,
    openGraph: {
      title: $('meta[property="og:title"]').attr('content') || undefined,
      description: $('meta[property="og:description"]').attr('content') || undefined,
      image: $('meta[property="og:image"]').attr('content') || undefined,
    },
    isHtml: true,
    indexable: !/noindex/i.test(robotsMeta || ''),
    author,
    published,
    modified,
    listCount: $('ul, ol').length,
    tableCount: $('table').length,
    questionHeadingCount: headings.filter((heading) => heading.text.endsWith('?')).length,
    rawVisibleTextLength: text.length,
    renderedVisibleTextLength: null,
    hasAboutLink: hrefs.some((href) => /\/about\b/.test(href)),
    hasContactLink: hrefs.some((href) => /\/contact\b/.test(href)),
    consentGateLikely: /cookie consent|consent manager|privacy preference/i.test(html),
    links,
    detectedLogo,
    detectedCompanyName,
  };
}

function collectSchema(value: unknown, types: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectSchema(item, types));
    return;
  }
  const record = value as { '@type'?: string | string[]; '@graph'?: unknown };
  const type = record['@type'];
  if (typeof type === 'string') types.push(type);
  if (Array.isArray(type)) type.forEach((item) => typeof item === 'string' && types.push(item));
  if (record['@graph']) collectSchema(record['@graph'], types);
}
