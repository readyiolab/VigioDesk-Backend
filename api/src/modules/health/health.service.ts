import { db } from '../../lib/mysql';
import { redis } from '../../lib/redis';
import { getMetricsSnapshot, renderPrometheus } from '../../lib/metrics';
import {
  heavyQueue,
  lightQueue,
  signFinalizeQueue,
  maintenanceQueue,
  deadQueue,
} from '../../lib/queue';
import { letterGenerateQueue, letterSendQueue } from '../../lib/letterQueues';

async function queueDepth(queue: { getJobCounts: () => Promise<Record<string, number>> }) {
  try {
    const counts = await queue.getJobCounts();
    return (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0);
  } catch {
    return -1;
  }
}

export const healthService = {
  /** Process is up — do not depend on Redis/MySQL (safe for LB liveness). */
  checkLive() {
    return {
      status: 'UP' as const,
      timestamp: new Date().toISOString(),
    };
  },

  /** Ready to serve traffic — requires DB + Redis. Fail closed for LB. */
  async checkReady() {
    let dbStatus = 'UP';
    let redisStatus = 'UP';
    let redisPingMs = -1;

    try {
      const check = await db.healthCheck();
      dbStatus = check.status === 'healthy' ? 'UP' : 'DOWN';
    } catch {
      dbStatus = 'DOWN';
    }

    try {
      const t0 = Date.now();
      await redis.ping();
      redisPingMs = Date.now() - t0;
    } catch {
      redisStatus = 'DOWN';
    }

    // DOWN (not DEGRADED) so proxies stop sending traffic when deps fail.
    const overallStatus = dbStatus === 'UP' && redisStatus === 'UP' ? 'UP' : 'DOWN';

    return {
      status: overallStatus,
      services: {
        database: dbStatus,
        redis: redisStatus,
      },
      redisPingMs,
      dbPool: db.getPoolStats?.() ?? undefined,
      timestamp: new Date().toISOString(),
    };
  },

  /** @deprecated Prefer checkReady — kept for existing /health probes. */
  async checkHealth() {
    return this.checkReady();
  },

  /** Process metrics + queue depths (Prometheus text or JSON via Accept). */
  async getMetrics(asPrometheus: boolean) {
    const [
      heavy,
      light,
      signFinalize,
      maintenance,
      dead,
      letterGen,
      letterSend,
    ] = await Promise.all([
      queueDepth(heavyQueue),
      queueDepth(lightQueue),
      queueDepth(signFinalizeQueue),
      queueDepth(maintenanceQueue),
      queueDepth(deadQueue),
      queueDepth(letterGenerateQueue),
      queueDepth(letterSendQueue),
    ]);

    let redisPingMs = -1;
    try {
      const t0 = Date.now();
      await redis.ping();
      redisPingMs = Date.now() - t0;
    } catch {
      redisPingMs = -1;
    }

    const pool = db.getPoolStats();
    const extra = {
      queue_heavy: heavy,
      queue_light: light,
      queue_sign_finalize: signFinalize,
      queue_maintenance: maintenance,
      queue_dead: dead,
      queue_letter_generate: letterGen,
      queue_letter_send: letterSend,
      redis_ping_ms: redisPingMs,
      db_pool_all: pool.all,
      db_pool_free: pool.free,
      db_pool_queue: pool.queue,
      db_pool_limit: pool.limit,
    };

    if (asPrometheus) {
      return { contentType: 'text/plain; version=0.0.4; charset=utf-8', body: renderPrometheus(extra) };
    }

    return {
      contentType: 'application/json',
      body: {
        ...getMetricsSnapshot(),
        ...extra,
        timestamp: new Date().toISOString(),
      },
    };
  },
};
