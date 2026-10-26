import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWebReportsService } from './webreports.logic';
import type { StoredReport, WebReportRepository } from './webreports.repo';
import type { DnsResolver } from '../../../../shared/webreports/urlSafety';
import { AppError } from '../../middleware/errorHandler.middleware';

const resolve: DnsResolver = async () => [{ address: '8.8.8.8', family: 4 }];

function memoryRepo() {
  const rows: StoredReport[] = [];
  let quota = 0;
  const repo: WebReportRepository = {
    async findCached(userId, urlHash, since) {
      return rows.find((row) => row.userId === userId && row.urlHash === urlHash && row.createdAt >= since && row.status !== 'failed') || null;
    },
    async countActive(userId) {
      return rows.filter((row) => row.userId === userId && (row.status === 'queued' || row.status === 'running')).length;
    },
    async insertReserved({ userId, dailyLimit, concurrentLimit, row }) {
      if (quota >= dailyLimit) return 'quota';
      if (rows.filter((item) => item.userId === userId && (item.status === 'queued' || item.status === 'running')).length >= concurrentLimit) {
        return 'concurrent';
      }
      quota += 1;
      rows.push(row);
      return row;
    },
    async getById(id) {
      return rows.find((row) => row.id === id) || null;
    },
    async list(userId, limit, offset) {
      const owned = rows.filter((row) => row.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
      return { rows: owned.slice(offset, offset + limit), total: owned.length };
    },
    async markFailed(id, message) {
      const row = rows.find((item) => item.id === id);
      if (row && (row.status === 'queued' || row.status === 'running')) {
        row.status = 'failed';
        row.errorMessage = message;
      }
    },
    async markEnqueued(id, when) {
      const row = rows.find((item) => item.id === id);
      if (row) row.enqueuedAt = when;
    },
    async refundQuota() {
      quota = Math.max(0, quota - 1);
    },
    async beginRescan(id, userId, maxPages, dailyLimit) {
      const row = rows.find((item) => item.id === id && item.userId === userId);
      if (!row) return 'missing';
      if (row.status === 'running') return 'running';
      if (row.status === 'queued') return { action: 'existing', report: row };
      if (quota >= dailyLimit) return 'quota';
      quota += 1;
      row.status = 'queued';
      row.jobGeneration += 1;
      row.maxPages = maxPages;
      row.progress = 0;
      row.enqueuedAt = null;
      return { action: 'restarted', report: row };
    },
    async setShareToken(id, userId, token) {
      const row = rows.find((item) => item.id === id && item.userId === userId);
      if (!row) return null;
      row.shareToken = token;
      return row;
    },
    async deleteOwned(id, userId) {
      const index = rows.findIndex((item) => item.id === id && item.userId === userId);
      if (index < 0) return null;
      const [row] = rows.splice(index, 1);
      return row;
    },
    async getByShareToken(token) {
      return rows.find((row) => row.shareToken === token) || null;
    },
    async loadChildren() {
      return { checks: [], perf: [] };
    },
    async loadChildrenBatch(ids: string[]) {
      const map = new Map();
      for (const id of ids) map.set(id, { checks: [], perf: [] });
      return map;
    },
  };
  return { repo, rows, quota: () => quota };
}

function service(store = memoryRepo(), enqueue = async () => undefined, removeQueued = async () => undefined) {
  return {
    store,
    api: createWebReportsService({
      repo: store.repo,
      resolve,
      enqueue,
      removeQueued,
      now: () => new Date('2026-10-12T12:00:00.000Z'),
      globalMaxPages: 50,
      cacheTtlMs: 30 * 60 * 1000,
    }),
  };
}

describe('webreport service', () => {
  it('queues a scan and returns 202', async () => {
    const jobs: string[] = [];
    const { api } = service(memoryRepo(), async (job) => {
      jobs.push(job.reportId);
    });
    const result = await api.create('user-1', 'FREE', { url: 'https://Example.com/path' });
    assert.equal(result.statusCode, 202);
    assert.equal(result.cached, false);
    assert.equal(result.report.url, 'https://example.com/path');
    assert.equal(jobs.length, 1);
  });

  it('returns a cached report unless force is set', async () => {
    let enqueues = 0;
    const { api } = service(memoryRepo(), async () => {
      enqueues += 1;
    });
    await api.create('user-1', 'FREE', { url: 'https://example.com/' });
    const cached = await api.create('user-1', 'FREE', { url: 'https://example.com/' });
    assert.equal(cached.statusCode, 200);
    assert.equal(cached.cached, true);
    assert.equal(enqueues, 1);
    await api.create('user-1', 'PRO', { url: 'https://example.com/', force: true });
    assert.equal(enqueues, 2);
  });

  it('marks the report failed when the queue rejects and refunds quota', async () => {
    const { api, store } = service(memoryRepo(), async () => {
      throw new Error('redis down');
    });
    await assert.rejects(() => api.create('user-1', 'FREE', { url: 'https://example.com/' }), (err: unknown) => err instanceof AppError && err.statusCode === 503);
    assert.equal(store.rows[0].status, 'failed');
    assert.equal(store.quota(), 0);
  });

  it('hides reports owned by someone else', async () => {
    const { api } = service();
    const created = await api.create('user-1', 'FREE', { url: 'https://example.com/' });
    await assert.rejects(() => api.get('user-2', created.report.id as string), (err: unknown) => err instanceof AppError && err.statusCode === 404);
  });

  it('paginates history', async () => {
    const { api } = service();
    await api.create('user-1', 'PRO', { url: 'https://example.com/a' });
    await api.create('user-1', 'PRO', { url: 'https://example.com/b' });
    const page = await api.list('user-1', 1, 0);
    assert.equal(page.reports.length, 1);
    assert.equal(page.pagination.total, 2);
  });

  it('shares, revokes, and allowlists the public report', async () => {
    const { api } = service();
    const created = await api.create('user-1', 'FREE', { url: 'https://example.com/' });
    const id = created.report.id as string;
    const share = await api.share('user-1', id);
    assert.equal(share.shareToken.length, 64);
    const pub = await api.getPublic(share.shareToken);
    assert.equal('id' in pub, false);
    assert.equal(pub.url, 'https://example.com/');
    await api.revoke('user-1', id);
    await assert.rejects(() => api.getPublic(share.shareToken), (err: unknown) => err instanceof AppError && err.statusCode === 404);
  });

  it('deletes a queued report and asks the queue to drop the job', async () => {
    const removed: string[] = [];
    const { api } = service(memoryRepo(), async () => undefined, async (id) => {
      removed.push(id);
    });
    const created = await api.create('user-1', 'FREE', { url: 'https://example.com/' });
    await api.remove('user-1', created.report.id as string);
    assert.deepEqual(removed, [created.report.id]);
    await assert.rejects(() => api.get('user-1', created.report.id as string), AppError);
  });

  it('rescans a completed report and refuses a running one', async () => {
    const { api, store } = service();
    const created = await api.create('user-1', 'PRO', { url: 'https://example.com/' });
    store.rows[0].status = 'completed';
    const again = await api.rescan('user-1', 'PRO', created.report.id as string);
    assert.equal(again.statusCode, 202);
    assert.equal(store.rows[0].jobGeneration, 2);
    store.rows[0].status = 'running';
    await assert.rejects(() => api.rescan('user-1', 'PRO', created.report.id as string), (err: unknown) => err instanceof AppError && err.statusCode === 409);
  });

  it('enforces the free daily quota', async () => {
    const { api, store } = service();
    for (const path of ['/1', '/2', '/3']) {
      await api.create('user-1', 'FREE', { url: `https://example.com${path}` });
      store.rows[store.rows.length - 1].status = 'completed';
    }
    await assert.rejects(
      () => api.create('user-1', 'FREE', { url: 'https://example.com/4' }),
      (err: unknown) => err instanceof AppError && err.statusCode === 403
    );
  });
});
