import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { combineScores, roundScore, scoreChecks } from '../../../../shared/webreports/scoring';
import { resolveWeights, ScoringConfigError, DEFAULT_WEIGHTS } from '../../../../shared/webreports/scoringConfig';
import { makeCheck } from '../../../../shared/webreports/checkFactory';
import { buildRecommendations } from '../../../../shared/webreports/recommendations';
import { emptyDevice } from '../../../../shared/webreports/vitals';
import { canPersistJob, canTransition } from '../../../../shared/webreports/lifecycle';
import { toPublicReport, toReportContract } from '../../../../shared/webreports/contract';
import { SCORING_VERSION, CONTRACT_VERSION } from '../../../../shared/webreports/types';

const finding = (id: string, severity: 'critical' | 'warning' | 'info' = 'warning') =>
  makeCheck({
    id,
    category: 'seo',
    status: 'present',
    severity,
    title: id,
    description: id,
    affectedUrls: ['https://example.com'],
    affectedCount: 1,
    fix: 'fix',
    impact: 'high',
    effort: 'easy',
  });

describe('scoring', () => {
  it('uses the default weights', () => {
    const resolved = resolveWeights(DEFAULT_WEIGHTS);
    assert.equal(resolved.normalized, false);
    assert.equal(resolved.weights.mobile, 30);
  });

  it('normalizes custom weights and rejects invalid ones', () => {
    const normalized = resolveWeights({ mobile: 1, desktop: 1, seo: 1, aiSearch: 1 });
    assert.equal(normalized.normalized, true);
    assert.equal(Math.round(normalized.weights.mobile), 25);
    assert.throws(() => resolveWeights({ mobile: -1, desktop: 1, seo: 1, aiSearch: 1 }), ScoringConfigError);
    assert.throws(() => resolveWeights({ mobile: 0, desktop: 0, seo: 0, aiSearch: 0 }), ScoringConfigError);
  });

  it('ignores duplicate findings and does not treat missing data as zero or perfect', () => {
    const once = scoreChecks([finding('a', 'critical'), finding('a', 'critical')]);
    assert.equal(once, 80);
    assert.equal(scoreChecks([makeCheck({ ...finding('b'), status: 'unavailable', severity: 'info' })]), null);
    assert.equal(roundScore(140), 100);
    assert.equal(roundScore(-4), 0);
  });

  it('renormalizes when a category is unavailable and reports completeness', () => {
    const result = combineScores({ mobile: null, desktop: 80, seo: 60, aiSearch: 40 }, DEFAULT_WEIGHTS);
    const weight = 15 + 30 + 25;
    const expected = Math.round((80 * 15 + 60 * 30 + 40 * 25) / weight);
    assert.equal(result.overall, expected);
    assert.equal(result.completeness.complete, false);
    assert.deepEqual(result.completeness.unavailableSections, ['mobile']);
  });

  it('is deterministic', () => {
    const checks = [finding('b'), finding('a', 'critical')];
    assert.equal(scoreChecks(checks), scoreChecks([...checks].reverse()));
  });
});

describe('recommendations and lifecycle', () => {
  it('returns at most six ranked fixes and does not invent a cache fix', () => {
    const checks = Array.from({ length: 8 }, (_, index) => finding(`c${index}`, index === 0 ? 'critical' : 'info'));
    const fixes = buildRecommendations(checks, { mobile: emptyDevice(), desktop: emptyDevice() });
    assert.equal(fixes.length, 6);
    assert.equal(fixes[0].checkIds[0], 'c0');
    assert.equal(fixes.some((fix) => fix.title.toLowerCase().includes('cache')), false);
  });

  it('allows only legal status transitions and ignores stale jobs', () => {
    assert.equal(canTransition('queued', 'running'), true);
    assert.equal(canTransition('running', 'completed'), true);
    assert.equal(canTransition('completed', 'running'), false);
    assert.equal(canPersistJob({ status: 'running', activeJobId: 'a', jobGeneration: 2 }, { jobId: 'a', generation: 2 }), true);
    assert.equal(canPersistJob({ status: 'running', activeJobId: 'a', jobGeneration: 2 }, { jobId: 'b', generation: 1 }), false);
    assert.equal(canPersistJob({ status: 'completed', activeJobId: 'a', jobGeneration: 2 }, { jobId: 'a', generation: 2 }), false);
    assert.equal(canPersistJob(null, { jobId: 'a', generation: 1 }), false);
  });
});

describe('public report allowlist', () => {
  it('omits account and share fields', () => {
    const report = toReportContract({
      row: {
        id: '11111111-1111-1111-1111-111111111111',
        url: 'https://example.com',
        status: 'failed',
        stage: 'crawling',
        progress: 20,
        createdAt: '2026-10-12T00:00:00.000Z',
        completedAt: null,
        pagesCrawled: 0,
        overallScore: null,
        mobileScore: null,
        desktopScore: null,
        seoScore: null,
        aiScore: null,
        summaryHeadline: null,
        summaryText: null,
        shareToken: 'a'.repeat(64),
        errorMessage: 'database password leaked',
        completenessJson: null,
        topFixesJson: '[]',
        scoringVersion: SCORING_VERSION,
        contractVersion: CONTRACT_VERSION,
        detailJson: null,
      },
      checks: [],
      perf: [],
    });
    const pub = toPublicReport(report);
    assert.equal('id' in pub, false);
    assert.equal('shareToken' in pub, false);
    assert.equal(pub.error?.message.includes('password'), false);
    assert.equal(pub.contractVersion, 1);
  });
});
