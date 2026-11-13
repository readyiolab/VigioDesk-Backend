import path from 'path';
import { pathToFileURL } from 'url';
import { logger } from '../lib/logger';

/**
 * Worker runs from `worker/` (PM2 cwd). API build output is:
 *   ../api/dist/api/src/lib/<file>.js
 * Relative imports from this compiled file resolve under worker/dist/... and miss the API.
 */
async function importApiModule<T>(file: string): Promise<T> {
  const fs = await import('fs');
  const candidates = [
    path.resolve(process.cwd(), '../api/dist/api/src/lib', file),
    path.resolve(process.cwd(), 'api/dist/api/src/lib', file),
    path.resolve('/var/www/pdf/pdf-backend/api/dist/api/src/lib', file),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Error(
      `API module not found: ${file}. Tried: ${candidates.join(' | ')}. Run "npm run build" in pdf-backend.`
    );
  }
  logger.info({ path: hit }, `Loading API product module ${file}`);
  return (await import(pathToFileURL(hit).href)) as T;
}

/**
 * Starts letter generate/send + sign-finalize consumers in the worker process.
 * Used when API has INLINE_LETTER_SIGN_WORKERS=false.
 */
export async function startProductWorkersFromApi(): Promise<() => Promise<void>> {
  const stops: Array<() => Promise<void>> = [];

  try {
    const letterMod = await importApiModule<{
      startLetterWorkers: () => void;
      stopLetterWorkers: () => Promise<void>;
    }>('letterWorkers.js');
    letterMod.startLetterWorkers();
    stops.push(async () => {
      await letterMod.stopLetterWorkers();
    });
    logger.info('Worker process: letter generate/send consumers started');
  } catch (err) {
    logger.error({ err }, 'Failed to start letter workers in worker process');
  }

  try {
    const signMod = await importApiModule<{
      startSignFinalizeWorker: () => void;
      stopSignFinalizeWorker: () => Promise<void>;
    }>('signFinalizeWorker.js');
    signMod.startSignFinalizeWorker();
    stops.push(async () => {
      await signMod.stopSignFinalizeWorker();
    });
    logger.info('Worker process: sign-finalize consumer started');
  } catch (err) {
    logger.error({ err }, 'Failed to start sign-finalize worker in worker process');
  }

  if (stops.length === 0) {
    logger.warn(
      'No product workers started — set INLINE_LETTER_SIGN_WORKERS=true on API as temporary fallback, or fix API dist path'
    );
  }

  return async () => {
    for (const stop of stops) {
      try {
        await stop();
      } catch (err) {
        logger.warn({ err }, 'Error stopping product worker');
      }
    }
  };
}
