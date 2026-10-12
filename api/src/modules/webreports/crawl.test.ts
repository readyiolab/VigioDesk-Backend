import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crawlSite, parseSitemapXml, pickKeyPages } from '../../../../shared/webreports/crawl';
import type { PageSnapshot } from '../../../../shared/webreports/types';

function html(links: string[]) {
  return `<html><head><title>T</title></head><body><p>${'word '.repeat(30)}</p>${links.map((href) => `<a href="${href}">x</a>`).join('')}</body></html>`;
}

describe('crawler', () => {
  it('stays on the origin, skips disallowed URLs, and caps pages', async () => {
    const fetched: string[] = [];
    const result = await crawlSite({
      startUrl: 'https://example.com/',
      origin: 'https://example.com',
      maxPages: 2,
      concurrency: 2,
      delayMs: 0,
      isAllowed: (url) => !url.includes('/private'),
      seeds: ['https://example.com/from-sitemap', 'https://other.example/nope'],
      fetchPage: async (url) => {
        fetched.push(url);
        return {
          url,
          finalUrl: url,
          statusCode: 200,
          contentType: 'text/html',
          body: html(['https://example.com/a', 'https://example.com/private', 'https://other.example/out', '/b']),
          responseMs: 5,
          sizeBytes: 100,
          redirectChain: [],
          timedOut: false,
          inconclusive: false,
        };
      },
      parseHtml: (body) => ({
        title: 'T',
        metaDescription: null,
        canonical: null,
        h1: [],
        headings: [],
        wordCount: 10,
        internalLinks: [],
        externalLinks: [],
        imagesMissingAlt: 0,
        imageCount: 0,
        schemaTypes: [],
        schemaErrors: [],
        robotsMeta: null,
        viewport: null,
        hreflang: [],
        openGraph: {},
        isHtml: true,
        indexable: true,
        author: null,
        published: null,
        modified: null,
        listCount: 0,
        tableCount: 0,
        questionHeadingCount: 0,
        rawVisibleTextLength: 10,
        renderedVisibleTextLength: null,
        hasAboutLink: false,
        hasContactLink: false,
        consentGateLikely: false,
        links: Array.from(body.matchAll(/href="([^"]+)"/g)).map((match) => match[1]),
      }),
    });
    assert.equal(result.pages.length, 2);
    assert.ok(result.maxInFlight <= 2);
    assert.ok(fetched.every((url) => url.startsWith('https://example.com')));
    assert.equal(fetched.includes('https://example.com/private'), false);
    assert.ok(result.pages[0].externalLinks.some((url) => url.includes('other.example')));
  });

  it('parses sitemap indexes and urls', () => {
    const index = parseSitemapXml('<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap></sitemapindex>');
    assert.deepEqual(index.indexes, ['https://example.com/a.xml']);
    const urls = parseSitemapXml('<urlset><url><loc>https://example.com/a</loc></url></urlset>');
    assert.deepEqual(urls.urls, ['https://example.com/a']);
  });

  it('picks the homepage first', () => {
    const pages = [
      { url: 'https://example.com/a', finalUrl: 'https://example.com/a', isHtml: true, statusCode: 200, internalLinks: [] },
      { url: 'https://example.com/', finalUrl: 'https://example.com/', isHtml: true, statusCode: 200, internalLinks: ['https://example.com/a'] },
    ] as PageSnapshot[];
    assert.equal(pickKeyPages(pages, 'https://example.com/')[0], 'https://example.com/');
  });
});
