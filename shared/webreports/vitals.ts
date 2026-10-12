import type { DevicePerformance, VitalRating } from './types';

export function rateLcp(ms: number | null): VitalRating {
  if (ms === null || !Number.isFinite(ms)) return 'unavailable';
  if (ms <= 2500) return 'good';
  if (ms <= 4000) return 'needs-improvement';
  return 'poor';
}

export function rateInp(ms: number | null): VitalRating {
  if (ms === null || !Number.isFinite(ms)) return 'unavailable';
  if (ms <= 200) return 'good';
  if (ms <= 500) return 'needs-improvement';
  return 'poor';
}

export function rateCls(value: number | null): VitalRating {
  if (value === null || !Number.isFinite(value)) return 'unavailable';
  if (value <= 0.1) return 'good';
  if (value <= 0.25) return 'needs-improvement';
  return 'poor';
}

export function emptyDevice(reason: string | null = null): DevicePerformance {
  return {
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
    unavailableReason: reason,
    pageUrl: null,
  };
}

export function withRatings(device: DevicePerformance): DevicePerformance {
  return {
    ...device,
    ratings: {
      lcp: rateLcp(device.lcp),
      inp: rateInp(device.inp),
      cls: rateCls(device.cls),
    },
  };
}
