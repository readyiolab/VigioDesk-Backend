import express from 'express';
import { Worker, Queue } from 'bullmq';
import { WEBREPORTS_QUEUE } from '../../shared/constants';
import { webReportJobId } from '../../shared/webreports/lifecycle';
import { weightsFromEnv } from '../../shared/webreports/scoringConfig';
import { env } from './webreports/env';
import { execute, logger, pool, queryAll, redis } from './webreports/runtime';
import { runPipeline } from './webreports/pipeline';
import { markFailed } from './webreports/store';

const scoring = weightsFromEnv(process.env);
if (scoring.normalized) {
  logger.warn({ weights: scoring.weights }, 'Web report scoring weights were normalized to 100');
}

const queue = new Queue(WEBREPORTS_QUEUE, { connection: redis as any });
const controllers = new Map<string, AbortController>();
let shuttingDown = false;
let recovering = false;

const worker = new Worker(
  WEBREPORTS_QUEUE,
  async (job) => {
    if (shuttingDown) throw new Error('Worker is shutting down');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.WEBREPORTS_SCAN_TIMEOUT_MS);
    controllers.set(job.id || '', controller);

    // Keep-alive heartbeat every 10s to ensure BullMQ never considers long Lighthouse/crawls stalled
    const heartbeat = setInterval(() => {
      job.updateProgress(Date.now()).catch(() => undefined);
    }, 10_000);

    try {
      await runPipeline(job.data.reportId, job.data.generation, job.id || '', controller.signal);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timer);
      controllers.delete(job.id || '');
    }
  },
  {
    connection: redis as any,
    concurrency: env.WEBREPORTS_CONCURRENCY,
    lockDuration: 300_000, // 5 minutes lock so CPU intensive Lighthouse runs never lose lock
    stalledInterval: 60_000,
    maxStalledCount: 3,
  }
);

worker.on('failed', (job, err) => {
  logger.error({ err, reportId: job?.data?.reportId, jobId: job?.id }, 'Web report job failed');
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) return;
  void markFailed(
    job.data.reportId,
    job.id || '',
    job.data.generation,
    'The scan could not be completed. Please try again.'
  );
});

async function recover(): Promise<void> {
  if (recovering || shuttingDown) return;
  recovering = true;
  try {
    const rows = await queryAll<{
      id: string;
      userId: string;
      jobGeneration: number;
      status: string;
      startedAt: string | null;
      createdAt: string;
    }>(
      `SELECT id, userId, jobGeneration, status, startedAt, createdAt
         FROM tbl_webreport WHERE status IN ('queued', 'running')`
    );
    for (const row of rows) {
      const jobId = webReportJobId(row.id, row.jobGeneration);
      if (row.status === 'running') {
        const started = new Date(row.startedAt || row.createdAt).getTime();
        if (Date.now() - started > env.WEBREPORTS_SCAN_TIMEOUT_MS + 60_000) {
          await markFailed(row.id, jobId, row.jobGeneration, 'The scan was interrupted and could not be recovered.');
        }
        continue;
      }
      const existing = await queue.getJob(jobId);
      if (existing) continue;
      await queue.add('audit', { reportId: row.id, userId: row.userId, generation: row.jobGeneration }, { jobId });
      await execute(`UPDATE tbl_webreport SET enqueuedAt = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'queued'`, [row.id]);
      logger.info({ reportId: row.id, jobId }, 'Re-queued webreport');
    }
  } catch (err) {
    logger.error({ err }, 'Web report recovery failed');
  } finally {
    recovering = false;
  }
}

const recoveryTimer = setInterval(() => {
  void recover();
}, 120_000);
void recover();

const app = express();
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'UP', service: 'webreports' });
  } catch {
    res.status(503).json({ status: 'DEGRADED', service: 'webreports' });
  }
});
const server = app.listen(env.WEBREPORTS_HEALTH_PORT, () => {
  logger.info({ port: env.WEBREPORTS_HEALTH_PORT }, 'Web reports worker listening');
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down web reports worker');
  clearInterval(recoveryTimer);
  for (const controller of controllers.values()) controller.abort();
  await worker.close();
  server.close();
  await queue.close();
  await redis.quit();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled rejection in web reports worker');
  process.exit(1);
});
