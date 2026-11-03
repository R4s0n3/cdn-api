import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { type Request, type Response } from 'express';
import HttpError from '../models/http-error';
import { getPrivateStorage } from './private-storage';
import { parseByteRange } from '../controllers/storage-controllers';
import { isObjectNotFound, isRangeNotSatisfiable } from './s3-storage';

/** Stream exact private S3 objects through an authorized owner or share request. */
export async function streamPrivateObject(
  req: Request,
  res: Response,
  file: {
    privateBucket: string;
    privateObjectKey: string;
    name: string;
    mimeType: string;
  },
  preview = false,
): Promise<void> {
  try {
    const storage = getPrivateStorage(file.privateBucket);
    const object =
      req.method === 'HEAD'
        ? await storage.headObject(file.privateObjectKey)
        : await storage.getObject(
            file.privateObjectKey,
            parseByteRange(req.header('Range')),
          );
    if (
      req.method !== 'HEAD' &&
      (!('Body' in object) || !(object.Body instanceof Readable))
    )
      throw new Error('Unreadable private S3 object');
    const safeName =
      path
        .basename(file.name.replace(/\\/g, '/'))
        .replace(/[\x00-\x1f\x7f]/g, '') || 'download';
    res.attachment(safeName);
    const inline =
      preview &&
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
        file.mimeType,
      );
    if (inline) res.setHeader('Content-Disposition', 'inline');
    res.setHeader(
      'Content-Type',
      inline ? file.mimeType : 'application/octet-stream',
    );
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Accept-Ranges', 'bytes');
    if (object.ContentLength !== undefined)
      res.setHeader('Content-Length', String(object.ContentLength));
    if ('ContentRange' in object && typeof object.ContentRange === 'string') {
      res.status(206);
      res.setHeader('Content-Range', object.ContentRange);
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    if ('Body' in object && object.Body instanceof Readable)
      await pipeline(object.Body, res);
  } catch (error) {
    if (isObjectNotFound(error)) throw new HttpError('File not found', 404);
    if (isRangeNotSatisfiable(error))
      throw new HttpError('Requested byte range is not satisfiable', 416);
    throw error;
  }
}
