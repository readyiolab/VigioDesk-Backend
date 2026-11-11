import { Queue, Worker } from 'bullmq';
import { redis } from './redis';
import { logger } from './logger';
import { webreportsScheduleService } from '../modules/webreports/webreports.schedule';

const QUEUE = 'webreport-schedules';
const JOB = 'process-webreport-schedules';
const EVERY_MS = 5 * 60 * 1000;

let worker: Worker | null = null;
let queue: Queue | null = null;

export async function startWebreportsScheduleWorker(): Promise<void> {
  if (worker) return;
  queue = new Queue(QUEUE, { connection: redis as any });
  await queue.add(
    JOB,
    {},
    {
      repeat: { every: EVERY_MS },
      jobId: 'repeat:webreport-schedules',
      removeOnComplete: true,
      removeOnFail: 20,
    }
  );
  await queue.add(JOB, {}, { removeOnComplete: true, removeOnFail: 5, delay: 20_000 });

  worker = new Worker(
    QUEUE,
    async () => {
      await webreportsScheduleService.processDue(20);
    },
    { connection: redis as any, concurrency: 1 }
  );
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'WebReport schedule job failed');
  });
  logger.info({ everyMs: EVERY_MS }, 'WebReport schedule worker started');
}

export async function stopWebreportsScheduleWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
