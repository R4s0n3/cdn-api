import { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { getConfig } from '../config';
import { db } from '../db';
import HttpError from '../models/http-error';
import { buildObjectKey, getObjectStorage } from '../storage/s3-storage';
import { getHashedCluster } from '../util/upload-functions';

export async function listMedia(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw new HttpError('Unauthorized', 401);
    const parsed = z.object({
      search: z.string().trim().max(200).default(''),
      page: z.coerce.number().int().min(0).max(100000).default(0),
    }).safeParse(req.query);
    if (!parsed.success) throw new HttpError('Invalid search or page', 400);
    const { search, page } = parsed.data;
    const where = {
      appKey: req.auth.apiKey,
      createdById: req.auth.userId,
      deletedAt: null,
      ...(search ? { originalName: { contains: search } } : {}),
    };
    const [files, total] = await Promise.all([
      db.file.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page * 24, take: 24,
        select: { id: true, originalName: true, fileName: true, size: true, mimeType: true, url: true, createdAt: true } }),
      db.file.count({ where }),
    ]);
    res.json({ files, total });
  } catch (error) { next(error); }
}

export async function deleteMedia(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw new HttpError('Unauthorized', 401);
    const id = z.string().min(1).max(100).safeParse(req.params.id);
    if (!id.success) throw new HttpError('Invalid file ID', 400);
    const file = await db.file.findFirst({ where: {
      id: id.data, appKey: req.auth.apiKey, createdById: req.auth.userId, deletedAt: null,
    } });
    if (!file?.fileName) throw new HttpError('File not found', 404);
    const cluster = getHashedCluster(req.auth.apiKey, req.auth.userId);
    await getObjectStorage().deleteObjects([buildObjectKey(cluster, file.fileName, getConfig().s3.keyPrefix)]);
    // Keep metadata if storage deletion fails, so the user can retry.
    await db.file.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (error) { next(error instanceof HttpError ? error : new HttpError('Could not delete file; please retry', 502)); }
}
