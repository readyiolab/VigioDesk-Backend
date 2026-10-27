import { CONTRACT_VERSION } from './types';
import type {
  AuditCheck,
  BotAccess,
  DevicePerformance,
  PublicReportContract,
  Recommendation,
  ReportContract,
  ReportStatus,
} from './types';
import { emptyDevice, withRatings } from './vitals';

export interface ReportRow {
  id: string;
  url: string;
  status: ReportStatus;
  stage: string | null;
  progress: number;
  createdAt: Date | string;
  completedAt: Date | string | null;
  pagesCrawled: number;
  overallScore: number | null;
  mobileScore: number | null;
  desktopScore: number | null;
  seoScore: number | null;
  aiScore: number | null;
  summaryHeadline: string | null;
  summaryText: string | null;
  shareToken: string | null;
  errorMessage: string | null;
  completenessJson: string | null;
  topFixesJson: string | null;
  scoringVersion: string;
  contractVersion: number;
  detailJson: string | null;
  customerLogoUrl?: string | null;
  customerCompanyName?: string | null;
  customerBrandingJson?: string | null;
}

export interface ReportDetail {
  botAccess?: Record<string, BotAccess>;
  llmsTxt?: { present: boolean; status: string };
  jsRatio?: number | null;
}

export interface StoredPerf {
  device: 'mobile' | 'desktop';
  pageUrl: string | null;
  score: number | null;
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  tbtMs: number | null;
  bytes: number | null;
  opportunitiesJson: string | null;
  fieldDataJson: string | null;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function deviceFrom(row: StoredPerf | undefined, fallbackReason: string | null): DevicePerformance {
  if (!row) return emptyDevice(fallbackReason);
  const field = parseJson<DevicePerformance['field']>(row.fieldDataJson, {});
  const issues = parseJson<DevicePerformance['issues']>(row.opportunitiesJson, []);
  const device: DevicePerformance = {
    score: row.score,
    lcp: row.lcpMs,
    inp: row.inpMs,
    tbt: row.tbtMs,
    cls: row.cls,
    fcp: row.fcpMs,
    ttfb: row.ttfbMs,
    bytes: row.bytes,
    ratings: { lcp: 'unavailable', inp: 'unavailable', cls: 'unavailable' },
    field,
    issues,
    unavailableReason: row.score === null ? 'Performance data was not collected for this device.' : null,
    pageUrl: row.pageUrl,
  };
  return withRatings(device);
}

export function toReportContract(input: {
  row: ReportRow;
  checks: AuditCheck[];
  perf: StoredPerf[];
}): ReportContract {
  const seo = input.checks.filter((check) => check.category === 'seo');
  const ai = input.checks.filter((check) => check.category === 'ai-search');
  const detail = parseJson<ReportDetail>(input.row.detailJson, {});
  const js = input.checks.find((check) => check.id === 'js-render-dependency');
  const mobile = input.perf.find((row) => row.device === 'mobile');
  const desktop = input.perf.find((row) => row.device === 'desktop');
  const pending = input.row.status === 'queued' || input.row.status === 'running';
  return {
    contractVersion: input.row.contractVersion || CONTRACT_VERSION,
    id: input.row.id,
    url: input.row.url,
    status: input.row.status,
    stage: input.row.stage || (pending ? 'validating' : 'completed'),
    progress: input.row.progress || 0,
    scannedAt: iso(input.row.completedAt),
    createdAt: iso(input.row.createdAt) || new Date(0).toISOString(),
    pagesCrawled: input.row.pagesCrawled || 0,
    completeness: parseJson(input.row.completenessJson, {
      complete: false,
      unavailableSections: pending ? ['pending'] : [],
    }),
    scores: {
      overall: input.row.overallScore,
      mobile: input.row.mobileScore,
      desktop: input.row.desktopScore,
      seo: input.row.seoScore,
      aiSearch: input.row.aiScore,
    },
    scoringVersion: input.row.scoringVersion,
    summary: {
      headline: input.row.summaryHeadline,
      text: input.row.summaryText,
    },
    performance: {
      mobile: deviceFrom(mobile, pending ? null : 'Mobile lab data is unavailable.'),
      desktop: deviceFrom(desktop, pending ? null : 'Desktop lab data is unavailable.'),
    },
    seo: { checks: seo },
    aiSearch: {
      botAccess: detail.botAccess || {},
      llmsTxt: detail.llmsTxt || { present: false, status: 'unavailable' },
      jsDependency: {
        rawVsRenderedRatio: detail.jsRatio ?? null,
        status: js?.status || 'unavailable',
      },
      checks: ai,
    },
    topFixes: parseJson<Recommendation[]>(input.row.topFixesJson, []),
    shareToken: input.row.shareToken,
    error:
      input.row.status === 'failed'
        ? { message: input.row.errorMessage || 'The scan could not be completed.' }
        : null,
    customerBranding: resolveBranding(input.row),
  };
}

function resolveBranding(row: ReportRow) {
  if (row.customerBrandingJson) {
    const parsed = parseJson(row.customerBrandingJson, null);
    if (parsed) return parsed;
  }
  let domain = 'client-website.com';
  try {
    domain = new URL(row.url).hostname.replace(/^www\./i, '');
  } catch {}

  const companyName =
    row.customerCompanyName ||
    (row.summaryHeadline && row.summaryHeadline.length < 35 && !/ready|audit|scan/i.test(row.summaryHeadline)
      ? row.summaryHeadline
      : domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1));

  return {
    companyName,
    logoUrl: row.customerLogoUrl || `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    domain,
    source: (row.customerLogoUrl ? 'user_uploaded' : 'fallback') as const,
  };
}

const PUBLIC_ERROR = 'This shared scan did not complete.';

export function toPublicReport(report: ReportContract): PublicReportContract {
  return {
    contractVersion: report.contractVersion,
    url: report.url,
    status: report.status,
    stage: report.stage,
    progress: report.progress,
    scannedAt: report.scannedAt,
    pagesCrawled: report.pagesCrawled,
    completeness: report.completeness,
    scores: report.scores,
    scoringVersion: report.scoringVersion,
    summary: report.summary,
    performance: report.performance,
    seo: report.seo,
    aiSearch: report.aiSearch,
    topFixes: report.topFixes,
    error: report.status === 'failed' ? { message: PUBLIC_ERROR } : null,
    customerBranding: report.customerBranding,
  };
}
