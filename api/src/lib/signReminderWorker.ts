import { Queue, Worker } from 'bullmq';
import { redis } from './redis';
import { logger } from './logger';
import { sendService } from '../modules/signing/send.service';

const SIGN_REMINDER_QUEUE = 'sign-reminders';
const REMINDER_JOB = 'process-signing-reminders';
/** Run every hour. */
const EVERY_MS = 60 * 60 * 1000;

let worker: Worker | null = null;
let queue: Queue | null = null;

/**
 * PRO/ENTERPRISE automatic eSign reminder sweep.
 * Lives on the API process so it can reuse SMTP + send.service.
 */
export async function startSignReminderWorker(): Promise<void> {
  if (worker) return;

  queue = new Queue(SIGN_REMINDER_QUEUE, { connection: redis as any });
  await queue.add(
    REMINDER_JOB,
    {},
    {
      repeat: { every: EVERY_MS },
      jobId: 'repeat:sign-reminders',
      removeOnComplete: true,
      removeOnFail: 20,
    }
  );
  // Kick once shortly after boot.
  await queue.add(REMINDER_JOB, {}, { removeOnComplete: true, removeOnFail: 5, delay: 15_000 });

  worker = new Worker(
    SIGN_REMINDER_QUEUE,
    async () => {
      await sendService.processAutomaticReminders();
      await import('./quotaAlerts')
        .then(({ processQuotaNearAlerts }) => processQuotaNearAlerts())
        .catch((err) => logger.warn({ err }, 'Quota-near alerts failed'));
      await import('./stuckJobAlerts')
        .then(({ processStuckJobAlerts }) => processStuckJobAlerts())
        .catch((err) => logger.warn({ err }, 'Stuck-job alerts failed'));
    },
    { connection: redis as any, concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Signing reminder job failed');
  });

  logger.info({ everyMs: EVERY_MS }, 'Signing reminder worker started');
}

export async function stopSignReminderWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
