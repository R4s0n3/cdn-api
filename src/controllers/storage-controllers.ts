import { isZipMimeType } from '../util/zip-files';
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

/** Accept one valid byte range and reject malformed or multipart ranges with HTTP 416. */
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

/** Validate public storage path segments before constructing an S3 object key. */
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

/** Forward safe object metadata and caching headers for successful GET and HEAD responses. */
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
  response.setHeader(
    'Cache-Control',
    object.CacheControl || getConfig().s3.cacheControl,
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');

  if (object.ContentType) {
    response.setHeader('Content-Type', object.ContentType);
    if (isZipMimeType(object.ContentType))
      response.setHeader('Content-Disposition', 'attachment');
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

/** Translate missing objects, invalid ranges, and storage outages to stable HTTP errors. */
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

/** Evaluate weak ETags before dates, following If-None-Match precedence during revalidation. */
function isFresh(
  req: Request,
  object: { ETag?: string; LastModified?: Date },
): boolean {
  const etags = req.header('If-None-Match');
  if (etags !== undefined) {
    return etags
      .split(',')
      .some(
        (value) =>
          value.trim() === '*' ||
          (object.ETag !== undefined &&
            value.trim().replace(/^W\//, '') ===
              object.ETag.replace(/^W\//, '')),
      );
  }
  const since = req.header('If-Modified-Since');
  const modifiedSince = since ? Date.parse(since) : NaN;
  return Boolean(
    object.LastModified &&
      Number.isFinite(modifiedSince) &&
      Math.floor(object.LastModified.getTime() / 1000) <=
        Math.floor(modifiedSince / 1000),
  );
}

/** Return validator headers without representation length or body for a cached object. */
function notModified(
  res: Response,
  object: { ETag?: string; LastModified?: Date; CacheControl?: string },
): void {
  res.setHeader(
    'Cache-Control',
    object.CacheControl || getConfig().s3.cacheControl,
  );
  if (object.ETag) res.setHeader('ETag', object.ETag);
  if (object.LastModified)
    res.setHeader('Last-Modified', object.LastModified.toUTCString());
  res.status(304).end();
}

/** Stream an S3 object or byte range, returning 304 before downloading unchanged data. */
export async function getStoredFile(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const key = getObjectKey(req);
    if (
      req.header('If-None-Match') !== undefined ||
      req.header('If-Modified-Since') !== undefined
    ) {
      const metadata = await getObjectStorage().headObject(key);
      if (isFresh(req, metadata)) {
        notModified(res, metadata);
        return;
      }
    }
    const range = parseByteRange(req.header('Range'));
    const object = await getObjectStorage().getObject(key, range);

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

/** Return metadata without reading the object body, including conditional revalidation. */
export async function headStoredFile(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const object = await getObjectStorage().headObject(getObjectKey(req));
    if (isFresh(req, object)) {
      notModified(res, object);
      return;
    }
    applyObjectHeaders(res, object);
    res.status(200).end();
  } catch (error) {
    handleStorageReadError(error, next);
  }
}
