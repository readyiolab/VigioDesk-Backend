import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runSeoChecks } from '../../../../shared/webreports/seoChecks';
import { runAiChecks } from '../../../../shared/webreports/aiChecks';
import { emptyBotAccess } from '../../../../shared/webreports/aiChecks';
import type { CrawlSnapshot, PageSnapshot } from '../../../../shared/webreports/types';

function page(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    contentType: 'text/html',
    title: 'Example site overview title',
    metaDescription: 'A useful description of the example site that is long enough to be specific.',
    canonical: 'https://example.com/',
    h1: ['Example'],
    headings: [{ level: 2, text: 'What is this?' }],
    wordCount: 320,
    internalLinks: [],
    externalLinks: [],
    imagesMissingAlt: 0,
    imageCount: 1,
    schemaTypes: ['Organization'],
    schemaErrors: [],
    robotsMeta: 'index,follow',
    viewport: 'width=device-width, initial-scale=1',
    hreflang: [],
    openGraph: { title: 'Example', description: 'Example site' },
    responseMs: 100,
    sizeBytes: 1000,
    redirectChain: [],
    isHtml: true,
    timedOut: false,
    inconclusive: false,
    indexable: true,
    author: 'Ada',
    published: '2026-01-01',
    modified: '2026-02-01',
    listCount: 1,
    tableCount: 0,
    questionHeadingCount: 1,
    rawVisibleTextLength: 800,
    renderedVisibleTextLength: 900,
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
    botAccess: emptyBotAccess('allowed'),
    botPathNotes: [],
    ...overrides,
  };
}

function statusOf(checks: { id: string; status: string }[], id: string) {
  return checks.find((check) => check.id === id)?.status;
}

describe('SEO checks', () => {
  const healthy = runSeoChecks(snapshot());

  it('passes a healthy page', () => {
    assert.equal(statusOf(healthy, 'missing-titles'), 'absent');
    assert.equal(statusOf(healthy, 'https'), 'absent');
    assert.equal(statusOf(healthy, 'structured-data-invalid'), 'absent');
  });

  it('flags missing and duplicate titles, descriptions, and h1 problems', () => {
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ title: null })])), 'missing-titles'), 'present');
    const dup = page();
    const copy = page({ url: 'https://example.com/b', finalUrl: 'https://example.com/b' });
    assert.equal(statusOf(runSeoChecks(snapshot({}, [dup, copy])), 'duplicate-titles'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ title: 'Hi' })])), 'title-length'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ metaDescription: null })])), 'missing-meta-descriptions'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [dup, page({ url: 'https://example.com/c', finalUrl: 'https://example.com/c' })])), 'duplicate-meta-descriptions'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ metaDescription: 'short' })])), 'meta-description-length'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ h1: [] })])), 'missing-h1'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ h1: ['A', 'B'] })])), 'multiple-h1'), 'present');
  });

  it('does not call a timed-out link broken', () => {
    const home = page({ internalLinks: ['https://example.com/slow'] });
    const slow = page({ url: 'https://example.com/slow', finalUrl: 'https://example.com/slow', timedOut: true, statusCode: null, inconclusive: true });
    assert.equal(statusOf(runSeoChecks(snapshot({}, [home, slow])), 'broken-internal-links'), 'inconclusive');
    const broken = page({ url: 'https://example.com/missing', finalUrl: 'https://example.com/missing', statusCode: 404, indexable: false });
    const linker = page({ internalLinks: ['https://example.com/missing'] });
    assert.equal(statusOf(runSeoChecks(snapshot({}, [linker, broken])), 'broken-internal-links'), 'present');
  });

  it('covers canonical, sitemap, robots, https, viewport, alt, thin content, hreflang, and conflicts', () => {
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ canonical: 'not a url' })])), 'canonical-invalid'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ canonical: null })])), 'canonical-missing'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ canonical: 'https://other.example/' })])), 'canonical-offsite'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ canonical: 'http://example.com/' })])), 'insecure-canonical'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({ sitemap: { status: 'failed', urls: [], invalid: ['https://example.com/x'], redirected: [] } })), 'sitemap'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({ robots: { status: 'unavailable', body: null, sitemaps: [] } })), 'robots-txt'), 'unavailable');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ finalUrl: 'http://example.com/' })])), 'https'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ viewport: null })])), 'missing-viewport'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ imagesMissingAlt: 2 })])), 'image-alt'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ wordCount: 10 })])), 'thin-content'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ hreflang: [{ lang: 'bad tag', href: 'https://example.com/en' }] })])), 'hreflang'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ openGraph: {} })])), 'open-graph'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ schemaErrors: ['bad'] })])), 'structured-data-invalid'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({ sitemap: { status: 'ok', urls: ['https://example.com/'], invalid: [], redirected: [] } }, [page({ robotsMeta: 'noindex' })])), 'noindex'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({ sitemap: { status: 'ok', urls: ['https://example.com/'], invalid: [], redirected: [] } }, [page({ robotsMeta: 'noindex' })])), 'indexability-conflicts'), 'present');
    assert.equal(statusOf(runSeoChecks(snapshot({}, [page({ redirectChain: ['https://example.com/old', 'https://example.com/older'] })])), 'redirect-chains'), 'present');
  });

  it('is unavailable when no HTML was fetched', () => {
    assert.equal(statusOf(runSeoChecks(snapshot({}, [])), 'seo-unavailable'), 'unavailable');
  });
});

describe('AI search checks', () => {
  it('covers bots, llms.txt, rendering, schema, structure, and trust', () => {
    const healthy = runAiChecks(snapshot());
    assert.equal(statusOf(healthy, 'ai-bot-access'), 'absent');
    assert.equal(statusOf(healthy, 'llms-txt'), 'absent');
    assert.equal(statusOf(healthy, 'js-render-dependency'), 'absent');
    assert.equal(statusOf(healthy, 'ai-structured-data'), 'absent');
    assert.equal(statusOf(healthy, 'answer-structure'), 'absent');
    assert.equal(statusOf(healthy, 'trust-signals'), 'absent');

    const blocked = runAiChecks(snapshot({ botAccess: emptyBotAccess('blocked') }));
    assert.equal(statusOf(blocked, 'ai-bot-access'), 'present');
    const unavailableBots = runAiChecks(snapshot({ botAccess: emptyBotAccess('unavailable') }));
    assert.equal(statusOf(unavailableBots, 'ai-bot-access'), 'unavailable');

    const missingLlms = runAiChecks(snapshot({ llmsTxt: { present: false, httpStatus: 404, useful: false, hasHeadings: false, hasLinks: false, redirected: false } }));
    assert.equal(statusOf(missingLlms, 'llms-txt'), 'present');
    const unknownLlms = runAiChecks(snapshot({ llmsTxt: { present: false, httpStatus: null, useful: false, hasHeadings: false, hasLinks: false, redirected: false } }));
    assert.equal(statusOf(unknownLlms, 'llms-txt'), 'unavailable');

    const rendered = runAiChecks(snapshot({}, [page({ rawVisibleTextLength: 20, renderedVisibleTextLength: 400 })]));
    assert.equal(statusOf(rendered, 'js-render-dependency'), 'present');
    const noRender = runAiChecks(snapshot({}, [page({ renderedVisibleTextLength: null })]));
    assert.equal(statusOf(noRender, 'js-render-dependency'), 'unavailable');

    const noSchema = runAiChecks(snapshot({}, [page({ schemaTypes: [] })]));
    assert.equal(statusOf(noSchema, 'ai-structured-data'), 'present');
    const badSchema = runAiChecks(snapshot({}, [page({ schemaErrors: ['bad'] })]));
    assert.equal(statusOf(badSchema, 'ai-structured-data'), 'present');

    const flat = runAiChecks(snapshot({}, [page({ headings: [{ level: 3, text: 'Skip' }], questionHeadingCount: 0, listCount: 0, tableCount: 0 })]));
    assert.equal(statusOf(flat, 'answer-structure'), 'present');
    const noHtml = runAiChecks(snapshot({}, []));
    assert.equal(statusOf(noHtml, 'answer-structure'), 'unavailable');
    assert.equal(statusOf(noHtml, 'trust-signals'), 'unavailable');

    const lowTrust = runAiChecks(snapshot({}, [page({ author: null, published: null, modified: null, hasAboutLink: false, hasContactLink: false, schemaTypes: [] })]));
    assert.equal(statusOf(lowTrust, 'trust-signals'), 'present');
  });
});
