import { crawlSite, parseSitemapXml, pickKeyPages } from '../../../shared/webreports/crawl';
import { isSameOrigin } from '../../../shared/webreports/canonicalize';
import { runSeoChecks } from '../../../shared/webreports/seoChecks';
import { runAiChecks } from '../../../shared/webreports/aiChecks';
import { jsRenderRatio } from '../../../shared/webreports/aiChecks';
import { buildRecommendations } from '../../../shared/webreports/recommendations';
import { scoreChecks, combineScores } from '../../../shared/webreports/scoring';
import { weightsFromEnv } from '../../../shared/webreports/scoringConfig';
import { SCORING_VERSION } from '../../../shared/webreports/types';
import { progressFor } from '../../../shared/webreports/progress';
import { summaryPayload } from '../../../shared/webreports/summary';
import { emptyDevice } from '../../../shared/webreports/vitals';
import { nodeDnsResolve, safeFetch, UrlSafetyError } from '../../../shared/webreports/urlSafety';
import type { CrawlSnapshot, PageSnapshot } from '../../../shared/webreports/types';
import { env } from './env';
import { logger } from './runtime';
import { parseHtml } from './parsePage';
import { evaluateBotAccess, isAllowedByRobots, sitemapsFromRobots } from './robotsEval';
import { startSsrfProxy } from './proxy';
import { launchBrowser, renderedTextLength, runDeviceSet } from './browser';
import { fetchFieldData, mergeField } from './psi';
import { buildSummary } from './summaryClient';
import { claimReport, loadReport, markFailed, readCheckpoint, saveCompleted, updateStage } from './store';
import type { Browser } from 'puppeteer';

const PERMANENT = new Set([
  'private-address',
  'protocol',
  'metadata',
  'numeric-ip',
  'credentials',
  'malformed',
  'ambiguous',
  'redirects',
]);

export async function runPipeline(reportId: string, generation: number, jobId: string, signal: AbortSignal): Promise<void> {
  const existing = await loadReport(reportId);
  if (!existing || existing.jobGeneration !== generation) return;
  if (existing.status === 'completed' || existing.status === 'failed') return;
  const claimed = await claimReport(existing, jobId);
  if (!claimed) return;

  const scoring = weightsFromEnv(process.env);
  let browser: Browser | null = null;
  let proxy: { port: number; close: () => Promise<void> } | null = null;
  try {
    if (signal.aborted) {
      await markFailed(reportId, jobId, generation, 'The scan exceeded its time limit.');
      return;
    }
    if (!(await updateStage(reportId, jobId, generation, 'validating', progressFor('validating')))) return;
    const checkpoint = readCheckpoint(existing.checkpointJson);
    let crawl = checkpoint.crawl;
    if (!crawl) {
      if (!(await updateStage(reportId, jobId, generation, 'crawling', progressFor('crawling')))) return;
      crawl = await collectCrawl(existing.url, existing.maxPages, signal);
      if (!crawl.pages.length) {
        await markFailed(reportId, jobId, generation, 'No pages could be fetched from that website.');
        return;
      }
      if (!(await updateStage(reportId, jobId, generation, 'crawling', progressFor('crawling'), { crawl }))) return;
    }

    if (!(await updateStage(reportId, jobId, generation, 'analyzing_seo', progressFor('analyzing_seo')))) return;
    const seo = runSeoChecks(crawl);

    proxy = await startSsrfProxy(nodeDnsResolve);
    browser = await launchBrowser(proxy.port, env.CHROME_PATH);
    const sample = pickKeyPages(crawl.pages, crawl.startUrl, 3);
    for (const url of sample) {
      if (signal.aborted) break;
      const length = await renderedTextLength(browser, url, env.WEBREPORTS_PAGE_TIMEOUT_MS);
      const page = crawl.pages.find((item) => item.finalUrl === url || item.url === url);
      if (page) page.renderedVisibleTextLength = length;
    }
    if (!(await updateStage(reportId, jobId, generation, 'analyzing_ai_search', progressFor('analyzing_ai_search')))) return;
    const ai = runAiChecks(crawl);

    let mobile = checkpoint.mobile || emptyDevice('Mobile lab data is unavailable.');
    let desktop = checkpoint.desktop || emptyDevice('Desktop lab data is unavailable.');
    const perfUrls = pickKeyPages(crawl.pages, crawl.startUrl, 5);
    if (!checkpoint.mobile) {
      if (!(await updateStage(reportId, jobId, generation, 'testing_mobile', progressFor('testing_mobile')))) return;
      if (!signal.aborted) mobile = await runDeviceSet(browser, perfUrls, 'mobile', env.WEBREPORTS_LIGHTHOUSE_CONCURRENCY, signal);
      if (!(await updateStage(reportId, jobId, generation, 'testing_mobile', progressFor('testing_mobile'), { crawl, mobile }))) return;
    }
    if (!checkpoint.desktop) {
      if (!(await updateStage(reportId, jobId, generation, 'testing_desktop', progressFor('testing_desktop')))) return;
      if (!signal.aborted) desktop = await runDeviceSet(browser, perfUrls, 'desktop', env.WEBREPORTS_LIGHTHOUSE_CONCURRENCY, signal);
      if (!(await updateStage(reportId, jobId, generation, 'testing_desktop', progressFor('testing_desktop'), { crawl, mobile, desktop }))) return;
    }

    const field = await fetchFieldData(crawl.startUrl, env.PSI_API_KEY, 20_000);
    mobile = mergeField(mobile, field.mobile);
    desktop = mergeField(desktop, field.desktop);
    if (!field.mobile && !field.desktop) {
      mobile = { ...mobile, field: mobile.field };
    }

    if (!(await updateStage(reportId, jobId, generation, 'scoring', progressFor('scoring')))) return;
    const scores = {
      mobile: mobile.score,
      desktop: desktop.score,
      seo: scoreChecks(seo),
      aiSearch: scoreChecks(ai),
    };
    const combined = combineScores(scores, scoring.weights);
    if (!field.mobile && !field.desktop && !combined.completeness.unavailableSections.includes('field-data')) {
      combined.completeness.unavailableSections.push('field-data');
      combined.completeness.complete = false;
    }
    const checks = [...seo, ...ai];
    const topFixes = buildRecommendations(checks, { mobile, desktop });
    const ratioPage = crawl.pages.find((page) => page.renderedVisibleTextLength !== null);
    const detail = {
      botAccess: crawl.botAccess,
      llmsTxt: {
        present: crawl.llmsTxt.present && crawl.llmsTxt.useful,
        status: crawl.llmsTxt.httpStatus === null ? 'unavailable' : crawl.llmsTxt.present ? 'present' : 'missing',
      },
      jsRatio: ratioPage
        ? jsRenderRatio(ratioPage.rawVisibleTextLength, ratioPage.renderedVisibleTextLength || 1)
        : null,
    };

    if (!(await updateStage(reportId, jobId, generation, 'generating_summary', progressFor('generating_summary')))) return;
    const draft = {
      url: crawl.startUrl,
      scores: { overall: combined.overall, ...scores },
      completeness: combined.completeness,
      seo: { checks: seo },
      aiSearch: { checks: ai, botAccess: detail.botAccess, llmsTxt: detail.llmsTxt, jsDependency: { rawVsRenderedRatio: detail.jsRatio, status: 'absent' as const } },
      performance: { mobile, desktop },
    };
    const summary = signal.aborted
      ? { headline: 'The scan reached its time limit', text: 'Partial results were saved when a stage finished before the deadline.' }
      : await buildSummary(summaryPayload(draft), env.ANTHROPIC_API_KEY, env.WEBREPORTS_SUMMARY_MODEL, env.WEBREPORTS_SUMMARY_TIMEOUT_MS);

    if (signal.aborted && mobile.score === null && desktop.score === null && !crawl.pages.length) {
      await markFailed(reportId, jobId, generation, 'The scan exceeded its time limit.');
      return;
    }
    if (!(await updateStage(reportId, jobId, generation, 'saving_results', progressFor('saving_results')))) return;
    await saveCompleted({
      reportId,
      jobId,
      generation,
      pages: crawl.pages,
      checks,
      mobile,
      desktop,
      scores: { overall: combined.overall, ...scores },
      completeness: combined.completeness,
      topFixes,
      detail,
      summaryHeadline: summary.headline,
      summaryText: summary.text,
      scoringVersion: SCORING_VERSION,
    });
    logger.info({ reportId, jobId }, 'Web report completed');
  } catch (err) {
    if (err instanceof UrlSafetyError && PERMANENT.has(err.code)) {
      await markFailed(reportId, jobId, generation, err.clientMessage);
      return;
    }
    if (signal.aborted) {
      await markFailed(reportId, jobId, generation, 'The scan exceeded its time limit.');
      return;
    }
    logger.error({ err, reportId, jobId }, 'Web report pipeline failed');
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (proxy) await proxy.close().catch(() => undefined);
  }
}

async function collectCrawl(startUrl: string, maxPages: number, signal: AbortSignal): Promise<CrawlSnapshot> {
  const origin = new URL(startUrl).origin;
  const robots = await fetchText(`${origin}/robots.txt`, signal);
  const robotsStatus = robots === null ? 'unavailable' : robots.status === 404 ? 'missing' : robots.status >= 400 ? 'unavailable' : 'ok';
  const robotsBody = robotsStatus === 'ok' ? robots?.body || '' : null;
  const seeds = await sitemapSeeds(origin, robotsBody, robots?.body || '', signal);
  const botPaths = [startUrl, ...seeds.slice(0, 3)];
  const bots = evaluateBotAccess(robotsBody, robotsStatus === 'ok' ? 'ok' : robotsStatus, origin, botPaths);
  const llms = await fetchText(`${origin}/llms.txt`, signal);
  const pages = await crawlSite({
    startUrl,
    origin,
    maxPages: Math.min(maxPages, env.WEBREPORTS_MAX_PAGES),
    concurrency: env.WEBREPORTS_CRAWL_CONCURRENCY,
    delayMs: env.WEBREPORTS_POLITE_DELAY_MS,
    seeds,
    signal,
    isAllowed: (url) => (robotsBody ? isAllowedByRobots(robotsBody, origin, url) : true),
    fetchPage: (url) => fetchPage(url, signal),
    parseHtml,
  });
  const sitemapState = classifySitemap(seeds, pages.pages);
  return {
    startUrl,
    origin,
    pages: pages.pages,
    robots: {
      status: robotsStatus === 'ok' ? 'ok' : robotsStatus,
      body: robotsBody,
      sitemaps: robotsBody ? sitemapsFromRobots(robotsBody) : [],
    },
    sitemap: sitemapState,
    llmsTxt: describeLlms(llms),
    botAccess: bots.access,
    botPathNotes: bots.notes,
  };
}

function classifySitemap(seeds: string[], pages: PageSnapshot[]) {
  if (!seeds.length) return { status: 'missing' as const, urls: [], invalid: [], redirected: [] };
  const byUrl = new Map(pages.map((page) => [page.finalUrl, page]));
  const invalid = seeds.filter((url) => byUrl.get(url)?.statusCode && (byUrl.get(url)?.statusCode || 0) >= 400);
  const redirected = seeds.filter((url) => (byUrl.get(url)?.redirectChain.length || 0) > 0);
  return { status: 'ok' as const, urls: seeds.slice(0, 100), invalid: invalid.slice(0, 20), redirected: redirected.slice(0, 20) };
}

function describeLlms(result: { status: number; body: string; finalUrl: string } | null) {
  if (!result) return { present: false, httpStatus: null, useful: false, hasHeadings: false, hasLinks: false, redirected: false };
  const text = result.body.trim();
  const useful = result.status < 400 && text.length > 40 && !text.startsWith('<');
  return {
    present: result.status < 400 && text.length > 0 && !text.startsWith('<!DOCTYPE') && !text.startsWith('<html'),
    httpStatus: result.status,
    useful,
    hasHeadings: /^#/m.test(text),
    hasLinks: /https?:\/\//.test(text),
    redirected: result.finalUrl.endsWith('/llms.txt') ? false : true,
  };
}

async function sitemapSeeds(origin: string, robotsBody: string | null, rawRobots: string, signal: AbortSignal): Promise<string[]> {
  const declared = robotsBody ? sitemapsFromRobots(rawRobots) : [];
  const queue = declared.length ? declared : [`${origin}/sitemap.xml`];
  const seen = new Set<string>();
  const urls: string[] = [];
  let depth = 0;
  while (queue.length && depth < 3 && urls.length < 100) {
    const next = queue.shift() as string;
    if (seen.has(next) || !isSameOrigin(next, origin)) continue;
    seen.add(next);
    const file = await fetchText(next, signal);
    depth += 1;
    if (!file || file.status >= 400) continue;
    const parsed = parseSitemapXml(file.body);
    for (const index of parsed.indexes) if (isSameOrigin(index, origin)) queue.push(index);
    for (const url of parsed.urls) {
      if (isSameOrigin(url, origin)) urls.push(url);
    }
  }
  return Array.from(new Set(urls)).slice(0, 100);
}

async function fetchText(url: string, signal: AbortSignal) {
  try {
    const result = await safeFetch(url, {
      resolve: nodeDnsResolve,
      timeoutMs: env.WEBREPORTS_PAGE_TIMEOUT_MS,
      maxBytes: env.WEBREPORTS_MAX_BYTES,
      signal,
    });
    return { status: result.status, body: result.body.toString('utf8'), finalUrl: result.finalUrl };
  } catch (err) {
    if (err instanceof UrlSafetyError && PERMANENT.has(err.code)) throw err;
    return null;
  }
}

async function fetchPage(url: string, signal: AbortSignal) {
  const started = Date.now();
  try {
    const result = await safeFetch(url, {
      resolve: nodeDnsResolve,
      timeoutMs: env.WEBREPORTS_PAGE_TIMEOUT_MS,
      maxBytes: env.WEBREPORTS_MAX_BYTES,
      signal,
    });
    const contentType = header(result.headers, 'content-type');
    return {
      url,
      finalUrl: result.finalUrl,
      statusCode: result.status,
      contentType,
      body: result.body.toString('utf8'),
      responseMs: Date.now() - started,
      sizeBytes: result.body.length,
      redirectChain: result.redirectChain,
      timedOut: false,
      inconclusive: false,
    };
  } catch (err) {
    if (err instanceof UrlSafetyError && PERMANENT.has(err.code)) throw err;
    const timedOut = err instanceof UrlSafetyError && (err.code === 'timeout' || err.code === 'dns-timeout');
    return {
      url,
      finalUrl: url,
      statusCode: null,
      contentType: null,
      body: '',
      responseMs: Date.now() - started,
      sizeBytes: 0,
      redirectChain: [],
      timedOut,
      inconclusive: true,
    };
  }
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}
