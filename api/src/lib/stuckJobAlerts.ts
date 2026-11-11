import { heavyQueue, lightQueue, deadQueue, signFinalizeQueue, maintenanceQueue } from './queue';
import { webreportsQueue } from './webreportsQueue';
import {
  letterGenerateQueue,
  letterSendQueue,
  letterZipQueue,
} from './letterQueues';
import { logger } from './logger';
import { redis } from './redis';
import { isMailerConfigured, sendMail } from './mailer';
import { env } from '../config/env';

const STUCK_MS = 30 * 60 * 1000;

async function countStuck(queue: { getJobs: Function }, kinds: string[]) {
  const jobs = await queue.getJobs(kinds, 0, 50);
  const now = Date.now();
  return (jobs as Array<{ timestamp?: number; processedOn?: number; finishedOn?: number }>).filter(
    (j) => {
      const start = j.processedOn || j.timestamp || 0;
      return start > 0 && now - start > STUCK_MS && !j.finishedOn;
    }
  ).length;
}

/**
 * Ops visibility: log + optional email when active jobs look stuck (>30m).
 */
export async function processStuckJobAlerts(): Promise<void> {
  const queues = [
    ['heavy', heavyQueue],
    ['light', lightQueue],
    ['sign-finalize', signFinalizeQueue],
    ['webreports', webreportsQueue],
    ['letter-generate', letterGenerateQueue],
    ['letter-send', letterSendQueue],
    ['letter-zip', letterZipQueue],
    ['maintenance', maintenanceQueue],
  ] as const;

  const report: Record<string, number> = {};
  let totalStuck = 0;
  let dead = 0;

  for (const [name, q] of queues) {
    const stuck = await countStuck(q, ['active']).catch(() => 0);
    report[name] = stuck;
    totalStuck += stuck;
  }
  dead = await deadQueue.getJobCounts().then((c) => c.failed || 0).catch(() => 0);

  if (totalStuck === 0 && dead < 20) return;

  logger.warn({ report, dead }, 'Queue health: stuck or dead jobs elevated');

  const alertTo = env.ADMIN_EMAIL || env.SMTP_FROM;
  if (!alertTo || !isMailerConfigured()) return;

  const lock = await redis.set('ops:stuck-job-alert', '1', 'EX', 6 * 60 * 60, 'NX').catch(() => null);
  if (!lock) return;

  await sendMail({
    to: alertTo,
    subject: `[Vigodesk] Queue alert: ${totalStuck} stuck, ${dead} dead`,
    text: `Stuck jobs by queue:\n${JSON.stringify(report, null, 2)}\nDead/failed: ${dead}`,
    html: `<pre>${JSON.stringify({ report, dead }, null, 2)}</pre>`,
  }).catch(() => undefined);
}
