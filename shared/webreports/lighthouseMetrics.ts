import type { DevicePerformance, PerfOpportunity } from './types';
import { withRatings } from './vitals';

interface LhrAudit {
  id?: string;
  title?: string;
  displayValue?: string;
  numericValue?: number;
  score?: number | null;
  details?: { type?: string; overallSavingsMs?: number };
}

export interface LighthouseResult {
  categories?: { performance?: { score?: number | null } };
  audits?: Record<string, LhrAudit>;
}

const ISSUE_AUDITS = [
  'render-blocking-resources',
  'uses-optimized-images',
  'unused-javascript',
  'unused-css-rules',
  'uses-long-cache-ttl',
  'layout-shifts',
  'tap-targets',
  'viewport',
];

/** Reads a Lighthouse LHR. Missing audits stay null. TBT is never copied into INP. */
export function metricsFromLighthouse(lhr: LighthouseResult | null, pageUrl: string): DevicePerformance {
  if (!lhr) {
    return withRatings({
      score: null,
      lcp: null,
      inp: null,
      tbt: null,
      cls: null,
      fcp: null,
      ttfb: null,
      bytes: null,
      ratings: { lcp: 'unavailable', inp: 'unavailable', cls: 'unavailable' },
      field: {},
      issues: [],
      unavailableReason: 'Lighthouse did not return a result.',
      pageUrl,
    });
  }
  const audit = (id: string) => lhr.audits?.[id];
  const numeric = (id: string) => {
    const value = audit(id)?.numericValue;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const score = lhr.categories?.performance?.score;
  const issues: PerfOpportunity[] = [];
  for (const id of ISSUE_AUDITS) {
    const item = audit(id);
    if (!item || item.score === null || item.score === undefined || item.score >= 0.9) continue;
    issues.push({
      id,
      title: item.title || id,
      displayValue: item.displayValue,
    });
  }
  return withRatings({
    score: typeof score === 'number' ? Math.round(score * 100) : null,
    lcp: numeric('largest-contentful-paint'),
    inp: null,
    tbt: numeric('total-blocking-time'),
    cls: numeric('cumulative-layout-shift'),
    fcp: numeric('first-contentful-paint'),
    ttfb: numeric('server-response-time'),
    bytes: numeric('total-byte-weight'),
    ratings: { lcp: 'unavailable', inp: 'unavailable', cls: 'unavailable' },
    field: {},
    issues: issues.slice(0, 8),
    unavailableReason: typeof score === 'number' ? null : 'Lighthouse performance score was missing.',
    pageUrl,
  });
}

export function averageDevices(devices: DevicePerformance[]): DevicePerformance {
  const usable = devices.filter((device) => device.score !== null);
  if (!usable.length) return devices[0] || metricsFromLighthouse(null, '');
  const mean = (pick: (device: DevicePerformance) => number | null) => {
    const values = usable.map(pick).filter((value): value is number => value !== null);
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  const issues = usable.flatMap((device) => device.issues).slice(0, 8);
  return withRatings({
    score: Math.round(mean((device) => device.score) || 0),
    lcp: mean((device) => device.lcp),
    inp: null,
    tbt: mean((device) => device.tbt),
    cls: mean((device) => device.cls),
    fcp: mean((device) => device.fcp),
    ttfb: mean((device) => device.ttfb),
    bytes: mean((device) => device.bytes),
    ratings: { lcp: 'unavailable', inp: 'unavailable', cls: 'unavailable' },
    field: usable.find((device) => Object.keys(device.field).length)?.field || {},
    issues,
    unavailableReason: null,
    pageUrl: usable[0].pageUrl,
  });
}
