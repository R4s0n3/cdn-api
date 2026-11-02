import { type Request, type Response } from 'express';

import { getConfig } from '../config';
import { db } from '../db';
import { getObjectStorage } from '../storage/s3-storage';

export function getLiveness(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok' });
}

export async function getReadiness(_req: Request, res: Response): Promise<void> {
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
        db.$queryRawUnsafe('SELECT 1'),
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
