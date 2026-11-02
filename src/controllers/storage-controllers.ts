import { type NextFunction, type Request, type Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getConfig } from '../config';
import HttpError from '../models/http-error';
import {
  buildObjectKey,
  getObjectStorage,
  isObjectNotFound,
  isRangeNotSatisfiable,
} from '../storage/s3-storage';

const clusterPattern = /^[a-z0-9]{12}$/;
const fileNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;
const byteRangePattern = /^bytes=(\d*)-(\d*)$/;

export function parseByteRange(range: string | undefined): string | undefined {
  if (!range) {
    return undefined;
  }

  const match = byteRangePattern.exec(range);
  const start = match?.[1];
  const end = match?.[2];

  if (
    !match ||
    (!start && !end) ||
    (!start && end === '0') ||
    (start && end && BigInt(start) > BigInt(end))
  ) {
    throw new HttpError('Invalid byte range', 416);
  }

  return range;
}

function getObjectKey(request: Request): string {
  const { cluster, fileName } = request.params;

  if (
    typeof cluster !== 'string' ||
    typeof fileName !== 'string' ||
    !clusterPattern.test(cluster) ||
    !fileNamePattern.test(fileName) ||
    fileName.includes('..')
  ) {
    throw new HttpError('File not found', 404);
  }

  return buildObjectKey(cluster, fileName, getConfig().s3.keyPrefix);
}

function applyObjectHeaders(
  response: Response,
  object: {
    AcceptRanges?: string;
    CacheControl?: string;
    ContentLength?: number;
    ContentRange?: string;
    ContentType?: string;
    ETag?: string;
    LastModified?: Date;
  },
): void {
  response.setHeader('Accept-Ranges', object.AcceptRanges || 'bytes');
  response.setHeader('Cache-Control', object.CacheControl || getConfig().s3.cacheControl);
  response.setHeader('X-Content-Type-Options', 'nosniff');

  if (object.ContentType) {
    response.setHeader('Content-Type', object.ContentType);
  }
  if (object.ContentLength !== undefined) {
    response.setHeader('Content-Length', object.ContentLength.toString());
  }
  if (object.ContentRange) {
    response.setHeader('Content-Range', object.ContentRange);
  }
  if (object.ETag) {
    response.setHeader('ETag', object.ETag);
  }
  if (object.LastModified) {
    response.setHeader('Last-Modified', object.LastModified.toUTCString());
  }
}

function handleStorageReadError(error: unknown, next: NextFunction): void {
  if (error instanceof HttpError) {
    next(error);
    return;
  }

  if (isObjectNotFound(error)) {
    next(new HttpError('File not found', 404));
    return;
  }

  if (isRangeNotSatisfiable(error)) {
    next(new HttpError('Requested byte range is not satisfiable', 416));
    return;
  }

  console.error('Object storage read failed', error);
  next(new HttpError('Object storage is temporarily unavailable', 502));
}

export async function getStoredFile(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const range = parseByteRange(req.header('Range'));
    const object = await getObjectStorage().getObject(getObjectKey(req), range);

    if (!object.Body || !(object.Body instanceof Readable)) {
      throw new Error('S3 returned an unreadable response body');
    }

    applyObjectHeaders(res, object);
    res.status(object.ContentRange ? 206 : 200);
    await pipeline(object.Body, res);
  } catch (error) {
    if (res.headersSent) {
      next(error);
      return;
    }

    handleStorageReadError(error, next);
  }
}

export async function headStoredFile(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const object = await getObjectStorage().headObject(getObjectKey(req));
    applyObjectHeaders(res, object);
    res.status(200).end();
  } catch (error) {
    handleStorageReadError(error, next);
  }
}
