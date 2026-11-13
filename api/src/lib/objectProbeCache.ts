import { redis } from './redis';
import { detectFileCategory } from '../../../shared/fileType';
import { readObjectHeadWithSize } from './s3';

const TTL_SECONDS = 300; // 5 minutes — uploads are short-lived relative to job TTL

type ProbeResult = { size: number; category: string };

function key(bindingId: string | null, objectKey: string): string {
  return `obj:probe:${bindingId || 'platform'}:${objectKey}`;
}

/** Map with limited concurrency (avoids stampedes on multi-file jobs). */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * Probe object size + magic bytes with Redis cache + bounded concurrency.
 * Used by jobs.create validateInputs to cut repeated ranged GETs under load.
 */
export async function probeObjects(
  keys: string[],
  bindingId: string | null
): Promise<ProbeResult[]> {
  return mapPool(keys, 4, async (objectKey) => {
    const cacheKey = key(bindingId, objectKey);
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as ProbeResult;
      } catch {
        /* fall through */
      }
    }

    const probe = await readObjectHeadWithSize(objectKey, 1024, bindingId);
    const category = detectFileCategory(probe.bytes);
    const result: ProbeResult = { size: probe.size, category };
    await redis.set(cacheKey, JSON.stringify(result), 'EX', TTL_SECONDS).catch(() => undefined);
    return result;
  });
}

export async function invalidateObjectProbe(bindingId: string | null, objectKey: string): Promise<void> {
  await redis.del(key(bindingId, objectKey)).catch(() => undefined);
}
