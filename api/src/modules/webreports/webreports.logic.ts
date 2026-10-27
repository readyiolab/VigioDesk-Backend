import crypto from 'crypto';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { assertSafeTarget, UrlSafetyError, type DnsResolver } from '../../../../shared/webreports/urlSafety';
import { CONTRACT_VERSION, SCORING_VERSION } from '../../../../shared/webreports/types';
import { toPublicReport, toReportContract, type ReportRow } from '../../../../shared/webreports/contract';
import type { ReportContract } from '../../../../shared/webreports/types';
import { AppError } from '../../middleware/errorHandler.middleware';
import {
  mysqlWebReportRepository,
  newShareToken,
  type StoredReport,
  type WebReportRepository,
} from './webreports.repo';

export interface CreateInput {
  url: string;
  maxPages?: number;
  force?: boolean;
}

export interface ServiceDeps {
  repo: WebReportRepository;
  resolve: DnsResolver;
  enqueue: (job: { reportId: string; userId: string; generation: number }) => Promise<void>;
  removeQueued: (reportId: string, generation: number) => Promise<void>;
  now: () => Date;
  globalMaxPages: number;
  cacheTtlMs: number;
}

function urlHash(normalizedUrl: string): string {
  return crypto.createHash('sha256').update(normalizedUrl).digest('hex');
}

function clientError(err: unknown): AppError {
  if (err instanceof UrlSafetyError) return new AppError(err.clientMessage, 400);
  if (err instanceof AppError) return err;
  throw err;
}

function toRow(report: StoredReport): ReportRow {
  return {
    id: report.id,
    url: report.url,
    status: report.status,
    stage: report.stage,
    progress: report.progress,
    createdAt: report.createdAt,
    completedAt: report.completedAt,
    pagesCrawled: report.pagesCrawled,
    overallScore: report.overallScore,
    mobileScore: report.mobileScore,
    desktopScore: report.desktopScore,
    seoScore: report.seoScore,
    aiScore: report.aiScore,
    summaryHeadline: report.summaryHeadline,
    summaryText: report.summaryText,
    shareToken: report.shareToken,
    errorMessage: report.errorMessage,
    completenessJson: report.completenessJson,
    topFixesJson: report.topFixesJson,
    scoringVersion: report.scoringVersion,
    contractVersion: report.contractVersion,
    detailJson: report.detailJson,
  };
}

async function present(repo: WebReportRepository, report: StoredReport): Promise<ReportContract> {
  const children = report.status === 'queued' || report.status === 'running'
    ? { checks: [], perf: [] }
    : await repo.loadChildren(report.id);
  return toReportContract({ row: toRow(report), checks: children.checks, perf: children.perf });
}

export function createWebReportsService(deps: ServiceDeps) {
  async function schedule(report: StoredReport): Promise<void> {
    try {
      await deps.enqueue({
        reportId: report.id,
        userId: report.userId,
        generation: report.jobGeneration,
      });
      await deps.repo.markEnqueued(report.id, deps.now());
    } catch {
      await deps.repo.markFailed(report.id, 'The scan could not be queued. Please try again.');
      await deps.repo.refundQuota(report.userId);
      throw new AppError('The scan could not be queued. Please try again.', 503);
    }
  }

  return {
    async create(userId: string, plan: 'FREE' | 'PRO' | 'ENTERPRISE', input: CreateInput) {
      const rawUrl = (input.url || '').trim();
      const targetUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
      let canonical;
      try {
        canonical = await assertSafeTarget(targetUrl, deps.resolve);
      } catch (err) {
        throw clientError(err);
      }
      const limits = PLAN_LIMITS[plan];
      const maxPages = Math.min(
        input.maxPages ?? limits.maxWebReportPages,
        limits.maxWebReportPages,
        deps.globalMaxPages
      );
      const hash = urlHash(canonical.url);
      if (!input.force) {
        const since = new Date(deps.now().getTime() - deps.cacheTtlMs);
        const cached = await deps.repo.findCached(userId, hash, since);
        if (cached) {
          const report = await present(deps.repo, cached);
          return { statusCode: 200 as const, cached: true, report: { ...report, cached: true } };
        }
      }
      const id = crypto.randomUUID();
      const now = deps.now();
      const draft: StoredReport = {
        id,
        userId,
        url: canonical.url,
        normalizedHost: canonical.hostname,
        normalizedUrl: canonical.url,
        urlHash: hash,
        status: 'queued',
        stage: 'validating',
        progress: 0,
        overallScore: null,
        mobileScore: null,
        desktopScore: null,
        seoScore: null,
        aiScore: null,
        summaryHeadline: null,
        summaryText: null,
        shareToken: null,
        errorMessage: null,
        pagesCrawled: 0,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        jobGeneration: 1,
        activeJobId: null,
        enqueuedAt: null,
        completenessJson: null,
        topFixesJson: null,
        detailJson: null,
        checkpointJson: null,
        scoringVersion: SCORING_VERSION,
        contractVersion: CONTRACT_VERSION,
        maxPages,
        customerLogoUrl: null,
        customerCompanyName: null,
        customerBrandingJson: null,
      };
      const windowCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const inserted = await deps.repo.insertReserved({
        userId,
        dailyLimit: limits.maxDailyWebReports,
        concurrentLimit: limits.maxConcurrentWebReports,
        windowCutoff,
        now,
        row: draft,
      });
      if (inserted === 'quota') {
        throw new AppError(
          `Daily website audit limit of ${limits.maxDailyWebReports} reached for your ${plan} plan.`,
          403
        );
      }
      if (inserted === 'concurrent') {
        throw new AppError('You already have the maximum number of scans running.', 429);
      }
      await schedule(inserted);
      const report = await present(deps.repo, inserted);
      return { statusCode: 202 as const, cached: false, report };
    },

    async list(userId: string, limit: number, offset: number) {
      const page = await deps.repo.list(userId, limit, offset);
      const idsToLoad = page.rows
        .filter((r) => r.status !== 'queued' && r.status !== 'running')
        .map((r) => r.id);
      const batchMap = idsToLoad.length > 0 ? await deps.repo.loadChildrenBatch(idsToLoad) : new Map();
      const reports = page.rows.map((row) => {
        const children = batchMap.get(row.id) ?? { checks: [], perf: [] };
        return toReportContract({ row: toRow(row), checks: children.checks, perf: children.perf });
      });
      return { reports, pagination: { limit, offset, total: page.total } };
    },

    async get(userId: string, id: string) {
      const row = await deps.repo.getById(id);
      if (!row || row.userId !== userId) throw new AppError('Report not found', 404);
      return present(deps.repo, row);
    },

    async rescan(userId: string, plan: 'FREE' | 'PRO' | 'ENTERPRISE', id: string, maxPages?: number) {
      const limits = PLAN_LIMITS[plan];
      const pages = Math.min(maxPages ?? limits.maxWebReportPages, limits.maxWebReportPages, deps.globalMaxPages);
      const now = deps.now();
      const result = await deps.repo.beginRescan(
        id,
        userId,
        pages,
        limits.maxDailyWebReports,
        new Date(now.getTime() - 24 * 60 * 60 * 1000),
        now
      );
      if (result === 'missing') throw new AppError('Report not found', 404);
      if (result === 'running') throw new AppError('This scan is already running.', 409);
      if (result === 'quota') {
        throw new AppError(
          `Daily website audit limit of ${limits.maxDailyWebReports} reached for your ${plan} plan.`,
          403
        );
      }
      if (result.action === 'restarted') await schedule(result.report);
      return { statusCode: 202 as const, report: await present(deps.repo, result.report) };
    },

    async share(userId: string, id: string) {
      const existing = await deps.repo.getById(id);
      if (!existing || existing.userId !== userId) throw new AppError('Report not found', 404);
      const token = existing.shareToken || newShareToken();
      const updated = await deps.repo.setShareToken(id, userId, token);
      if (!updated) throw new AppError('Report not found', 404);
      return { shareToken: token, sharePath: `/webreports/shared/${token}` };
    },

    async revoke(userId: string, id: string) {
      const existing = await deps.repo.getById(id);
      if (!existing || existing.userId !== userId) throw new AppError('Report not found', 404);
      await deps.repo.setShareToken(id, userId, null);
      return { ok: true };
    },

    async updateBranding(
      userId: string,
      id: string,
      input: { companyName?: string | null; logoUrl?: string | null }
    ) {
      const existing = await deps.repo.getById(id);
      if (!existing || existing.userId !== userId) throw new AppError('Report not found', 404);
      const updated = await deps.repo.updateBranding(id, userId, {
        customerCompanyName: input.companyName !== undefined ? input.companyName : existing.customerCompanyName,
        customerLogoUrl: input.logoUrl !== undefined ? input.logoUrl : existing.customerLogoUrl,
      });
      if (!updated) throw new AppError('Report not found', 404);
      return { report: await present(deps.repo, updated) };
    },

    async remove(userId: string, id: string) {
      const existing = await deps.repo.deleteOwned(id, userId);
      if (!existing) throw new AppError('Report not found', 404);
      if (existing.status === 'queued' || existing.status === 'running') {
        await deps.removeQueued(existing.id, existing.jobGeneration).catch(() => undefined);
      }
      return { ok: true };
    },

    async getPublic(token: string) {
      const row = await deps.repo.getByShareToken(token);
      if (!row) throw new AppError('Shared report not found', 404);
      const report = await present(deps.repo, row);
      return toPublicReport(report);
    },
  };
}

export function hashNormalizedUrl(normalizedUrl: string): string {
  return urlHash(normalizedUrl);
}

export const webreportsRepository = mysqlWebReportRepository;
