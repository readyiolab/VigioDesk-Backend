import { HEURISTICS } from './scoringConfig';
import { pass, present, makeCheck } from './checkFactory';
import type { AuditCheck, CrawlSnapshot, PageSnapshot } from './types';

function htmlPages(snapshot: CrawlSnapshot): PageSnapshot[] {
  return snapshot.pages.filter((page) => page.isHtml && !page.timedOut);
}

function indexable(pages: PageSnapshot[]): PageSnapshot[] {
  return pages.filter((page) => page.indexable && page.statusCode !== null && page.statusCode < 400);
}

export function runSeoChecks(snapshot: CrawlSnapshot): AuditCheck[] {
  const pages = htmlPages(snapshot);
  if (pages.length === 0) {
    return [
      makeCheck({
        id: 'seo-unavailable',
        category: 'seo',
        status: 'unavailable',
        severity: 'info',
        title: 'SEO checks unavailable',
        description: 'No HTML pages were fetched, so on-page SEO checks could not run.',
        fix: 'Confirm the URL returns HTML and can be reached by ReadyioBot.',
        impact: 'medium',
        effort: 'easy',
      }),
    ];
  }

  const checks: AuditCheck[] = [];
  const ok = indexable(pages);

  const missingTitle = ok.filter((page) => !page.title?.trim());
  checks.push(
    missingTitle.length
      ? present({
          id: 'missing-titles',
          category: 'seo',
          severity: 'critical',
          title: 'Missing page titles',
          description: 'Indexable HTML pages have no title element. Titles are the main label in search results.',
          affectedUrls: missingTitle.map((page) => page.finalUrl),
          affectedCount: missingTitle.length,
          fix: 'Add a unique <title> that describes the page.',
          impact: 'high',
          effort: 'easy',
          dedupeKey: 'titles',
        })
      : pass({
          id: 'missing-titles',
          category: 'seo',
          title: 'Page titles present',
          description: 'Indexable HTML pages have a title.',
          fix: 'Keep each title unique and descriptive.',
          impact: 'high',
          effort: 'easy',
          dedupeKey: 'titles',
        })
  );

  const titles = new Map<string, string[]>();
  for (const page of ok) {
    const title = page.title?.trim();
    if (!title) continue;
    const list = titles.get(title) || [];
    list.push(page.finalUrl);
    titles.set(title, list);
  }
  const duplicateTitles = [...titles.values()].filter((urls) => urls.length > 1).flat();
  checks.push(
    duplicateTitles.length
      ? present({
          id: 'duplicate-titles',
          category: 'seo',
          severity: 'warning',
          title: 'Duplicate page titles',
          description: 'More than one indexable page uses the same title, so search results are harder to tell apart.',
          affectedUrls: duplicateTitles,
          affectedCount: duplicateTitles.length,
          fix: 'Write a distinct title for each indexable URL.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'titles',
        })
      : pass({
          id: 'duplicate-titles',
          category: 'seo',
          title: 'Titles are unique',
          description: 'No duplicate titles were found among crawled indexable pages.',
          fix: 'Keep titles unique as you add pages.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'titles',
        })
  );

  const titleLength = ok.filter((page) => {
    const length = page.title?.trim().length || 0;
    return length > 0 && (length < HEURISTICS.titleMin || length > HEURISTICS.titleMax);
  });
  checks.push(
    titleLength.length
      ? present({
          id: 'title-length',
          category: 'seo',
          severity: 'info',
          title: 'Title length is outside the usual range',
          description: `Titles are easiest to read around ${HEURISTICS.titleMin}–${HEURISTICS.titleMax} characters. This is a heuristic, not a ranking error.`,
          affectedUrls: titleLength.map((page) => page.finalUrl),
          affectedCount: titleLength.length,
          fix: 'Shorten very long titles and expand titles that do not describe the page.',
          impact: 'low',
          effort: 'easy',
          dedupeKey: 'titles',
        })
      : pass({
          id: 'title-length',
          category: 'seo',
          title: 'Title lengths look reasonable',
          description: 'Titles that exist fall inside the configured length range.',
          fix: 'Recheck titles when the template changes.',
          impact: 'low',
          effort: 'easy',
          dedupeKey: 'titles',
        })
  );

  const missingDesc = ok.filter((page) => !page.metaDescription?.trim());
  checks.push(
    missingDesc.length
      ? present({
          id: 'missing-meta-descriptions',
          category: 'seo',
          severity: 'warning',
          title: 'Missing meta descriptions',
          description: 'Indexable pages have no meta description. Search engines may invent a snippet.',
          affectedUrls: missingDesc.map((page) => page.finalUrl),
          affectedCount: missingDesc.length,
          fix: 'Add a unique meta description that summarizes the page.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'descriptions',
        })
      : pass({
          id: 'missing-meta-descriptions',
          category: 'seo',
          title: 'Meta descriptions present',
          description: 'Indexable pages include a meta description.',
          fix: 'Keep descriptions specific to each URL.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'descriptions',
        })
  );

  const descriptions = new Map<string, string[]>();
  for (const page of ok) {
    const description = page.metaDescription?.trim();
    if (!description) continue;
    const list = descriptions.get(description) || [];
    list.push(page.finalUrl);
    descriptions.set(description, list);
  }
  const duplicateDesc = [...descriptions.values()].filter((urls) => urls.length > 1).flat();
  checks.push(
    duplicateDesc.length
      ? present({
          id: 'duplicate-meta-descriptions',
          category: 'seo',
          severity: 'warning',
          title: 'Duplicate meta descriptions',
          description: 'Multiple pages share one meta description.',
          affectedUrls: duplicateDesc,
          affectedCount: duplicateDesc.length,
          fix: 'Write a description that matches each URL.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'descriptions',
        })
      : pass({
          id: 'duplicate-meta-descriptions',
          category: 'seo',
          title: 'Meta descriptions are unique',
          description: 'No duplicate meta descriptions were found.',
          fix: 'Avoid copying one description across templates.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'descriptions',
        })
  );

  const descLength = ok.filter((page) => {
    const length = page.metaDescription?.trim().length || 0;
    return length > 0 && (length < HEURISTICS.descriptionMin || length > HEURISTICS.descriptionMax);
  });
  checks.push(
    descLength.length
      ? present({
          id: 'meta-description-length',
          category: 'seo',
          severity: 'info',
          title: 'Meta description length is outside the usual range',
          description: `Descriptions are usually useful around ${HEURISTICS.descriptionMin}–${HEURISTICS.descriptionMax} characters. This is a heuristic.`,
          affectedUrls: descLength.map((page) => page.finalUrl),
          affectedCount: descLength.length,
          fix: 'Rewrite descriptions so they summarize the page without being cut off.',
          impact: 'low',
          effort: 'easy',
          dedupeKey: 'descriptions',
        })
      : pass({
          id: 'meta-description-length',
          category: 'seo',
          title: 'Meta description lengths look reasonable',
          description: 'Descriptions that exist fall inside the configured range.',
          fix: 'Keep descriptions specific.',
          impact: 'low',
          effort: 'easy',
          dedupeKey: 'descriptions',
        })
  );

  const missingH1 = ok.filter((page) => page.h1.length === 0);
  checks.push(
    missingH1.length
      ? present({
          id: 'missing-h1',
          category: 'seo',
          severity: 'warning',
          title: 'Missing H1',
          description: 'Indexable pages have no H1. A single H1 states what the page is about.',
          affectedUrls: missingH1.map((page) => page.finalUrl),
          affectedCount: missingH1.length,
          fix: 'Add one descriptive H1 that matches the page topic.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'h1',
        })
      : pass({
          id: 'missing-h1',
          category: 'seo',
          title: 'H1 present',
          description: 'Indexable pages include an H1.',
          fix: 'Keep a single H1 per page.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'h1',
        })
  );

  const multiH1 = ok.filter((page) => page.h1.length > 1);
  checks.push(
    multiH1.length
      ? present({
          id: 'multiple-h1',
          category: 'seo',
          severity: 'warning',
          title: 'Multiple H1 elements',
          description: 'Pages contain more than one H1, which makes the main topic unclear.',
          affectedUrls: multiH1.map((page) => page.finalUrl),
          affectedCount: multiH1.length,
          fix: 'Keep one H1 and use H2 or H3 for sections.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'h1',
        })
      : pass({
          id: 'multiple-h1',
          category: 'seo',
          title: 'Single H1',
          description: 'Crawled pages do not stack multiple H1 elements.',
          fix: 'Use H2 and H3 under the H1.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'h1',
        })
  );

  const crawledByUrl = new Map(snapshot.pages.map((page) => [page.finalUrl, page]));
  for (const page of snapshot.pages) crawledByUrl.set(page.url, page);
  const broken: string[] = [];
  const inconclusiveLinks: string[] = [];
  for (const page of pages) {
    for (const link of page.internalLinks) {
      const target = crawledByUrl.get(link);
      if (!target) continue;
      if (target.timedOut || target.inconclusive || target.statusCode === null) {
        inconclusiveLinks.push(link);
        continue;
      }
      if (target.statusCode >= 400) broken.push(link);
    }
  }
  const uniqueBroken = Array.from(new Set(broken));
  checks.push(
    uniqueBroken.length
      ? present({
          id: 'broken-internal-links',
          category: 'seo',
          severity: 'critical',
          title: 'Broken internal links',
          description: 'Internal links point at URLs that returned an HTTP error during this crawl.',
          affectedUrls: uniqueBroken,
          affectedCount: uniqueBroken.length,
          fix: 'Update or remove links that return 4xx or 5xx.',
          impact: 'high',
          effort: 'easy',
        })
      : inconclusiveLinks.length && pages.every((page) => page.internalLinks.length === 0 || inconclusiveLinks.length)
        ? makeCheck({
            id: 'broken-internal-links',
            category: 'seo',
            status: 'inconclusive',
            severity: 'info',
            title: 'Internal link checks incomplete',
            description: 'Some internal targets timed out. They are not marked broken.',
            affectedUrls: inconclusiveLinks,
            affectedCount: new Set(inconclusiveLinks).size,
            fix: 'Retry the scan. Timeouts are not treated as broken links.',
            impact: 'low',
            effort: 'easy',
          })
        : pass({
            id: 'broken-internal-links',
            category: 'seo',
            title: 'No broken internal links in the crawl',
            description: 'Crawled internal targets did not return HTTP errors. Links that were not fetched are not judged.',
            fix: 'Recheck after large content moves.',
            impact: 'high',
            effort: 'easy',
          })
  );

  const longRedirects = snapshot.pages.filter((page) => page.redirectChain.length >= HEURISTICS.redirectChainWarning);
  const loops = snapshot.pages.filter((page) => new Set(page.redirectChain).size !== page.redirectChain.length);
  checks.push(
    loops.length
      ? present({
          id: 'redirect-chains',
          category: 'seo',
          severity: 'critical',
          title: 'Redirect loop',
          description: 'A redirect chain repeats a URL.',
          affectedUrls: loops.map((page) => page.url),
          affectedCount: loops.length,
          fix: 'Point each redirect at the final URL and remove the cycle.',
          impact: 'high',
          effort: 'medium',
        })
      : longRedirects.length
        ? present({
            id: 'redirect-chains',
            category: 'seo',
            severity: 'warning',
            title: 'Long redirect chains',
            description: 'Some URLs pass through more than one redirect before the final page.',
            affectedUrls: longRedirects.map((page) => page.url),
            affectedCount: longRedirects.length,
            fix: 'Redirect directly to the final URL.',
            impact: 'medium',
            effort: 'medium',
          })
        : pass({
            id: 'redirect-chains',
            category: 'seo',
            title: 'Redirect chains are short',
            description: 'Crawled URLs did not show long redirect chains or loops.',
            fix: 'Keep redirects to a single hop.',
            impact: 'medium',
            effort: 'medium',
          })
  );

  const missingCanonical = ok.filter((page) => !page.canonical);
  const invalidCanonical = ok.filter((page) => page.canonical && !isAbsoluteHttp(page.canonical));
  const offsiteCanonical = ok.filter((page) => {
    if (!page.canonical || !isAbsoluteHttp(page.canonical)) return false;
    try {
      return new URL(page.canonical).hostname !== new URL(snapshot.origin).hostname;
    } catch {
      return false;
    }
  });
  checks.push(
    invalidCanonical.length
      ? present({
          id: 'canonical-invalid',
          category: 'seo',
          severity: 'warning',
          title: 'Invalid canonical URL',
          description: 'A canonical href is not an absolute http(s) URL.',
          affectedUrls: invalidCanonical.map((page) => page.finalUrl),
          affectedCount: invalidCanonical.length,
          fix: 'Use an absolute https canonical URL.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'canonical',
        })
      : pass({
          id: 'canonical-invalid',
          category: 'seo',
          title: 'Canonical URLs are well formed',
          description: 'Canonicals that exist are absolute http(s) URLs.',
          fix: 'Keep canonicals absolute.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'canonical',
        })
  );
  checks.push(
    missingCanonical.length
      ? present({
          id: 'canonical-missing',
          category: 'seo',
          severity: 'warning',
          title: 'Missing canonical URL',
          description: 'Indexable pages do not declare a canonical URL.',
          affectedUrls: missingCanonical.map((page) => page.finalUrl),
          affectedCount: missingCanonical.length,
          fix: 'Add <link rel="canonical" href="https://example.com/page"> for the preferred URL.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'canonical',
        })
      : pass({
          id: 'canonical-missing',
          category: 'seo',
          title: 'Canonical URLs present',
          description: 'Indexable pages declare a canonical URL.',
          fix: 'Point each canonical at the preferred URL.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'canonical',
        })
  );
  checks.push(
    offsiteCanonical.length
      ? present({
          id: 'canonical-offsite',
          category: 'seo',
          severity: 'warning',
          title: 'Canonical points off-site',
          description: 'A canonical URL uses a different host, which tells search engines to prefer another site.',
          affectedUrls: offsiteCanonical.map((page) => page.finalUrl),
          affectedCount: offsiteCanonical.length,
          fix: 'Canonicalize to a URL on this host unless the page is intentionally syndicated.',
          impact: 'high',
          effort: 'easy',
          dedupeKey: 'canonical',
        })
      : pass({
          id: 'canonical-offsite',
          category: 'seo',
          title: 'Canonicals stay on-site',
          description: 'Canonical hosts match this site.',
          fix: 'Do not point canonicals at another domain by accident.',
          impact: 'high',
          effort: 'easy',
          dedupeKey: 'canonical',
        })
  );

  if (snapshot.sitemap.status === 'failed') {
    checks.push(
      present({
        id: 'sitemap',
        category: 'seo',
        severity: 'warning',
        title: 'Sitemap could not be used',
        description: 'A sitemap was declared or requested but could not be parsed or fetched.',
        affectedUrls: snapshot.sitemap.invalid,
        affectedCount: snapshot.sitemap.invalid.length,
        fix: 'Serve a valid sitemap XML at /sitemap.xml or the URL in robots.txt.',
        impact: 'medium',
        effort: 'medium',
      })
    );
  } else if (snapshot.sitemap.invalid.length || snapshot.sitemap.redirected.length) {
    checks.push(
      present({
        id: 'sitemap',
        category: 'seo',
        severity: 'warning',
        title: 'Sitemap lists problem URLs',
        description: 'The sitemap references URLs that were missing or redirected during the crawl.',
        affectedUrls: [...snapshot.sitemap.invalid, ...snapshot.sitemap.redirected],
        affectedCount: snapshot.sitemap.invalid.length + snapshot.sitemap.redirected.length,
        fix: 'List only final 200 URLs in the sitemap.',
        impact: 'medium',
        effort: 'easy',
      })
    );
  } else if (snapshot.sitemap.status === 'missing') {
    checks.push(
      makeCheck({
        id: 'sitemap',
        category: 'seo',
        status: 'present',
        severity: 'info',
        title: 'No sitemap found',
        description: 'Neither robots.txt nor /sitemap.xml provided a sitemap. Smaller sites can still be crawled from links.',
        fix: 'Publish a sitemap and mention it in robots.txt.',
        impact: 'low',
        effort: 'easy',
      })
    );
  } else {
    checks.push(
      pass({
        id: 'sitemap',
        category: 'seo',
        title: 'Sitemap looks usable',
        description: 'A sitemap was fetched and its sampled URLs were not missing.',
        fix: 'Keep the sitemap limited to canonical 200 URLs.',
        impact: 'medium',
        effort: 'easy',
      })
    );
  }

  if (snapshot.robots.status === 'unavailable') {
    checks.push(
      makeCheck({
        id: 'robots-txt',
        category: 'seo',
        status: 'unavailable',
        severity: 'info',
        title: 'robots.txt unavailable',
        description: 'robots.txt could not be fetched. Crawl rules and sitemap pointers may have been missed. This is not treated as an allow or a block.',
        fix: 'Serve robots.txt over HTTPS with a 200 response.',
        impact: 'medium',
        effort: 'easy',
      })
    );
  } else {
    checks.push(
      pass({
        id: 'robots-txt',
        category: 'seo',
        title: snapshot.robots.status === 'missing' ? 'robots.txt not published' : 'robots.txt fetched',
        description:
          snapshot.robots.status === 'missing'
            ? 'No robots.txt was found. Crawlers treat that as no sitewide restriction. This is not an error by itself.'
            : 'robots.txt was fetched and applied before crawling.',
        fix: 'Keep user-agent groups explicit if you need to limit crawlers.',
        impact: 'medium',
        effort: 'easy',
      })
    );
  }

  const noindex = pages.filter((page) => /noindex/i.test(page.robotsMeta || ''));
  checks.push(
    noindex.length
      ? present({
          id: 'noindex',
          category: 'seo',
          severity: 'info',
          title: 'noindex directives',
          description: 'Some HTML responses ask crawlers not to index them. That is correct for private pages and a problem if it is accidental.',
          affectedUrls: noindex.map((page) => page.finalUrl),
          affectedCount: noindex.length,
          fix: 'Remove noindex from URLs that should appear in search.',
          impact: 'high',
          effort: 'easy',
        })
      : pass({
          id: 'noindex',
          category: 'seo',
          title: 'No noindex directives on crawled pages',
          description: 'Crawled HTML did not send a noindex robots directive.',
          fix: 'Use noindex only on pages that should stay out of search.',
          impact: 'high',
          effort: 'easy',
        })
  );

  const insecure = snapshot.pages.filter((page) => page.finalUrl.startsWith('http://'));
  checks.push(
    insecure.length
      ? present({
          id: 'https',
          category: 'seo',
          severity: 'critical',
          title: 'Pages served over HTTP',
          description: 'The final URL is not HTTPS.',
          affectedUrls: insecure.map((page) => page.finalUrl),
          affectedCount: insecure.length,
          fix: 'Redirect HTTP to HTTPS and use HTTPS links.',
          impact: 'high',
          effort: 'medium',
        })
      : pass({
          id: 'https',
          category: 'seo',
          title: 'HTTPS in use',
          description: 'Crawled final URLs use HTTPS.',
          fix: 'Keep HSTS and HTTPS redirects in place.',
          impact: 'high',
          effort: 'medium',
        })
  );

  const insecureCanonical = ok.filter((page) => page.canonical?.startsWith('http://'));
  checks.push(
    insecureCanonical.length
      ? present({
          id: 'insecure-canonical',
          category: 'seo',
          severity: 'warning',
          title: 'Canonical uses HTTP',
          description: 'A canonical URL uses http:// even if the page itself may be on HTTPS.',
          affectedUrls: insecureCanonical.map((page) => page.finalUrl),
          affectedCount: insecureCanonical.length,
          fix: 'Change the canonical href to https://.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'canonical',
        })
      : pass({
          id: 'insecure-canonical',
          category: 'seo',
          title: 'Canonicals use HTTPS',
          description: 'Canonical URLs are not plain HTTP.',
          fix: 'Keep canonicals on HTTPS.',
          impact: 'medium',
          effort: 'easy',
          dedupeKey: 'canonical',
        })
  );

  const missingViewport = ok.filter((page) => !page.viewport);
  checks.push(
    missingViewport.length
      ? present({
          id: 'missing-viewport',
          category: 'seo',
          severity: 'warning',
          title: 'Missing mobile viewport',
          description: 'Pages do not include a viewport meta tag, so mobile browsers may lay them out as a desktop page.',
          affectedUrls: missingViewport.map((page) => page.finalUrl),
          affectedCount: missingViewport.length,
          fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
          impact: 'high',
          effort: 'easy',
        })
      : pass({
          id: 'missing-viewport',
          category: 'seo',
          title: 'Viewport meta tag present',
          description: 'Crawled pages declare a viewport.',
          fix: 'Keep width=device-width.',
          impact: 'high',
          effort: 'easy',
        })
  );

  const altPages = ok.filter((page) => page.imagesMissingAlt > 0);
  checks.push(
    altPages.length
      ? present({
          id: 'image-alt',
          category: 'seo',
          severity: 'warning',
          title: 'Images missing alternative text',
          description: 'Some images have no alt attribute. Empty alt is treated as decorative and is not flagged.',
          affectedUrls: altPages.map((page) => page.finalUrl),
          affectedCount: altPages.reduce((sum, page) => sum + page.imagesMissingAlt, 0),
          fix: 'Add alt text that describes the image, or alt="" if it is decorative.',
          impact: 'medium',
          effort: 'easy',
        })
      : pass({
          id: 'image-alt',
          category: 'seo',
          title: 'Image alt text covered',
          description: 'Crawled images have an alt attribute.',
          fix: 'Describe informative images in alt text.',
          impact: 'medium',
          effort: 'easy',
        })
  );

  const thin = ok.filter((page) => page.wordCount < HEURISTICS.thinWordCount);
  checks.push(
    thin.length
      ? present({
          id: 'thin-content',
          category: 'seo',
          severity: 'info',
          title: 'Thin content',
          description: `Indexable pages have fewer than ${HEURISTICS.thinWordCount} visible words. Short pages can be legitimate. This is a heuristic.`,
          affectedUrls: thin.map((page) => page.finalUrl),
          affectedCount: thin.length,
          fix: 'Add the explanation a visitor needs, or noindex pages that are only navigation.',
          impact: 'medium',
          effort: 'medium',
        })
      : pass({
          id: 'thin-content',
          category: 'seo',
          title: 'Pages have substantial text',
          description: 'Indexable pages meet the configured word-count heuristic.',
          fix: 'Keep primary pages specific and complete.',
          impact: 'medium',
          effort: 'medium',
        })
  );

  checks.push(hreflangCheck(ok));
  checks.push(openGraphCheck(ok));
  checks.push(schemaCheck(pages));
  checks.push(indexabilityCheck(snapshot, pages));
  return checks;
}

function isAbsoluteHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function hreflangCheck(pages: PageSnapshot[]): AuditCheck {
  const withLinks = pages.filter((page) => page.hreflang.length > 0);
  if (withLinks.length === 0) {
    return pass({
      id: 'hreflang',
      category: 'seo',
      title: 'No hreflang annotations',
      description: 'No hreflang links were found. That is fine for a single-language site.',
      fix: 'Add reciprocal hreflang only when you publish language or region alternates.',
      impact: 'low',
      effort: 'hard',
    });
  }
  const invalid = withLinks.filter((page) =>
    page.hreflang.some((item) => !item.href || !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(item.lang) && item.lang !== 'x-default')
  );
  const crawled = new Set(pages.map((page) => page.finalUrl));
  const missingReturn = withLinks.filter((page) =>
    page.hreflang.some((item) => crawled.has(item.href) && !pages.find((other) => other.finalUrl === item.href)?.hreflang.some((back) => back.href === page.finalUrl))
  );
  if (invalid.length) {
    return present({
      id: 'hreflang',
      category: 'seo',
      severity: 'warning',
      title: 'Invalid hreflang',
      description: 'An hreflang language code or href is not usable.',
      affectedUrls: invalid.map((page) => page.finalUrl),
      affectedCount: invalid.length,
      fix: 'Use BCP 47 codes such as en or en-in and absolute alternate URLs.',
      impact: 'medium',
      effort: 'medium',
    });
  }
  if (missingReturn.length) {
    return present({
      id: 'hreflang',
      category: 'seo',
      severity: 'warning',
      title: 'Hreflang is not reciprocal',
      description: 'An alternate that was also crawled does not point back. Alternates that were not crawled are not judged.',
      affectedUrls: missingReturn.map((page) => page.finalUrl),
      affectedCount: missingReturn.length,
      fix: 'Each alternate should list the full set, including itself.',
      impact: 'medium',
      effort: 'medium',
    });
  }
  return pass({
    id: 'hreflang',
    category: 'seo',
    title: 'Hreflang looks consistent',
    description: 'Hreflang codes are shaped correctly and crawled alternates point back.',
    fix: 'Keep the cluster reciprocal when you add a language.',
    impact: 'medium',
    effort: 'medium',
  });
}

function openGraphCheck(pages: PageSnapshot[]): AuditCheck {
  const missing = pages.filter((page) => !page.openGraph.title && !page.openGraph.description);
  if (missing.length === pages.length && pages.length > 0) {
    return present({
      id: 'open-graph',
      category: 'seo',
      severity: 'info',
      title: 'Open Graph tags missing',
      description: 'Pages do not set og:title or og:description, so link previews may fall back to a guess.',
      affectedUrls: missing.map((page) => page.finalUrl),
      affectedCount: missing.length,
      fix: 'Add og:title, og:description, and og:image for URLs that are shared.',
      impact: 'low',
      effort: 'easy',
    });
  }
  return pass({
    id: 'open-graph',
    category: 'seo',
    title: 'Open Graph tags present',
    description: 'At least some crawled pages declare Open Graph text.',
    fix: 'Use a unique image and title for important URLs.',
    impact: 'low',
    effort: 'easy',
  });
}

function schemaCheck(pages: PageSnapshot[]): AuditCheck {
  const errors = pages.filter((page) => page.schemaErrors.length > 0);
  if (errors.length) {
    return present({
      id: 'structured-data-invalid',
      category: 'seo',
      severity: 'warning',
      title: 'Malformed structured data',
      description: 'JSON-LD on the page did not parse. Presence of schema is not the same as eligibility for rich results.',
      affectedUrls: errors.map((page) => page.finalUrl),
      affectedCount: errors.length,
      fix: 'Validate JSON-LD and fix syntax errors. Do not add a type you do not actually represent.',
      impact: 'medium',
      effort: 'medium',
      dedupeKey: 'schema',
    });
  }
  return pass({
    id: 'structured-data-invalid',
    category: 'seo',
    title: 'Structured data parsed',
    description: 'JSON-LD blocks that were present parsed as JSON. This does not certify rich-result eligibility.',
    fix: 'Keep JSON-LD aligned with the visible page.',
    impact: 'medium',
    effort: 'medium',
    dedupeKey: 'schema',
  });
}

function indexabilityCheck(snapshot: CrawlSnapshot, pages: PageSnapshot[]): AuditCheck {
  const conflicts: string[] = [];
  for (const page of pages) {
    const tokens = (page.robotsMeta || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
    if (tokens.includes('noindex') && tokens.includes('index')) conflicts.push(page.finalUrl);
    if (tokens.includes('noindex') && snapshot.sitemap.urls.includes(page.finalUrl)) conflicts.push(page.finalUrl);
    if (page.statusCode && page.statusCode >= 400 && page.canonical) conflicts.push(page.finalUrl);
  }
  const unique = Array.from(new Set(conflicts));
  if (!unique.length) {
    return pass({
      id: 'indexability-conflicts',
      category: 'seo',
      title: 'No indexability conflict detected',
      description: 'Robots directives, status codes, and sitemap membership did not contradict each other on crawled pages.',
      fix: 'Keep noindex pages out of the sitemap.',
      impact: 'high',
      effort: 'easy',
    });
  }
  return present({
    id: 'indexability-conflicts',
    category: 'seo',
    severity: 'warning',
    title: 'Indexability signals conflict',
    description: 'A page combines signals such as noindex plus a sitemap URL, or an error status with a canonical.',
    affectedUrls: unique,
    affectedCount: unique.length,
    fix: 'Choose one indexing outcome and make robots, canonical, status, and sitemap agree.',
    impact: 'high',
    effort: 'medium',
  });
}
