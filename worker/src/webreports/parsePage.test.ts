import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml } from './parsePage';
import { evaluateBotAccess, isAllowedByRobots } from './robotsEval';

describe('HTML parsing', () => {
  it('collects titles, headings, alt gaps, and JSON-LD errors', () => {
    const parsed = parseHtml(
      `<html><head><title>Hello</title><meta name="viewport" content="width=device-width">
        <script type="application/ld+json">{"@type":"Organization"}</script>
        <script type="application/ld+json">{bad</script></head>
        <body><h1>Hello</h1><img src="a.jpg"><img alt="" src="b.jpg"><a href="/about">About</a></body></html>`,
      'https://example.com/'
    );
    assert.equal(parsed.title, 'Hello');
    assert.deepEqual(parsed.h1, ['Hello']);
    assert.equal(parsed.imagesMissingAlt, 1);
    assert.ok(parsed.schemaTypes.includes('Organization'));
    assert.equal(parsed.schemaErrors.length, 1);
    assert.equal(parsed.hasAboutLink, true);
  });

  it('does not treat non-html timeouts as rendered text', () => {
    const parsed = parseHtml('<html><body></body></html>', 'https://example.com/');
    assert.equal(parsed.renderedVisibleTextLength, null);
  });
});

describe('robots evaluation', () => {
  const body = `User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nDisallow: /private\n`;

  it('blocks only the named bot on the homepage and allows another path distinction', () => {
    const result = evaluateBotAccess(body, 'ok', 'https://example.com', ['https://example.com/', 'https://example.com/private']);
    assert.equal(result.access.GPTBot, 'blocked');
    assert.equal(result.access['OAI-SearchBot'], 'allowed');
    assert.ok(result.notes.some((note) => note.includes('OAI-SearchBot') && note.includes('/private')));
  });

  it('marks a missing file unspecified and a failed fetch unavailable', () => {
    assert.equal(evaluateBotAccess('', 'missing', 'https://example.com', ['https://example.com/']).access.ClaudeBot, 'unspecified');
    assert.equal(evaluateBotAccess(null, 'unavailable', 'https://example.com', ['https://example.com/']).access.CCBot, 'unavailable');
  });

  it('applies ReadyioBot rules separately from AI bots', () => {
    const rules = `User-agent: ReadyioBot\nDisallow: /secret\n\nUser-agent: *\nAllow: /\n`;
    assert.equal(isAllowedByRobots(rules, 'https://example.com', 'https://example.com/secret'), false);
    assert.equal(isAllowedByRobots(rules, 'https://example.com', 'https://example.com/'), true);
  });
});
