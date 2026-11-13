import { redis } from './redis';
import { AppError } from '../middleware/errorHandler.middleware';

/**
 * Per-user Redis semaphore for long sync AI HTTP handlers.
 * Prevents a single org from saturating the API with parallel OpenAI calls.
 */
export async function withAiSlot<T>(
  scope: string,
  ownerId: string,
  maxConcurrent: number,
  fn: () => Promise<T>
): Promise<T> {
  const key = `ai:sem:${scope}:${ownerId}`;
  const limit = Math.max(1, maxConcurrent);
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 180);
  if (n > limit) {
    await redis.decr(key).catch(() => undefined);
    throw new AppError(
      'Too many AI requests in progress for this account. Please wait and try again.',
      429
    );
  }
  try {
    return await fn();
  } finally {
    await redis.decr(key).catch(() => undefined);
  }
}
