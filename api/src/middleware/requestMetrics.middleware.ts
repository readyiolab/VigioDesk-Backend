import type { Request, Response, NextFunction } from 'express';
import {
  metricsDecInFlight,
  metricsIncInFlight,
  metricsRecordHttp,
} from '../lib/metrics';

/** Tracks in-flight requests and records duration/status for /api/health/metrics. */
export function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip noise endpoints from in-flight / avg (still counted lightly via status)
  const skip =
    req.path === '/health' ||
    req.path === '/api/health' ||
    req.path === '/health/live' ||
    req.path === '/api/health/live' ||
    req.path === '/health/ready' ||
    req.path === '/api/health/ready' ||
    req.path === '/api/health/metrics' ||
    req.path === '/health/metrics';

  if (!skip) metricsIncInFlight();
  const start = Date.now();

  res.on('finish', () => {
    if (!skip) metricsDecInFlight();
    metricsRecordHttp(res.statusCode, Date.now() - start);
    // Enrich pino-http log context when available
    const anyRes = res as Response & { err?: unknown };
    void anyRes;
    (req as Request & { log?: { info: (o: object, m: string) => void } }).log?.info?.(
      {
        route: req.route?.path || req.path,
        method: req.method,
        status: res.statusCode,
        durationMs: Date.now() - start,
      },
      'request.complete'
    );
  });

  next();
}
