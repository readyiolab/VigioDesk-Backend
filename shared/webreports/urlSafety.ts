import ipaddr from 'ipaddr.js';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { canonicalizeUrl, type CanonicalUrl, unwrapHostname, UrlSafetyError } from './canonicalize';

export { UrlSafetyError } from './canonicalize';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.com',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
  'localhost',
]);

/** Public-looking addresses that are still cloud metadata or internal services. */
const DENIED_IPS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  '168.63.129.16',
  '192.0.0.192',
  'fd00:ec2::254',
]);

const ALLOWED_RANGES = new Set(['unicast']);

export function isProhibitedAddress(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed || DENIED_IPS.has(trimmed)) return true;
  if (!ipaddr.isValid(trimmed)) return true;
  let parsed = ipaddr.parse(trimmed);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  const normalized = parsed.toString();
  if (DENIED_IPS.has(normalized)) return true;
  return !ALLOWED_RANGES.has(parsed.range());
}

function isMetadataHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTS.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  return false;
}

/**
 * Reject decimal, octal, hex, and other numeric host forms that are not a
 * plain dotted IPv4 or an IPv6 literal already accepted by the URL parser.
 */
export function rejectUnsupportedNumericHost(hostname: string): void {
  const host = hostname.toLowerCase();
  if (/^\d+$/.test(host)) {
    throw new UrlSafetyError('numeric-ip', 'That address format is not supported.');
  }
  if (host.includes('.') && !ipaddr.IPv4.isValidFourPartDecimal(host)) {
    const parts = host.split('.');
    const numeric = parts.every((part) => /^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(part));
    if (numeric) {
      throw new UrlSafetyError('numeric-ip', 'That address format is not supported.');
    }
  }
}

export function assertHostnameAllowed(hostname: string): void {
  if (isMetadataHostname(hostname)) {
    throw new UrlSafetyError('metadata', 'That host cannot be scanned.');
  }
  rejectUnsupportedNumericHost(hostname);
  if (ipaddr.isValid(hostname) && isProhibitedAddress(hostname)) {
    throw new UrlSafetyError('private-address', 'That address cannot be scanned.');
  }
}

export async function resolveSafeAddresses(
  hostname: string,
  resolve: DnsResolver
): Promise<ResolvedAddress[]> {
  assertHostnameAllowed(hostname);
  if (ipaddr.isValid(hostname)) {
    if (isProhibitedAddress(hostname)) {
      throw new UrlSafetyError('private-address', 'That address cannot be scanned.');
    }
    const parsed = ipaddr.parse(hostname);
    const family = parsed.kind() === 'ipv6' ? 6 : 4;
    return [{ address: parsed.toString(), family }];
  }

  let records: ResolvedAddress[];
  try {
    records = await resolve(hostname);
  } catch (err) {
    if (err instanceof UrlSafetyError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'ETIMEOUT' || code === 'DNS_TIMEOUT') {
      throw new UrlSafetyError('dns-timeout', 'The website could not be resolved in time.');
    }
    throw new UrlSafetyError('dns', 'The website could not be resolved.');
  }

  if (!records.length) {
    throw new UrlSafetyError('dns', 'The website could not be resolved.');
  }
  for (const record of records) {
    if (isProhibitedAddress(record.address)) {
      throw new UrlSafetyError('private-address', 'That website resolves to a blocked address.');
    }
  }
  return records;
}

export async function assertSafeTarget(raw: string, resolve: DnsResolver): Promise<CanonicalUrl> {
  const canonical = canonicalizeUrl(raw);
  await resolveSafeAddresses(canonical.hostname, resolve);
  return canonical;
}

export interface PinnedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  address: string;
}

export type PinnedRequester = (input: {
  url: URL;
  address: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
}) => Promise<PinnedResponse>;

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  finalUrl: string;
  redirectChain: string[];
  address: string;
}

const HOP_STATUSES = new Set([301, 302, 303, 307, 308]);

function header(headers: PinnedResponse['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export async function safeFetch(
  raw: string,
  options: {
    resolve: DnsResolver;
    request?: PinnedRequester;
    maxRedirects?: number;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  }
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const request = options.request ?? defaultPinnedRequest;
  const signal = options.signal ?? new AbortController().signal;

  let current = raw;
  const redirectChain: string[] = [];
  const started = Date.now();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (signal.aborted) throw new UrlSafetyError('timeout', 'The request timed out.');
    if (Date.now() - started > timeoutMs) {
      throw new UrlSafetyError('timeout', 'The request timed out.');
    }
    const canonical = await assertSafeTarget(current, options.resolve);
    const records = await resolveSafeAddresses(canonical.hostname, options.resolve);
    const chosen = records[0];
    const response = await request({
      url: canonical.href,
      address: chosen.address,
      family: chosen.family,
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
      maxBytes,
      signal,
    });
    if (response.address !== chosen.address) {
      throw new UrlSafetyError('rebinding', 'The connection target did not match the validated address.');
    }
    if (isProhibitedAddress(response.address)) {
      throw new UrlSafetyError('private-address', 'That website resolves to a blocked address.');
    }

    const location = header(response.headers, 'location');
    if (HOP_STATUSES.has(response.status) && location) {
      if (hop === maxRedirects) {
        throw new UrlSafetyError('redirects', 'The website redirected too many times.');
      }
      let next: string;
      try {
        next = new URL(location, canonical.url).toString();
      } catch {
        throw new UrlSafetyError('redirects', 'The website returned an invalid redirect.');
      }
      if (redirectChain.includes(canonical.url) || next === canonical.url) {
        throw new UrlSafetyError('redirects', 'The website redirected in a loop.');
      }
      redirectChain.push(canonical.url);
      current = next;
      continue;
    }

    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      finalUrl: canonical.url,
      redirectChain,
      address: response.address,
    };
  }

  throw new UrlSafetyError('redirects', 'The website redirected too many times.');
}

export function defaultPinnedRequest(input: {
  url: URL;
  address: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const lib = input.url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: input.url.protocol,
        hostname: unwrapHostname(input.url.hostname),
        port: input.url.port || (input.url.protocol === 'https:' ? 443 : 80),
        path: `${input.url.pathname}${input.url.search}`,
        method: 'GET',
        headers: {
          'User-Agent': 'ZuvigoBot/1.0 (+https://zuvigo.com/bot)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Host: input.url.host,
        },
        servername: unwrapHostname(input.url.hostname),
        lookup: (_hostname, options, callback) => {
          const cb = typeof options === 'function' ? options : callback;
          cb(null, input.address, input.family);
        },
        timeout: input.timeoutMs,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.maxBytes) {
            req.destroy();
            reject(new UrlSafetyError('response-size', 'The response was too large.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            address: input.address,
          });
        });
      }
    );
    const fail = (err: Error) => {
      if ((err as { code?: string }).code === 'ECONNRESET' && input.signal.aborted) {
        reject(new UrlSafetyError('timeout', 'The request timed out.'));
        return;
      }
      reject(err);
    };
    req.on('timeout', () => {
      req.destroy();
      reject(new UrlSafetyError('timeout', 'The request timed out.'));
    });
    req.on('error', fail);
    input.signal.addEventListener('abort', () => req.destroy(), { once: true });
    req.end();
  });
}

export interface ProxyDecision {
  ok: true;
  address: string;
  family: 4 | 6;
  hostname: string;
  port: number;
}

export async function authorizeProxyTarget(
  hostport: string,
  resolve: DnsResolver
): Promise<ProxyDecision> {
  const raw = hostport.trim();
  let hostname = raw;
  let port = 443;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) throw new UrlSafetyError('malformed', 'That host cannot be scanned.');
    hostname = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest.startsWith(':')) port = Number(rest.slice(1));
  } else {
    const idx = raw.lastIndexOf(':');
    if (idx > -1 && raw.indexOf(':') === idx) {
      hostname = raw.slice(0, idx);
      port = Number(raw.slice(idx + 1));
    }
  }
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UrlSafetyError('malformed', 'That host cannot be scanned.');
  }
  const records = await resolveSafeAddresses(hostname, resolve);
  return { ok: true, address: records[0].address, family: records[0].family, hostname, port };
}

export async function nodeDnsResolve(hostname: string): Promise<ResolvedAddress[]> {
  const dns = await import('node:dns/promises');
  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch((err: { code?: string }) => {
      if (err.code === 'ENODATA' || err.code === 'ENOTFOUND' || err.code === 'EREFUSED') return [];
      throw err;
    }),
    dns.resolve6(hostname).catch((err: { code?: string }) => {
      if (err.code === 'ENODATA' || err.code === 'ENOTFOUND' || err.code === 'EREFUSED') return [];
      throw err;
    }),
  ]);
  return [
    ...v4.map((address) => ({ address, family: 4 as const })),
    ...v6.map((address) => ({ address, family: 6 as const })),
  ];
}
