import type { AuditCheck, ScoreBlock, Completeness } from './types';
import { PENALTY, type ScoreWeights } from './scoringConfig';

/** Half away from zero, then clamp to 0–100. */
export function roundScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(100, Math.max(0, value));
  const rounded = Math.sign(clamped) * Math.round(Math.abs(clamped));
  return Math.min(100, Math.max(0, rounded));
}

/**
 * Deduct from 100 for unique present findings. Unavailable-only input returns
 * null so a failed stage is not a zero or a perfect score. Duplicate ids are ignored.
 */
export function scoreChecks(checks: AuditCheck[]): number | null {
  const seen = new Set<string>();
  let evaluated = 0;
  let penalty = 0;
  for (const check of checks) {
    if (seen.has(check.id)) continue;
    seen.add(check.id);
    if (check.status === 'unavailable' || check.status === 'inconclusive') continue;
    evaluated += 1;
    if (check.status === 'present') penalty += PENALTY[check.severity];
  }
  if (evaluated === 0) return null;
  return roundScore(100 - penalty);
}

export function combineScores(
  scores: Omit<ScoreBlock, 'overall'>,
  weights: ScoreWeights
): { overall: number | null; completeness: Completeness } {
  const keys = ['mobile', 'desktop', 'seo', 'aiSearch'] as const;
  const available = keys.filter((key) => scores[key] !== null);
  const unavailableSections = keys.filter((key) => scores[key] === null);
  if (available.length === 0) {
    return {
      overall: null,
      completeness: { complete: false, unavailableSections: [...unavailableSections] },
    };
  }
  const weightSum = available.reduce((sum, key) => sum + weights[key], 0);
  const overall = available.reduce((sum, key) => sum + (scores[key] as number) * weights[key], 0) / weightSum;
  return {
    overall: roundScore(overall),
    completeness: {
      complete: unavailableSections.length === 0,
      unavailableSections: [...unavailableSections],
    },
  };
}
