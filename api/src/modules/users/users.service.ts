import { db } from '../../lib/mysql';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { AppError } from '../../middleware/errorHandler.middleware';

/** MySQL TINYINT / Buffer / "0"|"1" → real boolean. */
function asBool(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return value.length > 0 && value[0] !== 0;
  }
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

export const usersService = {
  /** Usage dashboard vs plan limits (ops, signs, AI, webreports). */
  async getUsage(userId: string) {
    const user: any = await db.select(
      'tbl_user',
      'id, plan, dailyOpsUsed, dailyOpsResetAt, monthlySignsUsed, monthlySignsResetAt, monthlyAiUsed, monthlyAiResetAt, dailyWebReportsUsed, dailyWebReportsResetAt',
      'id = ?',
      [userId]
    );
    if (!user) throw new AppError('User not found', 404);
    const plan = (user.plan as 'FREE' | 'PRO' | 'ENTERPRISE') || 'FREE';
    const limits = PLAN_LIMITS[plan];
    const aiLedger = await db.queryAll(
      `SELECT feature, SUM(credits) AS credits
         FROM tbl_ai_usage
        WHERE userId = ? AND createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY feature
        ORDER BY credits DESC
        LIMIT 20`,
      [userId]
    ).catch(() => []);

    return {
      plan,
      limits: {
        maxDailyOps: limits.maxDailyOps,
        maxMonthlySigns: limits.maxMonthlySigns,
        maxMonthlyAiCredits: limits.maxMonthlyAiCredits,
        maxDailyWebReports: limits.maxDailyWebReports,
        maxFileSize: limits.maxFileSize,
      },
      usage: {
        dailyOpsUsed: Number(user.dailyOpsUsed || 0),
        monthlySignsUsed: Number(user.monthlySignsUsed || 0),
        monthlyAiUsed: Number(user.monthlyAiUsed || 0),
        dailyWebReportsUsed: Number(user.dailyWebReportsUsed || 0),
        dailyOpsResetAt: user.dailyOpsResetAt,
        monthlySignsResetAt: user.monthlySignsResetAt,
        monthlyAiResetAt: user.monthlyAiResetAt,
        dailyWebReportsResetAt: user.dailyWebReportsResetAt,
      },
      aiByFeature: aiLedger,
    };
  },

  async getUserProfile(userId: string) {
    const user = await db.select(
      'tbl_user',
      'id, email, name, plan, emailVerified, authProvider, dailyOpsUsed, dailyOpsResetAt, createdAt',
      'id = ?',
      [userId]
    );

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Lean profile: thin job rows only (no inputFiles JSON). History polls /jobs/active + /jobs/recent.
    const jobs = await db.selectAll(
      'tbl_job',
      'id, tool, status, outputFile, errorMessage, createdAt, completedAt, expiresAt',
      'userId = ?',
      [userId],
      'ORDER BY createdAt DESC LIMIT 10'
    );

    const limits = PLAN_LIMITS[user.plan as 'FREE' | 'PRO' | 'ENTERPRISE'];
    const remainingOps = Math.max(0, limits.maxDailyOps - user.dailyOpsUsed);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      plan: user.plan,
      emailVerified: asBool(user.emailVerified),
      authProvider: user.authProvider || 'password',
      dailyOpsUsed: user.dailyOpsUsed,
      dailyOpsLimit: limits.maxDailyOps,
      dailyOpsRemaining: remainingOps,
      dailyOpsResetAt: user.dailyOpsResetAt,
      createdAt: user.createdAt,
      jobs: jobs.map((job: any) => ({
        ...job,
        inputFiles: [] as string[],
      })),
    };
  },
};
