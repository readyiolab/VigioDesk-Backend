import { nodeDnsResolve } from '../../../../shared/webreports/urlSafety';
import { env } from '../../config/env';
import { enqueueWebReport, removeQueuedWebReport } from '../../lib/webreportsQueue';
import { createWebReportsService } from './webreports.logic';
import { mysqlWebReportRepository } from './webreports.repo';

export const webreportsService = createWebReportsService({
  repo: mysqlWebReportRepository,
  resolve: nodeDnsResolve,
  enqueue: enqueueWebReport,
  removeQueued: removeQueuedWebReport,
  now: () => new Date(),
  globalMaxPages: env.WEBREPORTS_MAX_PAGES,
  cacheTtlMs: env.WEBREPORTS_CACHE_TTL_MINUTES * 60 * 1000,
});
