import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('webreports integrations helpers', () => {
  it('normalizes host from url-like input', () => {
    const hostFromUrl = (url: string): string => {
      try {
        return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
      } catch {
        return url.replace(/^www\./i, '').toLowerCase();
      }
    };
    assert.equal(hostFromUrl('https://www.Example.com/path'), 'example.com');
    assert.equal(hostFromUrl('lendigomicrocare.com'), 'lendigomicrocare.com');
  });
});
