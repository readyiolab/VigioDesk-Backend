import { HEURISTICS } from './scoringConfig';
import { makeCheck, pass, present } from './checkFactory';
import { AI_BOTS, type AiBot, type AuditCheck, type BotAccess, type CrawlSnapshot, type PageSnapshot } from './types';

const SCHEMA_TYPES = ['Organization', 'WebSite', 'Product', 'Article', 'FAQPage', 'BreadcrumbList', 'Review'];

export function runAiChecks(snapshot: CrawlSnapshot): AuditCheck[] {
  const checks: AuditCheck[] = [];
  checks.push(botCheck(snapshot));
  checks.push(llmsCheck(snapshot));
  checks.push(jsCheck(snapshot));
  checks.push(schemaCoverage(snapshot));
  checks.push(answerStructure(snapshot));
  checks.push(trustSignals(snapshot));
  return checks;
}

function botCheck(snapshot: CrawlSnapshot): AuditCheck {
  const entries = AI_BOTS.map((bot) => `${bot}: ${snapshot.botAccess[bot]}`);
  const unavailable = AI_BOTS.every((bot) => snapshot.botAccess[bot] === 'unavailable');
  if (unavailable) {
    return makeCheck({
      id: 'ai-bot-access',
      category: 'ai-search',
      status: 'unavailable',
      severity: 'info',
      title: 'AI crawler rules unavailable',
      description: 'robots.txt could not be fetched, so bot access was not inferred. Blocking one bot does not control every AI search service.',
      fix: 'Publish robots.txt and name the bots you intend to allow or block.',
      impact: 'medium',
      effort: 'easy',
    });
  }
  const blocked = AI_BOTS.filter((bot) => snapshot.botAccess[bot] === 'blocked');
  if (blocked.length) {
    return present({
      id: 'ai-bot-access',
      category: 'ai-search',
      severity: 'warning',
      title: 'Some AI crawlers are blocked on the homepage',
      description: `${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} blocked for the homepage. ${entries.join('; ')}. ${snapshot.botPathNotes.join(' ')} A block is not proof that every AI product excludes the site, and an allow is not inclusion in answers.`,
      affectedUrls: [snapshot.startUrl],
      affectedCount: blocked.length,
      fix: 'If these crawlers should read public pages, remove the matching Disallow rule. Do not add a blanket Disallow unless you intend to opt out.',
      impact: 'high',
      effort: 'easy',
      dedupeKey: 'bots',
    });
  }
  return pass({
    id: 'ai-bot-access',
    category: 'ai-search',
    title: 'Homepage is not explicitly blocked for the checked AI crawlers',
    description: `${entries.join('; ')}. Unspecified means robots.txt has no matching rule. This does not guarantee inclusion in AI answers.`,
    fix: 'Add an explicit allow only if you want a documented policy.',
    impact: 'medium',
    effort: 'easy',
    dedupeKey: 'bots',
  });
}

function llmsCheck(snapshot: CrawlSnapshot): AuditCheck {
  const file = snapshot.llmsTxt;
  if (file.httpStatus === null) {
    return makeCheck({
      id: 'llms-txt',
      category: 'ai-search',
      status: 'unavailable',
      severity: 'info',
      title: 'llms.txt could not be checked',
      description: 'The request for /llms.txt did not complete. llms.txt is an emerging convention, not a confirmed ranking factor.',
      fix: 'Retry the scan. A missing file is optional.',
      impact: 'low',
      effort: 'easy',
    });
  }
  if (!file.present) {
    return present({
      id: 'llms-txt',
      category: 'ai-search',
      severity: 'info',
      title: 'llms.txt is not present',
      description: '/llms.txt did not return useful text. The file is an emerging convention and is not treated as a ranking requirement.',
      affectedUrls: [`${snapshot.origin}/llms.txt`],
      affectedCount: 1,
      fix: 'Optionally publish a short Markdown file that links to your canonical docs.',
      impact: 'low',
      effort: 'easy',
    });
  }
  if (!file.useful) {
    return present({
      id: 'llms-txt',
      category: 'ai-search',
      severity: 'info',
      title: 'llms.txt has little usable text',
      description: 'The file responded but did not include headings or content links.',
      affectedUrls: [`${snapshot.origin}/llms.txt`],
      affectedCount: 1,
      fix: 'Add headings and links to the pages you want assistants to read.',
      impact: 'low',
      effort: 'easy',
    });
  }
  return pass({
    id: 'llms-txt',
    category: 'ai-search',
    title: 'llms.txt is present',
    description: ` /llms.txt returned text${file.redirected ? ' after a redirect' : ''} with ${file.hasHeadings ? 'headings' : 'content'}${file.hasLinks ? ' and links' : ''}. This is a convention, not a guarantee of AI answers.`,
    fix: 'Keep the links pointed at public canonical pages.',
    impact: 'low',
    effort: 'easy',
  });
}

export function jsRenderRatio(raw: number, rendered: number): number {
  return raw / Math.max(rendered, 1);
}

function jsCheck(snapshot: CrawlSnapshot): AuditCheck {
  const pages = snapshot.pages.filter((page) => page.isHtml);
  const measured = pages.filter((page) => page.renderedVisibleTextLength !== null && !page.timedOut);
  if (pages.length === 0 || measured.length === 0) {
    return makeCheck({
      id: 'js-render-dependency',
      category: 'ai-search',
      status: 'unavailable',
      severity: 'info',
      title: 'JavaScript rendering comparison unavailable',
      description: 'Rendered text could not be compared with the raw HTML. This does not prove that crawlers can or cannot execute JavaScript.',
      fix: 'Retry the scan if the browser stage did not run.',
      impact: 'medium',
      effort: 'hard',
    });
  }
  const risky = measured.filter((page) => {
    const rendered = page.renderedVisibleTextLength || 0;
    const ratio = jsRenderRatio(page.rawVisibleTextLength, rendered);
    return ratio < HEURISTICS.jsRenderRatio && rendered - page.rawVisibleTextLength >= HEURISTICS.jsRenderMinExtraChars;
  });
  const consent = risky.filter((page) => page.consentGateLikely);
  const empty = measured.every((page) => page.rawVisibleTextLength < 40 && (page.renderedVisibleTextLength || 0) < 40);
  if (empty) {
    return makeCheck({
      id: 'js-render-dependency',
      category: 'ai-search',
      status: 'inconclusive',
      severity: 'info',
      title: 'Rendered comparison was inconclusive',
      description: 'Both the raw HTML and the rendered page had very little text, so a JavaScript dependency was not assumed.',
      fix: 'Check pages that should contain a full article or product description.',
      impact: 'low',
      effort: 'medium',
    });
  }
  if (consent.length && consent.length === risky.length) {
    return makeCheck({
      id: 'js-render-dependency',
      category: 'ai-search',
      status: 'inconclusive',
      severity: 'info',
      title: 'Content may be behind a consent gate',
      description: 'Rendered text is much longer than the raw HTML, and the page looks like a consent dialog. That is not proof of a client-rendered document.',
      affectedUrls: consent.map((page) => page.finalUrl),
      affectedCount: consent.length,
      fix: 'Put the main content in the initial HTML if crawlers should see it without interaction.',
      impact: 'medium',
      effort: 'hard',
    });
  }
  if (risky.length) {
    const sample = risky[0];
    const ratio = jsRenderRatio(sample.rawVisibleTextLength, sample.renderedVisibleTextLength || 1);
    return present({
      id: 'js-render-dependency',
      category: 'ai-search',
      severity: 'warning',
      title: 'Main text may depend on JavaScript',
      description: `Raw visible text is about ${ratio.toFixed(2)} of the rendered text on sampled pages. Some AI crawlers do not execute JavaScript. This is a compatibility risk, not proof that every crawler will miss the page.`,
      affectedUrls: risky.map((page) => page.finalUrl),
      affectedCount: risky.length,
      fix: 'Server-render or prerender the primary content so it exists in the HTML response.',
      impact: 'high',
      effort: 'hard',
      dedupeKey: 'rendering',
    });
  }
  return pass({
    id: 'js-render-dependency',
    category: 'ai-search',
    title: 'Primary text is in the HTML',
    description: 'Raw visible text is close to the rendered text on sampled pages.',
    fix: 'Keep important copy in the initial HTML.',
    impact: 'high',
    effort: 'hard',
    dedupeKey: 'rendering',
  });
}

function schemaCoverage(snapshot: CrawlSnapshot): AuditCheck {
  const types = new Set(snapshot.pages.flatMap((page) => page.schemaTypes));
  const found = SCHEMA_TYPES.filter((type) => types.has(type));
  const errors = snapshot.pages.filter((page) => page.schemaErrors.length > 0);
  if (errors.length) {
    return present({
      id: 'ai-structured-data',
      category: 'ai-search',
      severity: 'warning',
      title: 'Structured data has parse errors',
      description: `JSON-LD failed to parse. Types seen: ${found.join(', ') || 'none'}. Schema does not guarantee rich results or AI citations.`,
      affectedUrls: errors.map((page) => page.finalUrl),
      affectedCount: errors.length,
      fix: 'Fix JSON syntax. Only mark up entities the page actually shows.',
      impact: 'medium',
      effort: 'medium',
      dedupeKey: 'schema',
    });
  }
  if (found.length === 0) {
    return present({
      id: 'ai-structured-data',
      category: 'ai-search',
      severity: 'info',
      title: 'No common structured data types found',
      description: 'Organization, WebSite, Product, Article, FAQPage, BreadcrumbList, and Review were not found. Missing schema is not proof of low trust.',
      affectedUrls: [snapshot.startUrl],
      affectedCount: 1,
      fix: 'Add JSON-LD only for types you can support with visible content.',
      impact: 'medium',
      effort: 'medium',
      dedupeKey: 'schema',
    });
  }
  return pass({
    id: 'ai-structured-data',
    category: 'ai-search',
    title: 'Structured data types found',
    description: `Found ${found.join(', ')}. This confirms parseable types, not correctness or rich-result eligibility.`,
    fix: 'Keep the markup consistent with the visible page.',
    impact: 'medium',
    effort: 'medium',
    dedupeKey: 'schema',
  });
}

function answerStructure(snapshot: CrawlSnapshot): AuditCheck {
  const pages = snapshot.pages.filter((page) => page.isHtml && page.statusCode && page.statusCode < 400);
  if (!pages.length) {
    return makeCheck({
      id: 'answer-structure',
      category: 'ai-search',
      status: 'unavailable',
      severity: 'info',
      title: 'Answer structure unavailable',
      description: 'No successful HTML page was available to review headings and lists.',
      fix: 'Retry after the crawl can fetch HTML.',
      impact: 'low',
      effort: 'medium',
    });
  }
  const weak = pages.filter((page) => {
    const skipped = headingOrderBroken(page);
    return page.questionHeadingCount === 0 && page.listCount === 0 && page.tableCount === 0 && skipped;
  });
  if (weak.length === pages.length) {
    return present({
      id: 'answer-structure',
      category: 'ai-search',
      severity: 'info',
      title: 'Pages have little answer-oriented structure',
      description: 'Sampled pages lack question headings, lists, tables, and a clean H2/H3 outline. This is a writing heuristic, not a penalty by itself.',
      affectedUrls: weak.map((page) => page.finalUrl),
      affectedCount: weak.length,
      fix: 'Use H2 questions, a short answer paragraph, and lists where they match the content.',
      impact: 'medium',
      effort: 'medium',
    });
  }
  const broken = pages.filter(headingOrderBroken);
  if (broken.length) {
    return present({
      id: 'answer-structure',
      category: 'ai-search',
      severity: 'info',
      title: 'Heading outline skips levels',
      description: 'An H3 appears without a preceding H2, so the outline is harder to follow.',
      affectedUrls: broken.map((page) => page.finalUrl),
      affectedCount: broken.length,
      fix: 'Nest H3 sections under an H2.',
      impact: 'low',
      effort: 'easy',
    });
  }
  return pass({
    id: 'answer-structure',
    category: 'ai-search',
    title: 'Pages use a readable outline',
    description: 'Sampled pages include headings and supporting structure such as lists, tables, or question-style headings.',
    fix: 'Keep headings descriptive.',
    impact: 'medium',
    effort: 'easy',
  });
}

function headingOrderBroken(page: PageSnapshot): boolean {
  let seenH2 = false;
  for (const heading of page.headings) {
    if (heading.level === 2) seenH2 = true;
    if (heading.level === 3 && !seenH2) return true;
  }
  return false;
}

function trustSignals(snapshot: CrawlSnapshot): AuditCheck {
  const pages = snapshot.pages.filter((page) => page.isHtml);
  if (!pages.length) {
    return makeCheck({
      id: 'trust-signals',
      category: 'ai-search',
      status: 'unavailable',
      severity: 'info',
      title: 'Trust signals unavailable',
      description: 'No HTML was available. Missing signals would not be treated as proof of low trust anyway.',
      fix: 'Retry the crawl.',
      impact: 'low',
      effort: 'medium',
    });
  }
  const hasAuthor = pages.some((page) => page.author);
  const hasDates = pages.some((page) => page.published || page.modified);
  const hasAbout = pages.some((page) => page.hasAboutLink);
  const hasContact = pages.some((page) => page.hasContactLink);
  const hasOrg = pages.some((page) => page.schemaTypes.includes('Organization'));
  const hasReview = pages.some((page) => page.schemaTypes.includes('Review') || page.schemaTypes.includes('AggregateRating'));
  const missing: string[] = [];
  if (!hasAuthor) missing.push('author');
  if (!hasDates) missing.push('dates');
  if (!hasAbout) missing.push('about page');
  if (!hasContact) missing.push('contact page');
  if (!hasOrg) missing.push('organization identity');
  if (missing.length >= 4) {
    return present({
      id: 'trust-signals',
      category: 'ai-search',
      severity: 'info',
      title: 'Few visible trust signals',
      description: `Not found in the sample: ${missing.join(', ')}. Review markup present: ${hasReview ? 'yes' : 'no'}. Absence is not proof of low trust.`,
      affectedUrls: [snapshot.startUrl],
      affectedCount: missing.length,
      fix: 'Link an about page and a contact page, and show an author and dates on articles.',
      impact: 'medium',
      effort: 'medium',
    });
  }
  return pass({
    id: 'trust-signals',
    category: 'ai-search',
    title: 'Some trust signals are present',
    description: `Missing from the sample: ${missing.join(', ') || 'none'}. Review markup: ${hasReview ? 'present' : 'not seen'}.`,
    fix: 'Keep author, dates, and organization details consistent with the visible page.',
    impact: 'medium',
    effort: 'medium',
  });
}

export function emptyBotAccess(status: BotAccess): Record<AiBot, BotAccess> {
  return Object.fromEntries(AI_BOTS.map((bot) => [bot, status])) as Record<AiBot, BotAccess>;
}
