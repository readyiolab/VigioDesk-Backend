import robotsParser from 'robots-parser';
import { AI_BOTS, type AiBot, type BotAccess } from '../../../shared/webreports/types';

export function sitemapsFromRobots(body: string): string[] {
  return Array.from(body.matchAll(/^sitemap:\s*(\S+)/gim))
    .map((match) => match[1].trim())
    .slice(0, 20);
}

function hasGroup(body: string, agent: string): boolean {
  const records = body.split(/\n\s*\n/);
  return records.some((record) => {
    const agents = Array.from(record.matchAll(/^user-agent:\s*(.+)$/gim)).map((match) => match[1].trim().toLowerCase());
    return agents.includes(agent.toLowerCase());
  });
}

export function evaluateBotAccess(
  body: string | null,
  status: 'ok' | 'missing' | 'unavailable',
  origin: string,
  paths: string[]
): { access: Record<AiBot, BotAccess>; notes: string[] } {
  if (status === 'unavailable' || body === null) {
    return {
      access: Object.fromEntries(AI_BOTS.map((bot) => [bot, 'unavailable'])) as Record<AiBot, BotAccess>,
      notes: [],
    };
  }
  if (status === 'missing' || !body.trim()) {
    return {
      access: Object.fromEntries(AI_BOTS.map((bot) => [bot, 'unspecified'])) as Record<AiBot, BotAccess>,
      notes: [],
    };
  }
  const parser = robotsParser(`${origin}/robots.txt`, body);
  const home = paths[0] || `${origin}/`;
  const access = {} as Record<AiBot, BotAccess>;
  const notes: string[] = [];
  for (const bot of AI_BOTS) {
    const specific = hasGroup(body, bot);
    const wildcard = hasGroup(body, '*');
    if (!specific && !wildcard) {
      access[bot] = 'unspecified';
      continue;
    }
    const homeAllowed = parser.isAllowed(home, bot);
    access[bot] = homeAllowed === false ? 'blocked' : 'allowed';
    for (const path of paths.slice(1, 4)) {
      const allowed = parser.isAllowed(path, bot);
      const pathBlocked = allowed === false;
      if (pathBlocked !== (access[bot] === 'blocked')) {
        notes.push(`${bot} is ${pathBlocked ? 'blocked' : 'allowed'} on ${path}, which differs from the homepage.`);
      }
    }
  }
  return { access, notes: notes.slice(0, 8) };
}

export function isAllowedByRobots(body: string | null, origin: string, url: string): boolean {
  if (!body) return true;
  const parser = robotsParser(`${origin}/robots.txt`, body);
  return parser.isAllowed(url, 'ZuvigoBot') !== false;
}
