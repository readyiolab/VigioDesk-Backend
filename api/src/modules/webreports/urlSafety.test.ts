import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl } from '../../../../shared/webreports/canonicalize';
import {
  assertSafeTarget,
  authorizeProxyTarget,
  isProhibitedAddress,
  safeFetch,
  type DnsResolver,
  type PinnedRequester,
  UrlSafetyError,
} from '../../../../shared/webreports/urlSafety';

const publicDns: DnsResolver = async () => [{ address: '8.8.8.8', family: 4 }];

function resolver(records: { address: string; family: 4 | 6 }[]): DnsResolver {
  return async () => records;
}

describe('URL canonicalization', () => {
  it('accepts http and https and normalizes host and default ports', () => {
    assert.equal(canonicalizeUrl('https://Example.COM:443/a').url, 'https://example.com/a');
    assert.equal(canonicalizeUrl('http://example.com:80/').url, 'http://example.com/');
  });

  it('sorts query parameters and drops fragments without merging paths', () => {
    assert.equal(canonicalizeUrl('https://example.com/a?b=1&a=2#x').url, 'https://example.com/a?a=2&b=1');
    assert.notEqual(canonicalizeUrl('https://example.com/a').url, canonicalizeUrl('https://example.com/a/').url);
  });

  it('rejects unsupported protocols, credentials, and ambiguous forms', () => {
    assert.throws(() => canonicalizeUrl('ftp://example.com'), UrlSafetyError);
    assert.throws(() => canonicalizeUrl('javascript:alert(1)'), UrlSafetyError);
    assert.throws(() => canonicalizeUrl('https://user:pass@example.com'), UrlSafetyError);
    assert.throws(() => canonicalizeUrl('https://example.com\\@evil.com'), UrlSafetyError);
  });
});

describe('address classification', () => {
  it('blocks private, loopback, link-local, mapped, and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '100.64.0.1', '224.0.0.1']) {
      assert.equal(isProhibitedAddress(ip), true, ip);
    }
    assert.equal(isProhibitedAddress('8.8.8.8'), false);
    assert.equal(isProhibitedAddress('2001:4860:4860::8888'), false);
  });

  it('rejects metadata hostnames and numeric IP forms before DNS', async () => {
    await assert.rejects(() => assertSafeTarget('http://metadata.google.internal/', publicDns), UrlSafetyError);
    await assert.rejects(() => assertSafeTarget('http://2130706433/', publicDns), UrlSafetyError);
    await assert.rejects(() => assertSafeTarget('http://127.0.0.1/', publicDns), UrlSafetyError);
    await assert.rejects(() => assertSafeTarget('http://[::1]/', publicDns), UrlSafetyError);
  });

  it('rejects a hostname when any answer is private', async () => {
    await assert.rejects(
      () => assertSafeTarget('https://example.com', resolver([
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ])),
      UrlSafetyError
    );
  });

  it('reports DNS failures and timeouts', async () => {
    await assert.rejects(
      () => assertSafeTarget('https://example.com', async () => { throw Object.assign(new Error('fail'), { code: 'ENOTFOUND' }); }),
      (err: unknown) => err instanceof UrlSafetyError && err.code === 'dns'
    );
    await assert.rejects(
      () => assertSafeTarget('https://example.com', async () => { throw Object.assign(new Error('slow'), { code: 'ETIMEOUT' }); }),
      (err: unknown) => err instanceof UrlSafetyError && err.code === 'dns-timeout'
    );
  });
});

describe('pinned fetch and proxy decisions', () => {
  it('connects only to the validated address', async () => {
    const seen: string[] = [];
    const request: PinnedRequester = async (input) => {
      seen.push(input.address);
      return { status: 200, headers: {}, body: Buffer.from('ok'), address: input.address };
    };
    const result = await safeFetch('https://example.com/page', { resolve: publicDns, request });
    assert.deepEqual(seen, ['8.8.8.8']);
    assert.equal(result.address, '8.8.8.8');
  });

  it('rejects a connection that does not use the pinned address', async () => {
    const request: PinnedRequester = async () => ({ status: 200, headers: {}, body: Buffer.from(''), address: '10.0.0.1' });
    await assert.rejects(() => safeFetch('https://example.com', { resolve: publicDns, request }), UrlSafetyError);
  });

  it('revalidates redirects and blocks a hop to a private address', async () => {
    const request: PinnedRequester = async () => ({
      status: 302,
      headers: { location: 'http://127.0.0.1/secret' },
      body: Buffer.from(''),
      address: '8.8.8.8',
    });
    await assert.rejects(() => safeFetch('https://example.com', { resolve: publicDns, request }), UrlSafetyError);
  });

  it('stops redirect loops and chains longer than five', async () => {
    let hops = 0;
    const request: PinnedRequester = async (input) => {
      hops += 1;
      return {
        status: 302,
        headers: { location: input.url.toString() },
        body: Buffer.from(''),
        address: '8.8.8.8',
      };
    };
    await assert.rejects(() => safeFetch('https://example.com/a', { resolve: publicDns, request }), UrlSafetyError);
    assert.ok(hops <= 6);
  });

  it('blocks browser proxy targets that are private and allows public DNS', async () => {
    await assert.rejects(() => authorizeProxyTarget('127.0.0.1:80', publicDns), UrlSafetyError);
    await assert.rejects(() => authorizeProxyTarget('[::ffff:10.1.1.1]:443', publicDns), UrlSafetyError);
    const allowed = await authorizeProxyTarget('example.com:443', publicDns);
    assert.equal(allowed.address, '8.8.8.8');
    assert.equal(allowed.port, 443);
  });
});
