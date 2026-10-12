import { isSameOrigin, normalizeCrawlUrl } from './canonicalize';
import type { PageSnapshot } from './types';

export interface FetchedPage {
  url: string;
  finalUrl: string;
  statusCode: number | null;
  contentType: string | null;
  body: string;
  responseMs: number | null;
  sizeBytes: number | null;
  redirectChain: string[];
  timedOut: boolean;
  inconclusive: boolean;
}

export interface CrawlDeps {
  startUrl: string;
  origin: string;
  maxPages: number;
  concurrency: number;
  delayMs: number;
  fetchPage: (url: string) => Promise<FetchedPage>;
  parseHtml: (html: string, pageUrl: string) => Omit<PageSnapshot, 'url' | 'finalUrl' | 'statusCode' | 'contentType' | 'responseMs' | 'sizeBytes' | 'redirectChain' | 'timedOut' | 'inconclusive'> & {
    links: string[];
  };
  isAllowed: (url: string) => boolean;
  signal?: AbortSignal;
  seeds?: string[];
}

export interface CrawlRun {
  pages: PageSnapshot[];
  discovered: string[];
  maxInFlight: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true }
    );
  });
}

export function pickKeyPages(pages: PageSnapshot[], startUrl: string, limit = 5): string[] {
  const html = pages.filter((page) => page.isHtml && page.statusCode && page.statusCode < 400);
  const degree = new Map<string, number>();
  for (const page of html) {
    for (const link of page.internalLinks) {
      degree.set(link, (degree.get(link) || 0) + 1);
    }
  }
  const ranked = html
    .map((page) => page.finalUrl || page.url)
    .filter((url, index, all) => all.indexOf(url) === index)
    .sort((a, b) => {
      if (a === startUrl) return -1;
      if (b === startUrl) return 1;
      return (degree.get(b) || 0) - (degree.get(a) || 0) || (a < b ? -1 : 1);
    });
  if (ranked[0] !== startUrl && pages.some((page) => page.url === startUrl || page.finalUrl === startUrl)) {
    ranked.unshift(startUrl);
  }
  return ranked.slice(0, limit);
}

/**
 * Bounded same-origin crawl. Redirect targets outside the origin are recorded
 * on the page and not expanded. Robots decisions are supplied by `isAllowed`.
 */
export async function crawlSite(deps: CrawlDeps): Promise<CrawlRun> {
  const concurrency = Math.max(1, Math.min(5, deps.concurrency));
  const queue: string[] = [deps.startUrl, ...(deps.seeds || [])];
  const seen = new Set<string>();
  const pages: PageSnapshot[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let idle = 0;

  function take(): string | null {
    while (queue.length > 0 && pages.length + inFlight < deps.maxPages) {
      const url = queue.shift() as string;
      if (seen.has(url) || !deps.isAllowed(url) || !isSameOrigin(url, deps.origin)) continue;
      seen.add(url);
      return url;
    }
    return null;
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (deps.signal?.aborted) return;
      const url = take();
      if (!url) {
        if (inFlight === 0) return;
        idle += 1;
        if (idle > 1000) return;
        await sleep(5, deps.signal).catch(() => undefined);
        continue;
      }
      idle = 0;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (deps.delayMs > 0 && pages.length > 0) await sleep(deps.delayMs, deps.signal);
        const fetched = await deps.fetchPage(url);
        const html = (fetched.contentType || '').includes('html') || /<html[\s>]/i.test(fetched.body);
        const parsed = html && !fetched.timedOut ? deps.parseHtml(fetched.body, fetched.finalUrl || url) : emptyParse();
        const sameOriginFinal = isSameOrigin(fetched.finalUrl || url, deps.origin);
        const page: PageSnapshot = {
          url,
          finalUrl: fetched.finalUrl || url,
          statusCode: fetched.statusCode,
          contentType: fetched.contentType,
          responseMs: fetched.responseMs,
          sizeBytes: fetched.sizeBytes,
          redirectChain: fetched.redirectChain,
          timedOut: fetched.timedOut,
          inconclusive: fetched.inconclusive,
          ...parsed,
          isHtml: html,
          internalLinks: [],
          externalLinks: [],
        };
        if (sameOriginFinal) {
          for (const link of parsed.links) {
            const normalized = normalizeCrawlUrl(link, page.finalUrl);
            if (!normalized) continue;
            if (isSameOrigin(normalized, deps.origin)) {
              page.internalLinks.push(normalized);
              if (!seen.has(normalized) && deps.isAllowed(normalized)) queue.push(normalized);
            } else {
              page.externalLinks.push(normalized);
            }
          }
        }
        pages.push(page);
      } finally {
        inFlight -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { pages: pages.slice(0, deps.maxPages), discovered: [...seen], maxInFlight };
}

function emptyParse() {
  return {
    title: null,
    metaDescription: null,
    canonical: null,
    h1: [] as string[],
    headings: [] as { level: number; text: string }[],
    wordCount: 0,
    imagesMissingAlt: 0,
    imageCount: 0,
    schemaTypes: [] as string[],
    schemaErrors: [] as string[],
    robotsMeta: null,
    viewport: null,
    hreflang: [] as { lang: string; href: string }[],
    openGraph: {},
    isHtml: false,
    indexable: false,
    author: null,
    published: null,
    modified: null,
    listCount: 0,
    tableCount: 0,
    questionHeadingCount: 0,
    rawVisibleTextLength: 0,
    renderedVisibleTextLength: null,
    hasAboutLink: false,
    hasContactLink: false,
    consentGateLikely: false,
    links: [] as string[],
  };
}

export function parseSitemapXml(xml: string): { urls: string[]; indexes: string[] } {
  const urls: string[] = [];
  const indexes: string[] = [];
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const matches = xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi);
  for (const match of matches) {
    const value = match[1].trim();
    if (!value) continue;
    if (isIndex) indexes.push(value);
    else urls.push(value);
  }
  return { urls: urls.slice(0, 500), indexes: indexes.slice(0, 20) };
}
