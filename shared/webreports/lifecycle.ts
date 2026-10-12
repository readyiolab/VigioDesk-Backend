import type { ReportStatus } from './types';

const TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  queued: ['running', 'failed'],
  running: ['completed', 'failed', 'queued'],
  completed: ['queued'],
  failed: ['queued'],
};

export function canTransition(from: ReportStatus, to: ReportStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface JobGuard {
  status: ReportStatus;
  activeJobId: string | null;
  jobGeneration: number;
}

/**
 * A worker may persist only when it still owns the row and the generation matches.
 * Completed and failed rows are never overwritten by an older job.
 */
export function canPersistJob(
  row: JobGuard | null,
  job: { jobId: string; generation: number }
): boolean {
  if (!row) return false;
  if (row.jobGeneration !== job.generation) return false;
  if (row.status === 'completed' || row.status === 'failed') return false;
  if (row.status === 'running' && row.activeJobId && row.activeJobId !== job.jobId) return false;
  return row.status === 'queued' || row.status === 'running';
}

export function isTerminal(status: ReportStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/** BullMQ custom ids cannot contain a colon unless they have exactly three segments. */
export function webReportJobId(reportId: string, generation: number): string {
  return `${reportId}_${generation}`;
}
