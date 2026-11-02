import { type NextFunction, type Request, type Response } from 'express';
import { unlink } from 'node:fs/promises';
import { z } from 'zod';

import { getConfig } from '../config';
import { db } from '../db';
import HttpError from '../models/http-error';
import { buildObjectKey, getObjectStorage } from '../storage/s3-storage';
import { resolveAssetFile, resolveStorageFile } from '../util/paths';

/** List active records in the dedicated CDN database with bounded search and pagination. */
export async function listMedia(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw new HttpError('Unauthorized', 401);
    const parsed = z
      .object({
        search: z.string().trim().max(200).default(''),
        page: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .safeParse(req.query);
    if (!parsed.success) throw new HttpError('Invalid search or page', 400);
    const { search, page } = parsed.data;
    // The dedicated CDN database is protected by the single CDN_API_KEY.
    const where = {
      deletedAt: null,
      ...(search ? { originalName: { contains: search } } : {}),
    };
    const [files, total] = await Promise.all([
      db.file.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: page * 24,
        take: 24,
        select: {
          id: true,
          originalName: true,
          fileName: true,
          size: true,
          mimeType: true,
          url: true,
          createdAt: true,
        },
      }),
      db.file.count({ where }),
    ]);
    res.json({ files, total });
  } catch (error) {
    next(error);
  }
}

/** Delete a managed disk or S3 file before marking its metadata deleted; preserve failures for retry. */
export async function deleteMedia(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw new HttpError('Unauthorized', 401);
    const id = z.string().min(1).max(100).safeParse(req.params.id);
    if (!id.success) throw new HttpError('Invalid file ID', 400);
    const file = await db.file.findFirst({
      where: { id: id.data, deletedAt: null },
    });
    if (!file) throw new HttpError('File not found', 404);
    const pathname = new URL(file.url, 'http://cdn.invalid').pathname;
    // Derive the stored cluster from the URL; key/salt rotation must not change deletion targets.
    const cluster = /\/([a-z0-9]{12})\/[^/]+$/.exec(pathname)?.[1];
    if (cluster && process.env.S3_ENDPOINT) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(file.fileName) ||
        file.fileName.includes('..') ||
        !pathname.endsWith(`/${file.fileName}`)
      ) {
        throw new HttpError('Invalid stored file path', 400);
      }
      await getObjectStorage().deleteObjects([
        buildObjectKey(cluster, file.fileName, getConfig().s3.keyPrefix),
      ]);
    } else {
      let target: string | null;
      if (pathname === `/storage/${file.fileName}`)
        target = resolveStorageFile(file.fileName);
      else if (pathname === `/assets/${file.fileName}`)
        target = resolveAssetFile(file.fileName.split('/'));
      else throw new HttpError('Unsupported stored file path', 400);
      // An already missing file can still have its stale metadata removed.
      if (target) await unlink(target);
    }
    await db.file.update({
      where: { id: file.id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  } catch (error) {
    next(
      error instanceof HttpError
        ? error
        : new HttpError('Could not delete file; please retry', 502),
    );
  }
}
