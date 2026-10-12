export interface ScoreWeights {
  mobile: number;
  desktop: number;
  seo: number;
  aiSearch: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  mobile: 30,
  desktop: 15,
  seo: 30,
  aiSearch: 25,
};

/** Heuristic thresholds. Definite errors do not use these. */
export const HEURISTICS = {
  titleMin: 15,
  titleMax: 60,
  descriptionMin: 50,
  descriptionMax: 160,
  thinWordCount: 200,
  jsRenderRatio: 0.3,
  jsRenderMinExtraChars: 200,
  redirectChainWarning: 2,
};

export const PENALTY: Record<'critical' | 'warning' | 'info' | 'pass', number> = {
  critical: 20,
  warning: 10,
  info: 4,
  pass: 0,
};

const WEIGHT_KEYS = ['mobile', 'desktop', 'seo', 'aiSearch'] as const;

export class ScoringConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringConfigError';
  }
}

/**
 * Invalid weights (negative, non-finite, or all zero) are rejected.
 * Weights that do not sum to 100 are normalized proportionally.
 */
export function resolveWeights(input: ScoreWeights): { weights: ScoreWeights; normalized: boolean } {
  for (const key of WEIGHT_KEYS) {
    const value = input[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new ScoringConfigError(`Invalid scoring weight for ${key}`);
    }
  }
  const sum = WEIGHT_KEYS.reduce((total, key) => total + input[key], 0);
  if (sum === 0) {
    throw new ScoringConfigError('Scoring weights must not all be zero');
  }
  if (Math.abs(sum - 100) < 0.001) {
    return { weights: { ...input }, normalized: false };
  }
  const weights = {} as ScoreWeights;
  for (const key of WEIGHT_KEYS) {
    weights[key] = (input[key] / sum) * 100;
  }
  return { weights, normalized: true };
}

export function weightsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  weights: ScoreWeights;
  normalized: boolean;
} {
  const read = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    return Number(raw);
  };
  return resolveWeights({
    mobile: read('WEBREPORTS_WEIGHT_MOBILE', DEFAULT_WEIGHTS.mobile),
    desktop: read('WEBREPORTS_WEIGHT_DESKTOP', DEFAULT_WEIGHTS.desktop),
    seo: read('WEBREPORTS_WEIGHT_SEO', DEFAULT_WEIGHTS.seo),
    aiSearch: read('WEBREPORTS_WEIGHT_AI', DEFAULT_WEIGHTS.aiSearch),
  });
}

let cached: { weights: ScoreWeights; normalized: boolean } | null = null;

export function getScoringConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!cached) cached = weightsFromEnv(env);
  return cached;
}

/** Test helper. */
export function resetScoringConfigCache(): void {
  cached = null;
}
