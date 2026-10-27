/** Public report contract version. Bump when the JSON shape changes incompatibly. */
export const CONTRACT_VERSION = 1;

/** Scoring formula identity stored on every report. */
export const SCORING_VERSION = 'webreports-scoring-v1';

export const REPORT_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const STAGES = [
  'validating',
  'crawling',
  'analyzing_seo',
  'analyzing_ai_search',
  'testing_mobile',
  'testing_desktop',
  'scoring',
  'generating_summary',
  'saving_results',
  'completed',
] as const;
export type Stage = (typeof STAGES)[number];

export const CHECK_STATUSES = ['present', 'absent', 'unavailable', 'inconclusive'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const SEVERITIES = ['critical', 'warning', 'info', 'pass'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const IMPACTS = ['high', 'medium', 'low'] as const;
export type Impact = (typeof IMPACTS)[number];

export const EFFORTS = ['easy', 'medium', 'hard'] as const;
export type Effort = (typeof EFFORTS)[number];

export const CATEGORIES = ['seo', 'ai-search', 'performance'] as const;
export type Category = (typeof CATEGORIES)[number];

export const AI_BOTS = [
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'ClaudeBot',
  'Claude-Web',
  'PerplexityBot',
  'Google-Extended',
  'CCBot',
] as const;
export type AiBot = (typeof AI_BOTS)[number];

export type BotAccess = 'allowed' | 'blocked' | 'unspecified' | 'unavailable';
export type VitalRating = 'good' | 'needs-improvement' | 'poor' | 'unavailable';

export interface AuditCheck {
  id: string;
  category: Category;
  status: CheckStatus;
  severity: Severity;
  title: string;
  description: string;
  affectedCount: number;
  affectedUrls: string[];
  fix: string;
  impact: Impact;
  effort: Effort;
  /** Recommendations that share a key are merged. */
  dedupeKey?: string;
}

export interface HeadingOutline {
  level: number;
  text: string;
}

export interface PageSnapshot {
  url: string;
  finalUrl: string;
  statusCode: number | null;
  contentType: string | null;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  h1: string[];
  headings: HeadingOutline[];
  wordCount: number;
  internalLinks: string[];
  externalLinks: string[];
  imagesMissingAlt: number;
  imageCount: number;
  schemaTypes: string[];
  schemaErrors: string[];
  robotsMeta: string | null;
  viewport: string | null;
  hreflang: { lang: string; href: string }[];
  openGraph: { title?: string; description?: string; image?: string };
  responseMs: number | null;
  sizeBytes: number | null;
  redirectChain: string[];
  isHtml: boolean;
  timedOut: boolean;
  inconclusive: boolean;
  indexable: boolean;
  author: string | null;
  published: string | null;
  modified: string | null;
  listCount: number;
  tableCount: number;
  questionHeadingCount: number;
  rawVisibleTextLength: number;
  renderedVisibleTextLength: number | null;
  hasAboutLink: boolean;
  hasContactLink: boolean;
  consentGateLikely: boolean;
  detectedLogo?: string | null;
  detectedCompanyName?: string | null;
}

export interface CrawlSnapshot {
  startUrl: string;
  origin: string;
  pages: PageSnapshot[];
  robots: {
    status: 'ok' | 'missing' | 'unavailable';
    body: string | null;
    sitemaps: string[];
  };
  sitemap: {
    status: 'ok' | 'missing' | 'failed';
    urls: string[];
    invalid: string[];
    redirected: string[];
  };
  llmsTxt: {
    present: boolean;
    httpStatus: number | null;
    useful: boolean;
    hasHeadings: boolean;
    hasLinks: boolean;
    redirected: boolean;
  };
  botAccess: Record<AiBot, BotAccess>;
  /** Paths whose bot result differs from the homepage result. */
  botPathNotes: string[];
}

export interface PerfOpportunity {
  id: string;
  title: string;
  displayValue?: string;
}

export interface FieldMetric {
  percentile: number | null;
  category: string | null;
}

export interface DevicePerformance {
  score: number | null;
  lcp: number | null;
  inp: number | null;
  tbt: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
  bytes: number | null;
  ratings: {
    lcp: VitalRating;
    inp: VitalRating;
    cls: VitalRating;
  };
  field: {
    lcp?: FieldMetric;
    inp?: FieldMetric;
    cls?: FieldMetric;
  };
  issues: PerfOpportunity[];
  unavailableReason: string | null;
  pageUrl: string | null;
}

export interface Recommendation {
  rank: number;
  title: string;
  impact: Impact;
  effort: Effort;
  why: string;
  scope: string;
  instructions: string;
  snippet?: string;
  checkIds: string[];
}

export interface Completeness {
  complete: boolean;
  unavailableSections: string[];
}

export interface ScoreBlock {
  overall: number | null;
  mobile: number | null;
  desktop: number | null;
  seo: number | null;
  aiSearch: number | null;
}

export interface CustomerBranding {
  companyName: string | null;
  logoUrl: string | null;
  domain: string;
  source: 'auto_detected' | 'user_uploaded' | 'fallback';
}

export interface ReportContract {
  contractVersion: number;
  id: string;
  url: string;
  status: ReportStatus;
  stage: string;
  progress: number;
  scannedAt: string | null;
  createdAt: string;
  pagesCrawled: number;
  completeness: Completeness;
  scores: ScoreBlock;
  scoringVersion: string;
  summary: { headline: string | null; text: string | null };
  performance: { mobile: DevicePerformance; desktop: DevicePerformance };
  seo: { checks: AuditCheck[] };
  aiSearch: {
    botAccess: Record<string, BotAccess>;
    llmsTxt: { present: boolean; status: string };
    jsDependency: { rawVsRenderedRatio: number | null; status: CheckStatus };
    checks: AuditCheck[];
  };
  topFixes: Recommendation[];
  shareToken: string | null;
  error: { message: string } | null;
  cached?: boolean;
  customerBranding?: CustomerBranding;
}

/** Public responses are built only from these fields. */
export interface PublicReportContract {
  contractVersion: number;
  url: string;
  status: ReportStatus;
  stage: string;
  progress: number;
  scannedAt: string | null;
  pagesCrawled: number;
  completeness: Completeness;
  scores: ScoreBlock;
  scoringVersion: string;
  summary: { headline: string | null; text: string | null };
  performance: { mobile: DevicePerformance; desktop: DevicePerformance };
  seo: { checks: AuditCheck[] };
  aiSearch: ReportContract['aiSearch'];
  topFixes: Recommendation[];
  error: { message: string } | null;
  customerBranding?: CustomerBranding;
}
