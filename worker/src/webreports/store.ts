import crypto from 'crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { AuditCheck, CrawlSnapshot, PageSnapshot } from '../../../shared/webreports/types';
import type { DevicePerformance } from '../../../shared/webreports/types';
import { canPersistJob } from '../../../shared/webreports/lifecycle';
import { execute, pool, queryAll } from './runtime';

export interface ReportJobRow {
  id: string;
  userId: string;
  url: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  stage: string | null;
  progress: number;
  jobGeneration: number;
  activeJobId: string | null;
  maxPages: number;
  checkpointJson: string | null;
  startedAt: Date | string | null;
  createdAt: Date | string;
}

export async function loadReport(id: string): Promise<ReportJobRow | null> {
  const rows = await queryAll<ReportJobRow>(
    `SELECT id, userId, url, status, stage, progress, jobGeneration, activeJobId, maxPages, checkpointJson, startedAt, createdAt
       FROM tbl_webreport WHERE id = ?`,
    [id]
  );
  return rows[0] || null;
}

export async function claimReport(row: ReportJobRow, jobId: string): Promise<boolean> {
  if (!canPersistJob(row, { jobId, generation: row.jobGeneration })) return false;
  const result = await execute(
    `UPDATE tbl_webreport
        SET status = 'running', activeJobId = ?, startedAt = COALESCE(startedAt, CURRENT_TIMESTAMP(3))
      WHERE id = ? AND jobGeneration = ? AND status IN ('queued', 'running')
        AND (activeJobId IS NULL OR activeJobId = ?)`,
    [jobId, row.id, row.jobGeneration, jobId]
  );
  return result.affectedRows > 0;
}

export async function updateStage(reportId: string, jobId: string, generation: number, stage: string, progress: number, checkpoint?: unknown): Promise<boolean> {
  const result = await execute(
    `UPDATE tbl_webreport
        SET stage = ?, progress = GREATEST(progress, ?), checkpointJson = COALESCE(?, checkpointJson)
      WHERE id = ? AND activeJobId = ? AND jobGeneration = ? AND status = 'running'`,
    [stage, Math.min(progress, 99), checkpoint ? JSON.stringify(checkpoint) : null, reportId, jobId, generation]
  );
  return result.affectedRows > 0;
}

export async function markFailed(reportId: string, jobId: string, generation: number, message: string): Promise<void> {
  await execute(
    `UPDATE tbl_webreport
        SET status = 'failed', errorMessage = ?, completedAt = CURRENT_TIMESTAMP(3)
      WHERE id = ? AND jobGeneration = ? AND status IN ('queued', 'running')
        AND (activeJobId IS NULL OR activeJobId = ?)`,
    [message.slice(0, 500), reportId, generation, jobId]
  );
}

export async function saveCompleted(input: {
  reportId: string;
  jobId: string;
  generation: number;
  pages: PageSnapshot[];
  checks: AuditCheck[];
  mobile: DevicePerformance;
  desktop: DevicePerformance;
  scores: { overall: number | null; mobile: number | null; desktop: number | null; seo: number | null; aiSearch: number | null };
  completeness: unknown;
  topFixes: unknown;
  detail: unknown;
  summaryHeadline: string;
  summaryText: string;
  scoringVersion: string;
  customerLogoUrl?: string | null;
  customerCompanyName?: string | null;
  customerBrandingJson?: string | null;
}): Promise<boolean> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT status, activeJobId, jobGeneration FROM tbl_webreport WHERE id = ? FOR UPDATE`,
      [input.reportId]
    );
    const row = rows[0];
    if (!row || row.status !== 'running' || row.activeJobId !== input.jobId || Number(row.jobGeneration) !== input.generation) {
      await conn.rollback();
      return false;
    }
    await conn.query(`DELETE FROM tbl_webreport_page WHERE reportId = ?`, [input.reportId]);
    await conn.query(`DELETE FROM tbl_webreport_check WHERE reportId = ?`, [input.reportId]);
    await conn.query(`DELETE FROM tbl_webreport_perf WHERE reportId = ?`, [input.reportId]);
    await insertPagesBatch(conn, input.reportId, input.pages);
    await insertChecksBatch(conn, input.reportId, input.checks);
    await insertPerf(conn, input.reportId, 'mobile', input.mobile);
    await insertPerf(conn, input.reportId, 'desktop', input.desktop);
    await conn.query(
      `UPDATE tbl_webreport
          SET status = 'completed', stage = 'completed', progress = 100,
              overallScore = ?, mobileScore = ?, desktopScore = ?, seoScore = ?, aiScore = ?,
              summaryHeadline = ?, summaryText = ?, pagesCrawled = ?,
              completenessJson = ?, topFixesJson = ?, detailJson = ?, scoringVersion = ?,
              customerLogoUrl = COALESCE(?, customerLogoUrl),
              customerCompanyName = COALESCE(?, customerCompanyName),
              customerBrandingJson = COALESCE(?, customerBrandingJson),
              completedAt = CURRENT_TIMESTAMP(3), errorMessage = NULL
        WHERE id = ? AND activeJobId = ?`,
      [
        input.scores.overall,
        input.scores.mobile,
        input.scores.desktop,
        input.scores.seo,
        input.scores.aiSearch,
        input.summaryHeadline.slice(0, 240),
        input.summaryText.slice(0, 2000),
        input.pages.length,
        JSON.stringify(input.completeness),
        JSON.stringify(input.topFixes),
        JSON.stringify(input.detail),
        input.scoringVersion,
        input.customerLogoUrl || null,
        input.customerCompanyName || null,
        input.customerBrandingJson || null,
        input.reportId,
        input.jobId,
      ]
    );
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function insertPagesBatch(conn: PoolConnection, reportId: string, pages: PageSnapshot[]) {
  if (!pages.length) return;
  const values = pages.map((page) => {
    const diagnostics = {
      headings: page.headings.slice(0, 40),
      h1: page.h1.slice(0, 10),
      internalLinkCount: page.internalLinks.length,
      externalLinkCount: page.externalLinks.length,
      imageCount: page.imageCount,
      imagesMissingAlt: page.imagesMissingAlt,
      robotsMeta: page.robotsMeta,
      viewport: page.viewport,
      hreflang: page.hreflang.slice(0, 20),
      openGraph: page.openGraph,
      redirectChain: page.redirectChain.slice(0, 8),
      indexable: page.indexable,
      author: page.author,
      published: page.published,
      modified: page.modified,
      listCount: page.listCount,
      tableCount: page.tableCount,
      rawVisibleTextLength: page.rawVisibleTextLength,
      renderedVisibleTextLength: page.renderedVisibleTextLength,
      finalUrl: page.finalUrl,
      schemaErrors: page.schemaErrors.slice(0, 5),
      timedOut: page.timedOut,
      inconclusive: page.inconclusive,
    };
    return [
      crypto.randomUUID(),
      reportId,
      page.finalUrl.slice(0, 2048),
      page.statusCode,
      page.title?.slice(0, 500) || null,
      page.metaDescription?.slice(0, 500) || null,
      page.canonical?.slice(0, 2048) || null,
      page.h1.length,
      page.wordCount,
      page.responseMs,
      page.sizeBytes,
      JSON.stringify(page.schemaTypes.slice(0, 30)),
      JSON.stringify(page.schemaErrors.slice(0, 5)),
      JSON.stringify(diagnostics),
    ];
  });
  await conn.query(
    `INSERT INTO tbl_webreport_page
      (id, reportId, url, statusCode, title, metaDescription, canonical, h1Count, wordCount, responseMs, sizeBytes, schemaTypes, issues, diagnostics)
     VALUES ?`,
    [values]
  );
}

async function insertChecksBatch(conn: PoolConnection, reportId: string, checks: AuditCheck[]) {
  if (!checks.length) return;
  const values = checks.map((check) => [
    crypto.randomUUID(),
    reportId,
    check.category,
    check.id,
    check.status,
    check.severity,
    check.title.slice(0, 240),
    check.description.slice(0, 2000),
    check.affectedCount,
    JSON.stringify(check.affectedUrls.slice(0, 20)),
    check.fix.slice(0, 4000),
    check.impact,
    check.effort,
  ]);
  await conn.query(
    `INSERT INTO tbl_webreport_check
      (id, reportId, category, checkId, status, severity, title, description, affectedCount, affectedUrls, fix, impact, effort)
     VALUES ?`,
    [values]
  );
}

async function insertPerf(conn: PoolConnection, reportId: string, device: 'mobile' | 'desktop', perf: DevicePerformance) {
  await conn.query(
    `INSERT INTO tbl_webreport_perf
      (id, reportId, device, pageUrl, score, lcpMs, inpMs, cls, fcpMs, ttfbMs, tbtMs, bytes, opportunities, fieldData)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      reportId,
      device,
      perf.pageUrl?.slice(0, 2048) || null,
      perf.score,
      perf.lcp === null ? null : Math.round(perf.lcp),
      perf.inp === null ? null : Math.round(perf.inp),
      perf.cls,
      perf.fcp === null ? null : Math.round(perf.fcp),
      perf.ttfb === null ? null : Math.round(perf.ttfb),
      perf.tbt === null ? null : Math.round(perf.tbt),
      perf.bytes === null ? null : Math.round(perf.bytes),
      JSON.stringify(perf.issues.slice(0, 8)),
      JSON.stringify(perf.field || {}),
    ]
  );
}

export type Checkpoint = {
  crawl?: CrawlSnapshot;
  mobile?: DevicePerformance;
  desktop?: DevicePerformance;
};

export function readCheckpoint(raw: string | null): Checkpoint {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return {};
  }
}
