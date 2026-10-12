import type { Stage } from './types';

/** Progress is monotonic. 100 is reserved for a durably saved report. */
export const STAGE_PROGRESS: Record<Stage, number> = {
  validating: 5,
  crawling: 20,
  analyzing_seo: 40,
  analyzing_ai_search: 52,
  testing_mobile: 68,
  testing_desktop: 82,
  scoring: 90,
  generating_summary: 94,
  saving_results: 97,
  completed: 100,
};

export function progressFor(stage: Stage): number {
  return STAGE_PROGRESS[stage];
}

export function nextProgress(current: number, stage: Stage): number {
  const target = progressFor(stage);
  const bounded = Math.max(0, Math.min(100, target));
  return Math.max(current, bounded);
}
