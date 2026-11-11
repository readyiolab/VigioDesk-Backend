import { logger } from '../lib/logger';

/**
 * Starts letter generate/send + sign-finalize consumers in the worker process.
 * Used when API has INLINE_LETTER_SIGN_WORKERS=false.
 *
 * Imports the existing API worker modules from the monorepo source tree so we
 * do not duplicate Puppeteer/mail/finalize logic.
 */
export async function startProductWorkersFromApi(): Promise<() => Promise<void>> {
  const stops: Array<() => Promise<void>> = [];

  try {
    const letterMod = await import('../../../api/src/lib/letterWorkers');
    await letterMod.startLetterWorkers();
    stops.push(async () => {
      await letterMod.stopLetterWorkers();
    });
    logger.info('Worker process: letter generate/send consumers started');
  } catch (err) {
    logger.error({ err }, 'Failed to start letter workers in worker process');
  }

  try {
    const signMod = await import('../../../api/src/lib/signFinalizeWorker');
    signMod.startSignFinalizeWorker();
    stops.push(async () => {
      await signMod.stopSignFinalizeWorker();
    });
    logger.info('Worker process: sign-finalize consumer started');
  } catch (err) {
    logger.error({ err }, 'Failed to start sign-finalize worker in worker process');
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
