import type { CrawlSnapshot, PageSnapshot } from './types';

export type SeoSource = 'http' | 'browser-fallback' | 'unavailable';

export interface CrawlMetrics {
  pagesAttempted: number;
  htmlPages: number;
  timedOutPages: number;
  sitemapSeeds: number;
  seoSource: SeoSource;
}

/** Pages usable for on-page SEO / schema measurement. */
export function isMeasurablePage(page: PageSnapshot): boolean {
  return (
    page.isHtml &&
    !page.timedOut &&
    page.statusCode !== null &&
    page.statusCode > 0 &&
    page.statusCode < 400
  );
}

export function measurablePages(snapshot: CrawlSnapshot): PageSnapshot[] {
  return snapshot.pages.filter(isMeasurablePage);
}

export function buildCrawlMetrics(
  snapshot: CrawlSnapshot,
  seoSource: SeoSource,
  sitemapSeeds = snapshot.sitemap.urls.length
): CrawlMetrics {
  return {
    pagesAttempted: snapshot.pages.length,
    htmlPages: measurablePages(snapshot).length,
    timedOutPages: snapshot.pages.filter((page) => page.timedOut).length,
    sitemapSeeds,
    seoSource,
  };
}
