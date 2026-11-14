import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSameSite, reanchorOrigin } from '../../../../shared/webreports/canonicalize';
import { looksLikeHtml } from '../../../../shared/webreports/htmlDetect';
import {
  buildCrawlMetrics,
  isMeasurablePage,
  measurablePages,
} from '../../../../shared/webreports/measurable';
import { runSeoChecks } from '../../../../shared/webreports/seoChecks';
import { runAiChecks, emptyBotAccess } from '../../../../shared/webreports/aiChecks';
import { emptySearchBotAccess } from '../../../../shared/webreports/robotsPolicy';
import { scoreChecks } from '../../../../shared/webreports/scoring';
import type { CrawlSnapshot, PageSnapshot } from '../../../../shared/webreports/types';

function page(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    contentType: 'text/html',
    title: 'Example',
    metaDescription: 'A useful description of the example site that is long enough.',
    canonical: 'https://example.com/',
    h1: ['Example'],
    headings: [],
    wordCount: 320,
    internalLinks: [],
    externalLinks: [],
    imagesMissingAlt: 0,
    imageCount: 1,
    schemaTypes: ['Organization', 'WebSite'],
    schemaErrors: [],
    robotsMeta: 'index,follow',
    viewport: 'width=device-width',
    hreflang: [],
    openGraph: { title: 'Example', description: 'Example', image: 'https://example.com/og.png' },
    responseMs: 100,
    sizeBytes: 1000,
    redirectChain: [],
    isHtml: true,
    timedOut: false,
    inconclusive: false,
    indexable: true,
    author: null,
    published: null,
    modified: null,
    listCount: 0,
    tableCount: 0,
    questionHeadingCount: 0,
    rawVisibleTextLength: 800,
    renderedVisibleTextLength: 800,
    hasAboutLink: true,
    hasContactLink: true,
    consentGateLikely: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<CrawlSnapshot> = {}, pages = [page()]): CrawlSnapshot {
  return {
    startUrl: 'https://example.com/',
    origin: 'https://example.com',
    pages,
    robots: { status: 'ok', body: 'User-agent: *\nAllow: /\n', sitemaps: [] },
    sitemap: { status: 'ok', urls: ['https://example.com/'], invalid: [], redirected: [] },
    llmsTxt: { present: true, httpStatus: 200, useful: true, hasHeadings: true, hasLinks: true, redirected: false },
    manifest: { status: 'ok', httpStatus: 200, name: 'Example', hasIcons: true, useful: true },
    humansTxt: { present: true, httpStatus: 200, useful: true },
    searchBotAccess: emptySearchBotAccess('allowed'),
    botAccess: emptyBotAccess('allowed'),
    botPathNotes: [],
    ...overrides,
  };
}

describe('measurable pages', () => {
  it('rejects timed-out and non-HTML pages', () => {
    assert.equal(isMeasurablePage(page({ timedOut: true })), false);
    assert.equal(isMeasurablePage(page({ isHtml: false })), false);
    assert.equal(isMeasurablePage(page({ statusCode: 500 })), false);
    assert.equal(isMeasurablePage(page()), true);
  });

  it('treats www and apex as same site for seeds', () => {
    assert.equal(isSameSite('https://www.example.com/about', 'https://example.com'), true);
    assert.equal(isSameSite('https://blog.example.com/', 'https://example.com'), false);
  });

  it('re-anchors crawl origin from apex to www on same-site redirect', () => {
    assert.equal(reanchorOrigin('https://apple.com', 'https://www.apple.com/'), 'https://www.apple.com');
    assert.equal(reanchorOrigin('https://www.apple.com', 'https://www.apple.com/'), 'https://www.apple.com');
    assert.equal(reanchorOrigin('https://apple.com', 'https://store.apple.com/'), 'https://apple.com');
  });

  it('accepts doctype and large partial HTML bodies', () => {
    assert.equal(looksLikeHtml('<!DOCTYPE html><html><head></head><body>Hi</body></html>'), true);
    assert.equal(looksLikeHtml('<html lang="en"><body>Hi</body></html>'), true);
    assert.equal(looksLikeHtml(''), false);
    assert.equal(looksLikeHtml('not html'), false);
    assert.equal(looksLikeHtml(`<div>${'x'.repeat(500)}</div>`), true);
  });

  it('recovers SEO score after browser-style HTML merge replaces a timed-out page', () => {
    const broken = snapshot({}, [page({ isHtml: false, timedOut: true, statusCode: null, schemaTypes: [] })]);
    assert.equal(measurablePages(broken).length, 0);
    assert.equal(scoreChecks(runSeoChecks(broken)), null);
    assert.equal(
      runAiChecks(broken).find((c) => c.id === 'ai-structured-data')?.status,
      'unavailable'
    );

    const recovered = snapshot({}, [page({ schemaTypes: ['Organization', 'WebSite', 'FAQPage'] })]);
    const seo = runSeoChecks(recovered);
    assert.notEqual(scoreChecks(seo), null);
    assert.equal(runAiChecks(recovered).find((c) => c.id === 'ai-structured-data')?.status, 'absent');
    const metrics = buildCrawlMetrics(recovered, 'browser-fallback', 8, {
      attempted: true,
      succeeded: true,
      error: null,
    });
    assert.equal(metrics.htmlPages, 1);
    assert.equal(metrics.seoSource, 'browser-fallback');
    assert.equal(metrics.sitemapSeeds, 8);
    assert.equal(metrics.seoRecovery?.succeeded, true);
  });
});
