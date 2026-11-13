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

export type ProductWorkersResult = {
  stop: () => Promise<void>;
  /** True only when letter generate/send consumers started. */
  letterWorkersOk: boolean;
  /** True when sign-finalize consumer started. */
  signWorkersOk: boolean;
};

/**
 * Starts letter generate/send + sign-finalize consumers in the worker process.
 * Used when API has INLINE_LETTER_SIGN_WORKERS=false.
 */
export async function startProductWorkersFromApi(): Promise<ProductWorkersResult> {
  const stops: Array<() => Promise<void>> = [];
  let letterWorkersOk = false;
  let signWorkersOk = false;

  try {
    const letterMod = await importApiModule<{
      startLetterWorkers: () => void;
      stopLetterWorkers: () => Promise<void>;
    }>('letterWorkers.js');
    letterMod.startLetterWorkers();
    stops.push(async () => {
      await letterMod.stopLetterWorkers();
    });
    letterWorkersOk = true;
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
    signWorkersOk = true;
    logger.info('Worker process: sign-finalize consumer started');
  } catch (err) {
    logger.error({ err }, 'Failed to start sign-finalize worker in worker process');
  }

  if (!letterWorkersOk) {
    logger.error(
      'Letter PDF consumers did NOT start — batches will stick on "Making PDFs". Fix API dist path or set INLINE_LETTER_SIGN_WORKERS=true on the API.'
    );
  }

  return {
    letterWorkersOk,
    signWorkersOk,
    stop: async () => {
      for (const stop of stops) {
        try {
          await stop();
        } catch (err) {
          logger.warn({ err }, 'Error stopping product worker');
        }
      }
    },
  };
}
