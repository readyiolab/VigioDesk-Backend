import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { webreportsService } from './webreports.service';
import { logger } from '../../lib/logger';

const PRO_PLANS = new Set(['PRO', 'ENTERPRISE']);

export const webreportsScheduleService = {
  async list(userId: string) {
    return db.selectAll(
      'tbl_webreport_schedule',
      '*',
      'userId = ?',
      [userId],
      'ORDER BY createdAt DESC'
    );
  },

  async create(
    userId: string,
    plan: 'FREE' | 'PRO' | 'ENTERPRISE',
    input: { sourceReportId?: string; url?: string; intervalHours?: number; maxPages?: number }
  ) {
    if (!PRO_PLANS.has(plan)) {
      throw new AppError('Scheduled WebReports require a PRO or ENTERPRISE plan', 403);
    }

    let url = (input.url || '').trim();
    let sourceReportId = input.sourceReportId || null;
    let maxPages = input.maxPages || PLAN_LIMITS[plan].maxWebReportPages;

    if (sourceReportId) {
      const report: any = await db.select(
        'tbl_webreport',
        'id, url, maxPages',
        'id = ? AND userId = ?',
        [sourceReportId, userId]
      );
      if (!report) throw new AppError('Source report not found', 404);
      url = report.url;
      maxPages = report.maxPages || maxPages;
    }
    if (!url) throw new AppError('url or sourceReportId is required', 400);

    const intervalHours = Math.max(24, Math.min(24 * 30, Number(input.intervalHours) || 168));
    const id = crypto.randomUUID();
    const nextRunAt = new Date(Date.now() + intervalHours * 60 * 60 * 1000);

    await db.insert('tbl_webreport_schedule', {
      id,
      userId,
      sourceReportId,
      url,
      intervalHours,
      enabled: 1,
      nextRunAt,
      maxPages,
    });

    return db.select('tbl_webreport_schedule', '*', 'id = ?', [id]);
  },

  async remove(userId: string, scheduleId: string) {
    const result = await db.delete('tbl_webreport_schedule', 'id = ? AND userId = ?', [
      scheduleId,
      userId,
    ]);
    if (!result.affected_rows) throw new AppError('Schedule not found', 404);
    return { deleted: true };
  },

  /**
   * Due schedules: rescan source report when present, otherwise create a new scan.
   * Called from the maintenance worker / API scheduler.
   */
  async processDue(limit = 20): Promise<{ ran: number }> {
    const due = await db.queryAll(
      `SELECT s.*, u.plan
         FROM tbl_webreport_schedule s
         JOIN tbl_user u ON u.id = s.userId
        WHERE s.enabled = 1 AND s.nextRunAt <= NOW()
        ORDER BY s.nextRunAt ASC
        LIMIT ?`,
      [limit]
    );

    let ran = 0;
    for (const row of due as any[]) {
      const plan = (row.plan as 'FREE' | 'PRO' | 'ENTERPRISE') || 'FREE';
      if (!PRO_PLANS.has(plan)) {
        await db.update('tbl_webreport_schedule', { enabled: 0 }, 'id = ?', [row.id]);
        continue;
      }

      try {
        let reportId: string | null = null;
        if (row.sourceReportId) {
          const result = await webreportsService.rescan(
            row.userId,
            plan,
            row.sourceReportId,
            row.maxPages
          );
          reportId = result.report?.id || row.sourceReportId;
        } else {
          const result = await webreportsService.create(row.userId, plan, {
            url: row.url,
            maxPages: row.maxPages,
          });
          reportId = result.report?.id || null;
        }

        const nextRunAt = new Date(Date.now() + Number(row.intervalHours) * 60 * 60 * 1000);
        await db.update(
          'tbl_webreport_schedule',
          {
            lastRunAt: new Date(),
            lastReportId: reportId,
            nextRunAt,
          },
          'id = ?',
          [row.id]
        );
        ran += 1;
      } catch (err) {
        logger.warn({ err, scheduleId: row.id }, 'WebReport schedule run failed');
        const nextRunAt = new Date(Date.now() + Number(row.intervalHours) * 60 * 60 * 1000);
        await db.update('tbl_webreport_schedule', { nextRunAt }, 'id = ?', [row.id]);
      }
    }

    if (ran > 0) logger.info({ ran }, 'WebReport schedules processed');
    return { ran };
  },
};
