export class UrlSafetyError extends Error {
  readonly code: string;
  readonly clientMessage: string;

  constructor(code: string, clientMessage: string) {
    super(clientMessage);
    this.name = 'UrlSafetyError';
    this.code = code;
    this.clientMessage = clientMessage;
  }
}

export interface CanonicalUrl {
  /** Canonical URL used as the cache key. Path and query semantics are preserved. */
  url: string;
  hostname: string;
  origin: string;
  href: URL;
}

const MAX_URL_LENGTH = 2048;

/** Hostname without a trailing dot or IPv6 brackets. */
export function unwrapHostname(hostname: string): string {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/**
 * Cache identity.
 * Lowercase the scheme and host, drop default ports and fragments, and sort
 * query parameters. Path, trailing slash, and query values are preserved so
 * URLs that can change content are not merged. Userinfo is rejected.
 */
export function canonicalizeUrl(raw: string): CanonicalUrl {
  if (typeof raw !== 'string') {
    throw new UrlSafetyError('malformed', 'Enter a valid http or https URL.');
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) {
    throw new UrlSafetyError('malformed', 'Enter a valid http or https URL.');
  }
  if (trimmed.includes('\\')) {
    throw new UrlSafetyError('ambiguous', 'That URL is not supported.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UrlSafetyError('malformed', 'Enter a valid http or https URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlSafetyError('protocol', 'Only http and https websites can be scanned.');
  }
  if (parsed.username || parsed.password) {
    throw new UrlSafetyError('credentials', 'URLs with embedded credentials are not allowed.');
  }

  const authority = trimmed.split('?')[0].split('#')[0];
  if (authority.includes('@')) {
    throw new UrlSafetyError('credentials', 'URLs with embedded credentials are not allowed.');
  }

  const hostname = unwrapHostname(parsed.hostname);
  if (!hostname) {
    throw new UrlSafetyError('malformed', 'Enter a valid http or https URL.');
  }

  const isHttps = parsed.protocol === 'https:';
  const port = parsed.port;
  const defaultPort = isHttps ? '443' : '80';
  const displayHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  const hostWithPort = port && port !== defaultPort ? `${displayHost}:${port}` : displayHost;

  const params = Array.from(parsed.searchParams.entries()).sort((a, b) => {
    if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    return a[0] < b[0] ? -1 : 1;
  });
  const search = new URLSearchParams();
  for (const [key, value] of params) search.append(key, value);
  const query = search.toString();

  const url = `${parsed.protocol}//${hostWithPort}${parsed.pathname}${query ? `?${query}` : ''}`;
  const href = new URL(url);
  return { url, hostname, origin: href.origin, href };
}

/** Same scheme, hostname, and effective port. Fragments are ignored. */
export function isSameOrigin(candidate: string, origin: string): boolean {
  try {
    const canonical = canonicalizeUrl(candidate);
    return canonical.origin === origin;
  } catch {
    return false;
  }
}

export function normalizeCrawlUrl(candidate: string, base?: string): string | null {
  try {
    const absolute = base ? new URL(candidate, base).toString() : candidate;
    return canonicalizeUrl(absolute).url;
  } catch {
    return null;
  }
}
