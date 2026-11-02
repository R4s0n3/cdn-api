import { type Request, type Response } from 'express';

import { getConfig } from '../config';
import { db } from '../db';
import { checkUploadStaging } from '../util/upload-staging';
import { getObjectStorage } from '../storage/s3-storage';

/** Report process liveness without querying external dependencies. */
export function getLiveness(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok' });
}

let databaseProbe: Promise<unknown> | undefined;

/** Allow only one outstanding readiness query, including after its HTTP timeout. */
function checkDatabase(): Promise<unknown> {
  if (databaseProbe)
    throw new Error('Previous readiness database probe is still running');
  const probe = Promise.resolve().then(() => db.$queryRawUnsafe('SELECT 1'));
  databaseProbe = probe;
  const clear = () => {
    if (databaseProbe === probe) databaseProbe = undefined;
  };
  void probe.then(clear, clear);
  return probe;
}

/** Check database, bucket, and writable staging within the configured response deadline. */
export async function getReadiness(
  _req: Request,
  res: Response,
): Promise<void> {
  const timeoutMs = getConfig().readinessTimeoutMs;
  const abortController = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abortController.abort();
      reject(new Error(`Readiness check exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
  });

  try {
    await Promise.race([
      Promise.all([
        checkDatabase(),
        checkUploadStaging(),
        getObjectStorage().checkBucket(abortController.signal),
      ]),
      deadline,
    ]);
    res.status(200).json({ status: 'ready' });
  } catch (error) {
    console.error('Readiness check failed', error);
    res.status(503).json({ status: 'not_ready' });
  } finally {
    abortController.abort();
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
