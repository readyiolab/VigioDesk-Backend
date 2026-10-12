import type { AuditCheck, Category, CheckStatus, Effort, Impact, Severity } from './types';

const URL_CAP = 20;

export function makeCheck(input: {
  id: string;
  category: Category;
  status: CheckStatus;
  severity: Severity;
  title: string;
  description: string;
  affectedUrls?: string[];
  affectedCount?: number;
  fix: string;
  impact: Impact;
  effort: Effort;
  dedupeKey?: string;
}): AuditCheck {
  const urls = Array.from(new Set(input.affectedUrls || [])).slice(0, URL_CAP);
  return {
    id: input.id,
    category: input.category,
    status: input.status,
    severity: input.status === 'absent' ? 'pass' : input.severity,
    title: input.title,
    description: input.description,
    affectedCount: input.affectedCount ?? urls.length,
    affectedUrls: urls,
    fix: input.fix,
    impact: input.impact,
    effort: input.effort,
    dedupeKey: input.dedupeKey,
  };
}

export function pass(partial: Omit<Parameters<typeof makeCheck>[0], 'status' | 'severity'>): AuditCheck {
  return makeCheck({ ...partial, status: 'absent', severity: 'pass' });
}

export function present(
  partial: Omit<Parameters<typeof makeCheck>[0], 'status'> & { severity: Severity }
): AuditCheck {
  return makeCheck({ ...partial, status: 'present' });
}
