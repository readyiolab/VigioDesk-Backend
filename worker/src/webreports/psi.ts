import type { DevicePerformance } from '../../../shared/webreports/types';
import { applyFieldData, type PsiPayload } from '../../../shared/webreports/psiMetrics';
import { withRatings } from '../../../shared/webreports/vitals';
import { logger } from './runtime';

export async function fetchFieldData(
  pageUrl: string,
  apiKey: string | undefined,
  timeoutMs: number
): Promise<{ mobile: PsiPayload | null; desktop: PsiPayload | null }> {
  if (!apiKey) return { mobile: null, desktop: null };
  const [mobile, desktop] = await Promise.all([
    fetchStrategy(pageUrl, 'mobile', apiKey, timeoutMs),
    fetchStrategy(pageUrl, 'desktop', apiKey, timeoutMs),
  ]);
  return { mobile, desktop };
}

async function fetchStrategy(pageUrl: string, strategy: 'mobile' | 'desktop', apiKey: string, timeoutMs: number) {
  const url = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  url.searchParams.set('url', pageUrl);
  url.searchParams.set('strategy', strategy);
  url.searchParams.set('category', 'performance');
  url.searchParams.set('key', apiKey);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      logger.warn({ status: response.status, strategy }, 'PageSpeed Insights request failed');
      return null;
    }
    return (await response.json()) as PsiPayload;
  } catch (err) {
    logger.warn({ err, strategy }, 'PageSpeed Insights request failed');
    return null;
  }
}

export function mergeField(device: DevicePerformance, payload: PsiPayload | null): DevicePerformance {
  return withRatings(applyFieldData(device, payload));
}
