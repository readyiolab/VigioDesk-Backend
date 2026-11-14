import type { BotAccess, CrawlSnapshot } from './types';

/** Search crawlers we evaluate for SEO robots policy (separate from AI bots). */
export const SEARCH_BOTS = ['Googlebot', '*'] as const;
export type SearchBot = (typeof SEARCH_BOTS)[number];

export type SearchBotAccess = Record<SearchBot, BotAccess>;

export function emptySearchBotAccess(status: BotAccess = 'allowed'): SearchBotAccess {
  return { Googlebot: status, '*': status };
}

/** True when User-agent: * (or equivalent) blocks the whole site with Disallow: /. */
export function isSitewideDisallowAll(body: string | null): boolean {
  if (!body?.trim()) return false;
  const records = body.split(/\n\s*\n/);
  for (const record of records) {
    const agents = Array.from(record.matchAll(/^user-agent:\s*(.+)$/gim)).map((m) =>
      m[1].trim().toLowerCase()
    );
    if (!agents.includes('*')) continue;
    const disallows = Array.from(record.matchAll(/^disallow:\s*(.*)$/gim)).map((m) =>
      m[1].trim()
    );
    if (disallows.some((path) => path === '/' || path === '/*')) return true;
  }
  return false;
}

export function robotsHasSitemapDirective(body: string | null): boolean {
  if (!body) return false;
  return /^sitemap:\s*\S+/im.test(body);
}

export function googlebotBlocked(snapshot: CrawlSnapshot): boolean {
  const access = snapshot.searchBotAccess;
  if (!access) return false;
  return access.Googlebot === 'blocked' || access['*'] === 'blocked';
}
