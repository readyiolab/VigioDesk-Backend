import type { DevicePerformance, FieldMetric } from './types';

interface PsiMetric {
  percentile?: number;
  category?: string;
}

export interface PsiPayload {
  loadingExperience?: { metrics?: Record<string, PsiMetric> };
  originLoadingExperience?: { metrics?: Record<string, PsiMetric> };
}

function field(metric: PsiMetric | undefined): FieldMetric | undefined {
  if (!metric) return undefined;
  return {
    percentile: typeof metric.percentile === 'number' ? metric.percentile : null,
    category: metric.category || null,
  };
}

/** Field data only. Lab metrics are left untouched. Missing CrUX stays absent. */
export function applyFieldData(device: DevicePerformance, payload: PsiPayload | null): DevicePerformance {
  if (!payload) return device;
  const metrics = payload.loadingExperience?.metrics || payload.originLoadingExperience?.metrics;
  if (!metrics) return device;
  const lcp = field(metrics.LARGEST_CONTENTFUL_PAINT_MS);
  const inp = field(metrics.INTERACTION_TO_NEXT_PAINT);
  const clsMetric = metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE;
  const cls = clsMetric
    ? {
        percentile: typeof clsMetric.percentile === 'number' ? clsMetric.percentile / 100 : null,
        category: clsMetric.category || null,
      }
    : undefined;
  return {
    ...device,
    inp: inp?.percentile ?? device.inp,
    field: {
      ...(lcp ? { lcp } : {}),
      ...(inp ? { inp } : {}),
      ...(cls ? { cls } : {}),
    },
  };
}
