import crypto from 'crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { db } from '../../lib/mysql';
import type { AuditCheck } from '../../../../shared/webreports/types';
import type { StoredPerf } from '../../../../shared/webreports/contract';
import type { ReportStatus } from '../../../../shared/webreports/types';

export interface StoredReport {
  id: string;
  userId: string;
  url: string;
  normalizedHost: string;
  normalizedUrl: string;
  urlHash: string;
  status: ReportStatus;
  stage: string | null;
  progress: number;
  overallScore: number | null;
  mobileScore: number | null;
  desktopScore: number | null;
  seoScore: number | null;
  aiScore: number | null;
  summaryHeadline: string | null;
  summaryText: string | null;
  shareToken: string | null;
  errorMessage: string | null;
  pagesCrawled: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  jobGeneration: number;
  activeJobId: string | null;
  enqueuedAt: Date | null;
  completenessJson: string | null;
  topFixesJson: string | null;
  detailJson: string | null;
  checkpointJson: string | null;
  scoringVersion: string;
  contractVersion: number;
  maxPages: number;
  customerLogoUrl: string | null;
  customerCompanyName: string | null;
  customerBrandingJson: string | null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function mapReport(row: RowDataPacket): StoredReport {
  return {
    id: String(row.id),
    userId: String(row.userId),
    url: String(row.url),
    normalizedHost: String(row.normalizedHost),
    normalizedUrl: String(row.normalizedUrl),
    urlHash: String(row.urlHash),
    status: row.status,
    stage: row.stage ? String(row.stage) : null,
    progress: Number(row.progress || 0),
    overallScore: num(row.overallScore),
    mobileScore: num(row.mobileScore),
    desktopScore: num(row.desktopScore),
    seoScore: num(row.seoScore),
    aiScore: num(row.aiScore),
    summaryHeadline: row.summaryHeadline ? String(row.summaryHeadline) : null,
    summaryText: row.summaryText ? String(row.summaryText) : null,
    shareToken: row.shareToken ? String(row.shareToken) : null,
    errorMessage: row.errorMessage ? String(row.errorMessage) : null,
    pagesCrawled: Number(row.pagesCrawled || 0),
    createdAt: asDate(row.createdAt) || new Date(),
    startedAt: asDate(row.startedAt),
    completedAt: asDate(row.completedAt),
    jobGeneration: Number(row.jobGeneration || 1),
    activeJobId: row.activeJobId ? String(row.activeJobId) : null,
    enqueuedAt: asDate(row.enqueuedAt),
    completenessJson: row.completenessJson ? String(row.completenessJson) : null,
    topFixesJson: row.topFixesJson ? String(row.topFixesJson) : null,
    detailJson: row.detailJson ? String(row.detailJson) : null,
    checkpointJson: row.checkpointJson ? String(row.checkpointJson) : null,
    scoringVersion: String(row.scoringVersion),
    contractVersion: Number(row.contractVersion || 1),
    maxPages: Number(row.maxPages || 50),
    customerLogoUrl: row.customerLogoUrl ? String(row.customerLogoUrl) : null,
    customerCompanyName: row.customerCompanyName ? String(row.customerCompanyName) : null,
    customerBrandingJson: row.customerBrandingJson ? String(row.customerBrandingJson) : null,
  };
}

const COLUMNS = `id, userId, url, normalizedHost, normalizedUrl, urlHash, status, stage, progress,
  overallScore, mobileScore, desktopScore, seoScore, aiScore, summaryHeadline, summaryText,
  shareToken, errorMessage, pagesCrawled, createdAt, startedAt, completedAt, jobGeneration,
  activeJobId, enqueuedAt, completenessJson, topFixesJson, detailJson, checkpointJson,
  scoringVersion, contractVersion, maxPages, customerLogoUrl, customerCompanyName, customerBrandingJson`;

export interface WebReportRepository {
  findCached(userId: string, urlHash: string, since: Date): Promise<StoredReport | null>;
  countActive(userId: string): Promise<number>;
  insertReserved(input: {
    userId: string;
    dailyLimit: number;
    concurrentLimit: number;
    windowCutoff: Date;
    now: Date;
    row: StoredReport;
  }): Promise<'quota' | 'concurrent' | StoredReport>;
  getById(id: string): Promise<StoredReport | null>;
  list(userId: string, limit: number, offset: number): Promise<{ rows: StoredReport[]; total: number }>;
  markFailed(id: string, message: string): Promise<void>;
  markEnqueued(id: string, when: Date): Promise<void>;
  refundQuota(userId: string): Promise<void>;
  beginRescan(id: string, userId: string, maxPages: number, dailyLimit: number, windowCutoff: Date, now: Date): Promise<
    'missing' | 'running' | 'quota' | { action: 'existing' | 'restarted'; report: StoredReport }
  >;
  setShareToken(id: string, userId: string, token: string | null): Promise<StoredReport | null>;
  deleteOwned(id: string, userId: string): Promise<StoredReport | null>;
  getByShareToken(token: string): Promise<StoredReport | null>;
  loadChildren(id: string): Promise<{ checks: AuditCheck[]; perf: StoredPerf[] }>;
  updateBranding(
    id: string,
    userId: string,
    branding: { companyName?: string | null; logoUrl?: string | null }
  ): Promise<StoredReport | null>;
  loadChildrenBatch(ids: string[]): Promise<Map<string, { checks: AuditCheck[]; perf: StoredPerf[] }>>;
}

function jsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export const mysqlWebReportRepository: WebReportRepository = {
  async findCached(userId, urlHash, since) {
    const row = await db.query<RowDataPacket>(
      `SELECT ${COLUMNS} FROM tbl_webreport
        WHERE userId = ? AND urlHash = ? AND createdAt >= ?
          AND status IN ('queued', 'running', 'completed')
        ORDER BY createdAt DESC, id DESC
        LIMIT 1`,
      [userId, urlHash, since]
    );
    return row ? mapReport(row) : null;
  },

  async countActive(userId) {
    const row = await db.query<RowDataPacket>(
      `SELECT COUNT(*) AS total FROM tbl_webreport WHERE userId = ? AND status IN ('queued', 'running')`,
      [userId]
    );
    return Number(row?.total || 0);
  },

  async insertReserved({ userId, dailyLimit, concurrentLimit, windowCutoff, now, row }) {
    const conn = await db.beginTransaction();
    try {
      const [reserve] = await conn.query<any>(
        `UPDATE tbl_user
            SET dailyWebReportsUsed = IF(dailyWebReportsResetAt < ?, 1, dailyWebReportsUsed + 1),
                dailyWebReportsResetAt = IF(dailyWebReportsResetAt < ?, ?, dailyWebReportsResetAt)
          WHERE id = ?
            AND (dailyWebReportsResetAt < ? OR dailyWebReportsUsed < ?)`,
        [windowCutoff, windowCutoff, now, userId, windowCutoff, dailyLimit]
      );
      if (!reserve.affectedRows) {
        await db.rollback(conn);
        return 'quota';
      }
      const [activeRows] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM tbl_webreport WHERE userId = ? AND status IN ('queued', 'running')`,
        [userId]
      );
      if (Number(activeRows[0]?.total || 0) >= concurrentLimit) {
        await db.rollback(conn);
        return 'concurrent';
      }
      await conn.query(
        `INSERT INTO tbl_webreport (
          id, userId, url, normalizedHost, normalizedUrl, urlHash, status, stage, progress,
          pagesCrawled, createdAt, jobGeneration, scoringVersion, contractVersion, maxPages
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'validating', 0, 0, ?, 1, ?, ?, ?)`,
        [
          row.id,
          row.userId,
          row.url,
          row.normalizedHost,
          row.normalizedUrl,
          row.urlHash,
          now,
          row.scoringVersion,
          row.contractVersion,
          row.maxPages,
        ]
      );
      await db.commit(conn);
      return { ...row, createdAt: now, status: 'queued', stage: 'validating', progress: 0, jobGeneration: 1 };
    } catch (err) {
      await db.rollback(conn);
      throw err;
    }
  },

  async getById(id) {
    const row = await db.query<RowDataPacket>(`SELECT ${COLUMNS} FROM tbl_webreport WHERE id = ?`, [id]);
    return row ? mapReport(row) : null;
  },

  async list(userId, limit, offset) {
    const rows = await db.queryAll<RowDataPacket>(
      `SELECT ${COLUMNS} FROM tbl_webreport WHERE userId = ? ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    const totalRow = await db.query<RowDataPacket>(
      `SELECT COUNT(*) AS total FROM tbl_webreport WHERE userId = ?`,
      [userId]
    );
    return { rows: rows.map(mapReport), total: Number(totalRow?.total || 0) };
  },

  async markFailed(id, message) {
    await db.execute(
      `UPDATE tbl_webreport
          SET status = 'failed', stage = 'completed', errorMessage = ?, completedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ? AND status IN ('queued', 'running')`,
      [message.slice(0, 500), id]
    );
  },

  async markEnqueued(id, when) {
    await db.execute(`UPDATE tbl_webreport SET enqueuedAt = ? WHERE id = ? AND status = 'queued'`, [when, id]);
  },

  async refundQuota(userId) {
    await db.execute(
      `UPDATE tbl_user SET dailyWebReportsUsed = GREATEST(dailyWebReportsUsed - 1, 0) WHERE id = ?`,
      [userId]
    );
  },

  async beginRescan(id, userId, maxPages, dailyLimit, windowCutoff, now) {
    const conn = await db.beginTransaction();
    try {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT ${COLUMNS} FROM tbl_webreport WHERE id = ? AND userId = ? FOR UPDATE`,
        [id, userId]
      );
      const current = rows[0] ? mapReport(rows[0]) : null;
      if (!current) {
        await db.rollback(conn);
        return 'missing';
      }
      if (current.status === 'running') {
        await db.rollback(conn);
        return 'running';
      }
      if (current.status === 'queued') {
        await db.rollback(conn);
        return { action: 'existing', report: current };
      }
      const [reserve] = await conn.query<any>(
        `UPDATE tbl_user
            SET dailyWebReportsUsed = IF(dailyWebReportsResetAt < ?, 1, dailyWebReportsUsed + 1),
                dailyWebReportsResetAt = IF(dailyWebReportsResetAt < ?, ?, dailyWebReportsResetAt)
          WHERE id = ?
            AND (dailyWebReportsResetAt < ? OR dailyWebReportsUsed < ?)`,
        [windowCutoff, windowCutoff, now, userId, windowCutoff, dailyLimit]
      );
      if (!reserve.affectedRows) {
        await db.rollback(conn);
        return 'quota';
      }
      const generation = current.jobGeneration + 1;
      await conn.query(
        `UPDATE tbl_webreport
            SET status = 'queued', stage = 'validating', progress = 0, errorMessage = NULL,
                startedAt = NULL, completedAt = NULL, enqueuedAt = NULL, activeJobId = NULL,
                overallScore = NULL, mobileScore = NULL, desktopScore = NULL, seoScore = NULL, aiScore = NULL,
                summaryHeadline = NULL, summaryText = NULL, pagesCrawled = 0,
                completenessJson = NULL, topFixesJson = NULL, detailJson = NULL, checkpointJson = NULL,
                jobGeneration = ?, maxPages = ?
          WHERE id = ? AND userId = ?`,
        [generation, maxPages, id, userId]
      );
      await db.commit(conn);
      return {
        action: 'restarted',
        report: {
          ...current,
          status: 'queued',
          stage: 'validating',
          progress: 0,
          jobGeneration: generation,
          maxPages,
          errorMessage: null,
          completedAt: null,
          startedAt: null,
          activeJobId: null,
          enqueuedAt: null,
          pagesCrawled: 0,
          overallScore: null,
          mobileScore: null,
          desktopScore: null,
          seoScore: null,
          aiScore: null,
          summaryHeadline: null,
          summaryText: null,
          completenessJson: null,
          topFixesJson: null,
          detailJson: null,
          checkpointJson: null,
        },
      };
    } catch (err) {
      await db.rollback(conn);
      throw err;
    }
  },

  async setShareToken(id, userId, token) {
    const result = await db.execute(
      `UPDATE tbl_webreport SET shareToken = ? WHERE id = ? AND userId = ?`,
      [token, id, userId]
    );
    if (!result.affectedRows) return null;
    return this.getById(id);
  },

  async deleteOwned(id, userId) {
    const existing = await this.getById(id);
    if (!existing || existing.userId !== userId) return null;
    await db.execute(`DELETE FROM tbl_webreport WHERE id = ? AND userId = ?`, [id, userId]);
    return existing;
  },

  async getByShareToken(token) {
    const row = await db.query<RowDataPacket>(
      `SELECT ${COLUMNS} FROM tbl_webreport WHERE shareToken = ?`,
      [token]
    );
    return row ? mapReport(row) : null;
  },

  async loadChildren(id) {
    const checks = await db.queryAll<RowDataPacket>(
      `SELECT category, checkId, status, severity, title, description, affectedCount, affectedUrls, fix, impact, effort
         FROM tbl_webreport_check WHERE reportId = ? ORDER BY checkId ASC`,
      [id]
    );
    const perf = await db.queryAll<RowDataPacket>(
      `SELECT device, pageUrl, score, lcpMs, inpMs, cls, fcpMs, ttfbMs, tbtMs, bytes, opportunities, fieldData
         FROM tbl_webreport_perf WHERE reportId = ? ORDER BY device ASC, pageUrl ASC`,
      [id]
    );
    return {
      checks: checks.map((row) => ({
        id: String(row.checkId),
        category: row.category,
        status: row.status,
        severity: row.severity,
        title: String(row.title),
        description: String(row.description),
        affectedCount: Number(row.affectedCount || 0),
        affectedUrls: parseUrls(row.affectedUrls),
        fix: String(row.fix),
        impact: row.impact,
        effort: row.effort,
      })),
      perf: perf.map((row) => ({
        device: row.device,
        pageUrl: row.pageUrl ? String(row.pageUrl) : null,
        score: num(row.score),
        lcpMs: num(row.lcpMs),
        inpMs: num(row.inpMs),
        cls: num(row.cls),
        fcpMs: num(row.fcpMs),
        ttfbMs: num(row.ttfbMs),
        tbtMs: num(row.tbtMs),
        bytes: num(row.bytes),
        opportunitiesJson: jsonText(row.opportunities),
        fieldDataJson: jsonText(row.fieldData),
      })),
    };
  },

  async loadChildrenBatch(ids: string[]): Promise<Map<string, { checks: AuditCheck[]; perf: StoredPerf[] }>> {
    const map = new Map<string, { checks: AuditCheck[]; perf: StoredPerf[] }>();
    if (!ids.length) return map;
    for (const id of ids) {
      map.set(id, { checks: [], perf: [] });
    }

    const placeholders = ids.map(() => '?').join(',');
    const [checks, perf] = await Promise.all([
      db.queryAll<RowDataPacket>(
        `SELECT reportId, category, checkId, status, severity, title, description, affectedCount, affectedUrls, fix, impact, effort
           FROM tbl_webreport_check WHERE reportId IN (${placeholders}) ORDER BY checkId ASC`,
        ids
      ),
      db.queryAll<RowDataPacket>(
        `SELECT reportId, device, pageUrl, score, lcpMs, inpMs, cls, fcpMs, ttfbMs, tbtMs, bytes, opportunities, fieldData
           FROM tbl_webreport_perf WHERE reportId IN (${placeholders}) ORDER BY device ASC, pageUrl ASC`,
        ids
      ),
    ]);

    for (const row of checks) {
      const entry = map.get(String(row.reportId));
      if (entry) {
        entry.checks.push({
          id: String(row.checkId),
          category: row.category,
          status: row.status,
          severity: row.severity,
          title: String(row.title),
          description: String(row.description),
          affectedCount: Number(row.affectedCount || 0),
          affectedUrls: parseUrls(row.affectedUrls),
          fix: String(row.fix),
          impact: row.impact,
          effort: row.effort,
        });
      }
    }

    for (const row of perf) {
      const entry = map.get(String(row.reportId));
      if (entry) {
        entry.perf.push({
          device: row.device,
          pageUrl: row.pageUrl ? String(row.pageUrl) : null,
          score: num(row.score),
          lcpMs: num(row.lcpMs),
          inpMs: num(row.inpMs),
          cls: num(row.cls),
          fcpMs: num(row.fcpMs),
          ttfbMs: num(row.ttfbMs),
          tbtMs: num(row.tbtMs),
          bytes: num(row.bytes),
          opportunitiesJson: jsonText(row.opportunities),
          fieldDataJson: jsonText(row.fieldData),
        });
      }
    }

    return map;
  },

  async updateBranding(
    id: string,
    userId: string,
    branding: { companyName?: string | null; logoUrl?: string | null }
  ): Promise<StoredReport | null> {
    const existing = await this.getById(id);
    if (!existing || existing.userId !== userId) return null;

    let parsedBranding: Record<string, unknown> = {};
    if (existing.customerBrandingJson) {
      try {
        parsedBranding = JSON.parse(existing.customerBrandingJson);
      } catch {}
    }

    const updatedCompanyName = branding.companyName !== undefined ? branding.companyName : existing.customerCompanyName;
    const updatedLogoUrl = branding.logoUrl !== undefined ? branding.logoUrl : existing.customerLogoUrl;

    const mergedBranding = {
      ...parsedBranding,
      companyName: updatedCompanyName,
      logoUrl: updatedLogoUrl,
      source: 'user_uploaded',
    };

    await db.query(
      `UPDATE tbl_webreport
          SET customerLogoUrl = ?, customerCompanyName = ?, customerBrandingJson = ?
        WHERE id = ? AND userId = ?`,
      [updatedLogoUrl, updatedCompanyName, JSON.stringify(mergedBranding), id, userId]
    );

    return this.getById(id);
  },
};

function parseUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function newShareToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
