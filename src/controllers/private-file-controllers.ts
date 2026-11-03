import { streamPrivateObject } from '../storage/private-download';
import { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../db';
import HttpError from '../models/http-error';
import { resolvePrivateFile } from '../util/paths';

/** Serve private files only to the authenticated panel backend, with tightly scoped image previews. */
export async function downloadOwnerFile(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw new HttpError('Unauthorized', 401);
    const id = z.string().min(1).max(100).safeParse(req.params.id);
    if (!id.success) throw new HttpError('File not found', 404);
    const file = await db.file.findFirst({
      where: { id: id.data, deletedAt: null },
    });
    if (!file || file.isPublic || file.url !== `/private/${file.fileName}`)
      throw new HttpError('File not found', 404);
    if (file.privateBucket && file.privateObjectKey) {
      await streamPrivateObject(
        req,
        res,
        {
          privateBucket: file.privateBucket,
          privateObjectKey: file.privateObjectKey,
          name: file.originalName || file.fileName,
          mimeType: file.mimeType,
        },
        req.query.preview === '1',
      );
      return;
    }
    const absolute = resolvePrivateFile(file.fileName);
    if (!absolute) throw new HttpError('File not found', 404);
    const preview =
      req.query.preview === '1' &&
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
        file.mimeType,
      );
    res.attachment(file.originalName || file.fileName);
    res.setHeader(
      'Content-Type',
      preview ? file.mimeType : 'application/octet-stream',
    );
    if (preview) res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.sendFile(
      absolute,
      {
        cacheControl: false,
        lastModified: false,
        headers: { 'Cache-Control': 'private, no-store, max-age=0' },
      },
      (error) => {
        if (error) next(error);
      },
    );
  } catch (error) {
    next(error);
  }
}
