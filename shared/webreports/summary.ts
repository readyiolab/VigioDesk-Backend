import type { ReportContract, ScoreBlock } from './types';

export interface SummaryPayload {
  url: string;
  scores: ScoreBlock;
  unavailableSections: string[];
  findings: { id: string; title: string; severity: string; affectedCount: number }[];
  mobile: { lcp: number | null; cls: number | null; tbt: number | null; inp: number | null };
  desktop: { lcp: number | null; cls: number | null; tbt: number | null; inp: number | null };
}

export function summaryPayload(report: Pick<ReportContract, 'url' | 'scores' | 'completeness' | 'seo' | 'aiSearch' | 'performance'>): SummaryPayload {
  const findings = [...report.seo.checks, ...report.aiSearch.checks]
    .filter((check) => check.status === 'present')
    .slice(0, 8)
    .map((check) => ({
      id: check.id,
      title: check.title,
      severity: check.severity,
      affectedCount: check.affectedCount,
    }));
  return {
    url: report.url,
    scores: report.scores,
    unavailableSections: report.completeness.unavailableSections,
    findings,
    mobile: {
      lcp: report.performance.mobile.lcp,
      cls: report.performance.mobile.cls,
      tbt: report.performance.mobile.tbt,
      inp: report.performance.mobile.inp,
    },
    desktop: {
      lcp: report.performance.desktop.lcp,
      cls: report.performance.desktop.cls,
      tbt: report.performance.desktop.tbt,
      inp: report.performance.desktop.inp,
    },
  };
}

export function templateSummary(payload: SummaryPayload): { headline: string; text: string } {
  const overall = payload.scores.overall;
  const headline =
    overall === null
      ? 'The scan finished with incomplete measurements'
      : overall >= 80
        ? 'The site is in good shape with a few follow-ups'
        : overall >= 50
          ? 'The site needs focused fixes before it performs well'
          : 'The site has serious gaps in speed or discoverability';
  const scoreText =
    overall === null ? 'An overall score was not calculated because measured sections were unavailable.' : `Overall score ${overall}.`;
  const parts = [
    `Mobile ${label(payload.scores.mobile)}`,
    `desktop ${label(payload.scores.desktop)}`,
    `SEO ${label(payload.scores.seo)}`,
    `AI search ${label(payload.scores.aiSearch)}`,
  ];
  const top = payload.findings[0];
  const finding = top ? ` The highest-priority finding is “${top.title}”.` : '';
  const unavailable = payload.unavailableSections.length
    ? ` Unavailable sections: ${payload.unavailableSections.join(', ')}.`
    : '';
  return {
    headline,
    text: `Scanned ${payload.url}. ${scoreText} ${parts.join(', ')}.${finding}${unavailable}`.replace(/\s+/g, ' ').trim(),
  };
}

function label(score: number | null): string {
  return score === null ? 'unavailable' : String(score);
}

const NUMBER_PATTERN = /\d{2,}/g;

/** Reject summaries that introduce measurements absent from the payload. */
export function summaryMatchesEvidence(text: string, payload: SummaryPayload): boolean {
  const allowed = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) allowed.add(String(Math.round(value)));
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(payload);
  const numbers = text.match(NUMBER_PATTERN) || [];
  return numbers.every((number) => allowed.has(number));
}
