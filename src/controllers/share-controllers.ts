import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { getConfig } from '../config';
import { db } from '../db';
import HttpError from '../models/http-error';
import {
  buildObjectKey,
  getObjectStorage,
  isObjectNotFound,
  isRangeNotSatisfiable,
} from '../storage/s3-storage';
import { parseByteRange } from './storage-controllers';
import {
  resolveAssetFile,
  resolveStorageFile,
  resolvePrivateFile,
} from '../util/paths';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
const noShare = (): HttpError =>
  new HttpError('This share is unavailable, expired, or revoked.', 404);

/** Never permit bearer links or download responses to be stored in shared caches. */
export function privateShareHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

/** Create a bounded share and persist only its token hash and selected file revisions. */
export async function createShare(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw new HttpError('Unauthorized', 401);
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(120),
        fileIds: z.array(z.string().min(1).max(100)).min(1).max(50),
        expiresInDays: z
          .union([z.literal(1), z.literal(7), z.literal(30)])
          .default(7),
      })
      .safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(
        'Choose 1–50 files, a title, and an expiry of 1, 7, or 30 days.',
        400,
      );
    const ids = [...new Set(parsed.data.fileIds)];
    const files = await db.file.findMany({
      where: { id: { in: ids }, deletedAt: null },
    });
    if (files.length !== ids.length)
      throw new HttpError('Some selected files are no longer available.', 404);
    const token = randomBytes(32).toString('base64url');
    const share = await db.mediaShare.create({
      data: {
        title: parsed.data.title,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + parsed.data.expiresInDays * 86400000),
        files: {
          create: files.map((file) => ({
            fileId: file.id,
            name: file.originalName || file.fileName,
            size: file.size,
            fileUpdatedAt: file.updatedAt,
          })),
        },
      },
      select: { id: true, title: true, expiresAt: true },
    });
    res.status(201).json({ ...share, token });
  } catch (error) {
    next(error);
  }
}

/** List share metadata for owner management without disclosing stored bearer tokens. */
export async function listShares(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw new HttpError('Unauthorized', 401);
    const page = z.coerce
      .number()
      .int()
      .min(0)
      .max(100000)
      .safeParse(req.query.page ?? 0);
    if (!page.success) throw new HttpError('Invalid page', 400);
    const [shares, total] = await Promise.all([
      db.mediaShare.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        skip: page.data * 20,
        select: {
          id: true,
          title: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
          _count: { select: { files: true } },
        },
      }),
      db.mediaShare.count(),
    ]);
    res.json({
      shares: shares.map(({ _count, ...share }) => ({
        ...share,
        fileCount: _count.files,
      })),
      total,
    });
  } catch (error) {
    next(error);
  }
}

/** Invalidate a bearer share without deleting any source files. */
export async function revokeShare(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw new HttpError('Unauthorized', 401);
    const id = z.string().min(1).max(100).safeParse(req.params.id);
    if (!id.success) throw new HttpError('Invalid share ID', 400);
    const result = await db.mediaShare.updateMany({
      where: { id: id.data, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (
      result.count === 0 &&
      !(await db.mediaShare.findUnique({
        where: { id: id.data },
        select: { id: true },
      }))
    )
      throw noShare();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

async function activeShare(req: Request) {
  const token = req.params.token;
  if (typeof token !== 'string' || !TOKEN.test(token)) throw noShare();
  const share = await db.mediaShare.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { files: { include: { file: true }, orderBy: { name: 'asc' } } },
  });
  if (!share || share.revokedAt || share.expiresAt.getTime() <= Date.now())
    throw noShare();
  return share;
}

/** Expose only selected filenames and sizes; never leak the public source permalinks. */
export async function getShare(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const share = await activeShare(req);
    res.json({
      title: share.title,
      expiresAt: share.expiresAt,
      files: share.files.map((link) => ({
        id: link.fileId,
        name: link.name,
        size: link.size,
        available:
          !link.file.deletedAt &&
          link.file.updatedAt.getTime() === link.fileUpdatedAt.getTime(),
      })),
    });
  } catch (error) {
    next(error);
  }
}

/** Stream only an unchanged file belonging to a live share, always as a download attachment. */
export async function downloadShareFile(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const share = await activeShare(req);
    const link = share.files.find(
      (entry) => entry.fileId === req.params.fileId,
    );
    if (
      !link ||
      link.file.deletedAt ||
      link.file.updatedAt.getTime() !== link.fileUpdatedAt.getTime()
    )
      throw noShare();
    const file = link.file;
    const filename =
      path
        .basename(link.name.replace(/\\/g, '/'))
        .replace(/[\x00-\x1f\x7f]/g, '') || 'download';
    const pathname = new URL(file.url, 'http://cdn.invalid').pathname;
    const cluster = /\/([a-z0-9]{12})\/[^/]+$/.exec(pathname)?.[1];
    res.attachment(filename);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (cluster && process.env.S3_ENDPOINT) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(file.fileName) ||
        file.fileName.includes('..') ||
        !pathname.endsWith(`/${file.fileName}`)
      )
        throw noShare();
      const key = buildObjectKey(
        cluster,
        file.fileName,
        getConfig().s3.keyPrefix,
      );
      const object =
        req.method === 'HEAD'
          ? await getObjectStorage().headObject(key)
          : await getObjectStorage().getObject(
              key,
              parseByteRange(req.header('Range')),
            );
      if (req.method === 'HEAD') {
        res.setHeader('Accept-Ranges', 'bytes');
        if (object.ContentLength !== undefined)
          res.setHeader('Content-Length', String(object.ContentLength));
        res.end();
        return;
      }
      if (!('Body' in object) || !(object.Body instanceof Readable))
        throw new Error('Unreadable storage response');
      res.setHeader('Accept-Ranges', 'bytes');
      if (object.ContentLength !== undefined)
        res.setHeader('Content-Length', String(object.ContentLength));
      if ('ContentRange' in object && typeof object.ContentRange === 'string') {
        res.status(206);
        res.setHeader('Content-Range', object.ContentRange);
      }
      await pipeline(object.Body, res);
      return;
    }
    let absolute: string | null = null;
    if (!file.isPublic && pathname === `/private/${file.fileName}`)
      absolute = resolvePrivateFile(file.fileName);
    else if (pathname === `/storage/${file.fileName}`)
      absolute = resolveStorageFile(file.fileName);
    else if (pathname === `/assets/${file.fileName}`)
      absolute = resolveAssetFile(file.fileName.split('/'));
    if (!absolute) throw noShare();
    res.sendFile(
      absolute,
      {
        cacheControl: false,
        lastModified: false,
        headers: {
          'Cache-Control': 'private, no-store, max-age=0',
          'Content-Type': 'application/octet-stream',
        },
      },
      (error) => {
        if (error) next(error);
      },
    );
  } catch (error) {
    next(
      isObjectNotFound(error)
        ? noShare()
        : isRangeNotSatisfiable(error)
          ? new HttpError('Requested byte range is not satisfiable', 416)
          : error,
    );
  }
}
