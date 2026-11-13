/**
 * Lightweight in-process metrics for /api/health/metrics.
 * Process-local counters are enough for PM2 multi-instance (each reports its own).
 */

type Counters = {
  httpRequestsTotal: number;
  httpErrorsTotal: number;
  httpDurationMsSum: number;
  slowQueriesTotal: number;
  dbAcquireWaitMsSum: number;
  dbAcquireCount: number;
};

const counters: Counters = {
  httpRequestsTotal: 0,
  httpErrorsTotal: 0,
  httpDurationMsSum: 0,
  slowQueriesTotal: 0,
  dbAcquireWaitMsSum: 0,
  dbAcquireCount: 0,
};

let inFlight = 0;
const startedAt = Date.now();

export function metricsIncInFlight(): void {
  inFlight += 1;
}

export function metricsDecInFlight(): void {
  inFlight = Math.max(0, inFlight - 1);
}

export function metricsRecordHttp(status: number, durationMs: number): void {
  counters.httpRequestsTotal += 1;
  counters.httpDurationMsSum += durationMs;
  if (status >= 500) counters.httpErrorsTotal += 1;
}

export function metricsRecordSlowQuery(): void {
  counters.slowQueriesTotal += 1;
}

export function metricsRecordDbAcquire(waitMs: number): void {
  counters.dbAcquireCount += 1;
  counters.dbAcquireWaitMsSum += waitMs;
}

export function getInFlight(): number {
  return inFlight;
}

export function getMetricsSnapshot(): Record<string, number | string> {
  const avgHttp =
    counters.httpRequestsTotal > 0
      ? Math.round(counters.httpDurationMsSum / counters.httpRequestsTotal)
      : 0;
  const avgDbWait =
    counters.dbAcquireCount > 0
      ? Math.round(counters.dbAcquireWaitMsSum / counters.dbAcquireCount)
      : 0;

  return {
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    http_in_flight: inFlight,
    http_requests_total: counters.httpRequestsTotal,
    http_errors_total: counters.httpErrorsTotal,
    http_duration_ms_avg: avgHttp,
    db_slow_queries_total: counters.slowQueriesTotal,
    db_acquire_wait_ms_avg: avgDbWait,
    db_acquire_count: counters.dbAcquireCount,
  };
}

/** Prometheus text exposition (subset). */
export function renderPrometheus(extra: Record<string, number | string> = {}): string {
  const snap = { ...getMetricsSnapshot(), ...extra };
  const lines: string[] = [
    '# HELP app_uptime_seconds Process uptime in seconds',
    '# TYPE app_uptime_seconds gauge',
    `app_uptime_seconds ${snap.uptime_seconds}`,
    '# HELP http_in_flight Current in-flight HTTP requests',
    '# TYPE http_in_flight gauge',
    `http_in_flight ${snap.http_in_flight}`,
    '# HELP http_requests_total Total HTTP requests handled',
    '# TYPE http_requests_total counter',
    `http_requests_total ${snap.http_requests_total}`,
    '# HELP http_errors_total Total HTTP 5xx responses',
    '# TYPE http_errors_total counter',
    `http_errors_total ${snap.http_errors_total}`,
    '# HELP http_duration_ms_avg Average HTTP duration ms since boot',
    '# TYPE http_duration_ms_avg gauge',
    `http_duration_ms_avg ${snap.http_duration_ms_avg}`,
    '# HELP db_slow_queries_total Queries slower than threshold',
    '# TYPE db_slow_queries_total counter',
    `db_slow_queries_total ${snap.db_slow_queries_total}`,
    '# HELP db_acquire_wait_ms_avg Average pool acquire wait ms',
    '# TYPE db_acquire_wait_ms_avg gauge',
    `db_acquire_wait_ms_avg ${snap.db_acquire_wait_ms_avg}`,
  ];

  for (const [key, value] of Object.entries(extra)) {
    if (key in snap && key.startsWith('queue_')) {
      lines.push(`# TYPE ${key} gauge`);
      lines.push(`${key} ${value}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
