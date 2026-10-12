import { Queue } from 'bullmq';
import { redis } from './redis';
import { WEBREPORTS_QUEUE } from '../../../shared/constants';
import { webReportJobId } from '../../../shared/webreports/lifecycle';
import { logger } from './logger';

export interface WebReportJob {
  reportId: string;
  userId: string;
  generation: number;
}

export const webreportsQueue = new Queue<WebReportJob>(WEBREPORTS_QUEUE, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 24 * 3600, count: 200 },
  },
});

export { webReportJobId };

export async function enqueueWebReport(job: WebReportJob): Promise<void> {
  const jobId = webReportJobId(job.reportId, job.generation);
  try {
    await webreportsQueue.add('audit', job, { jobId });
  } catch (err) {
    const existing = await webreportsQueue.getJob(jobId);
    if (existing) return;
    logger.error({ err, reportId: job.reportId, jobId }, 'Failed to enqueue webreport');
    throw err;
  }
}

export async function removeQueuedWebReport(reportId: string, generation: number): Promise<void> {
  const job = await webreportsQueue.getJob(webReportJobId(reportId, generation));
  if (!job) return;
  const state = await job.getState();
  if (state === 'waiting' || state === 'delayed' || state === 'waiting-children') {
    await job.remove();
  }
}
