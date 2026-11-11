import { db } from './mysql';
import { PLAN_LIMITS } from '../../../shared/constants';
import { isMailerConfigured, sendMail } from './mailer';
import { redis } from './redis';
import { logger } from './logger';

const THRESHOLD = 0.85;

/**
 * Email owners when daily/monthly quotas cross ~85% of plan limits.
 * Redis NX locks prevent repeat alerts within 20h.
 */
export async function processQuotaNearAlerts(): Promise<{ sent: number }> {
  if (!isMailerConfigured()) return { sent: 0 };

  const users = await db.queryAll(
    `SELECT id, email, name, plan,
            dailyOpsUsed, monthlySignsUsed, monthlyAiUsed, dailyWebReportsUsed
       FROM tbl_user
      WHERE plan IN ('FREE', 'PRO', 'ENTERPRISE')
        AND email IS NOT NULL
        AND emailVerified = 1
      ORDER BY createdAt DESC
      LIMIT 200`
  ).catch(() => []);

  let sent = 0;
  for (const user of users as any[]) {
    const plan = (user.plan as 'FREE' | 'PRO' | 'ENTERPRISE') || 'FREE';
    const limits = PLAN_LIMITS[plan];
    const checks: Array<{ key: string; used: number; limit: number; label: string }> = [
      {
        key: 'ops',
        used: Number(user.dailyOpsUsed || 0),
        limit: limits.maxDailyOps,
        label: 'daily PDF operations',
      },
      {
        key: 'signs',
        used: Number(user.monthlySignsUsed || 0),
        limit: limits.maxMonthlySigns,
        label: 'monthly eSign sends',
      },
      {
        key: 'ai',
        used: Number(user.monthlyAiUsed || 0),
        limit: limits.maxMonthlyAiCredits,
        label: 'monthly AI credits',
      },
      {
        key: 'webreports',
        used: Number(user.dailyWebReportsUsed || 0),
        limit: limits.maxDailyWebReports,
        label: 'daily WebReports',
      },
    ];

    const near = checks.filter(
      (c) => c.limit > 0 && c.limit < 999999 && c.used / c.limit >= THRESHOLD
    );
    if (!near.length) continue;

    for (const item of near) {
      const lock = await redis
        .set(`quota-alert:${user.id}:${item.key}`, '1', 'EX', 20 * 60 * 60, 'NX')
        .catch(() => null);
      if (!lock) continue;

      const pct = Math.round((item.used / item.limit) * 100);
      await sendMail({
        to: user.email,
        subject: `Vigodesk usage alert: ${pct}% of ${item.label}`,
        text: `Hi ${user.name || 'there'},\n\nYou've used ${item.used} of ${item.limit} ${item.label} on the ${plan} plan (${pct}%).\n\nUpgrade or wait for the quota window to reset if you need more capacity.`,
        html: `<p>Hi ${user.name || 'there'},</p><p>You've used <strong>${item.used}</strong> of <strong>${item.limit}</strong> ${item.label} on the <strong>${plan}</strong> plan (${pct}%).</p>`,
      }).catch(() => undefined);
      sent += 1;
    }
  }

  if (sent > 0) logger.info({ sent }, 'Quota-near alerts sent');
  return { sent };
}
