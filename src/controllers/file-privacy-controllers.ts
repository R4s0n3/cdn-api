import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { getConfig } from '../config';
import { db } from '../db';
import HttpError from '../models/http-error';
import { buildObjectKey, getObjectStorage } from '../storage/s3-storage';
import {
  privateStorageDirectory,
  resolvePrivateFile,
  resolveStorageFile,
  resolveAssetFile,
} from '../util/paths';

/** Move an explicitly selected public file behind owner/share access; retain private copies on retryable failures. */
export async function makeFilePrivate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let temporary: string | undefined;
  try {
    if (!req.auth) throw new HttpError('Unauthorized', 401);
    const id = z.string().min(1).max(100).safeParse(req.params.id);
    if (!id.success) throw new HttpError('Invalid file ID', 400);
    const file = await db.file.findFirst({
      where: { id: id.data, deletedAt: null },
    });
    if (!file) throw new HttpError('File not found', 404);
    if (!file.isPublic) {
      res.json({ success: true });
      return;
    }
    const extension = path.extname(file.fileName);
    const name = `private-${createHash('sha256').update(`${file.id}:${file.updatedAt.toISOString()}`).digest('hex')}${/^\.[a-zA-Z0-9]{1,12}$/.test(extension) ? extension : '.bin'}`;
    const destination = path.join(privateStorageDirectory(), name);
    const pathname = new URL(file.url, 'http://cdn.invalid').pathname;
    const cluster = /\/([a-z0-9]{12})\/[^/]+$/.exec(pathname)?.[1];
    let objectKey: string | undefined;
    let diskSource: string | null = null;
    if (cluster && process.env.S3_ENDPOINT) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(file.fileName) ||
        file.fileName.includes('..') ||
        !pathname.endsWith(`/${file.fileName}`)
      )
        throw new HttpError('Unsupported file path', 400);
      objectKey = buildObjectKey(
        cluster,
        file.fileName,
        getConfig().s3.keyPrefix,
      );
    } else if (pathname === `/storage/${file.fileName}`)
      diskSource = resolveStorageFile(file.fileName);
    else if (pathname === `/assets/${file.fileName}`)
      diskSource = resolveAssetFile(file.fileName.split('/'));
    else throw new HttpError('Unsupported file path', 400);
    // A deterministic destination permits recovery if deletion succeeded but the DB update failed.
    if (!resolvePrivateFile(name)) {
      temporary = `${destination}.${randomUUID()}.incoming`;
      let input: Readable;
      if (objectKey) {
        const object = await getObjectStorage().getObject(objectKey);
        if (!(object.Body instanceof Readable))
          throw new Error('Unreadable object');
        input = object.Body;
      } else {
        if (!diskSource) throw new HttpError('File not found', 404);
        input = createReadStream(diskSource);
      }
      await pipeline(
        input,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
      await fs.rename(temporary, destination);
      temporary = undefined;
    }
    const unchanged = await db.file.findFirst({
      where: {
        id: file.id,
        deletedAt: null,
        isPublic: true,
        updatedAt: file.updatedAt,
      },
      select: { id: true },
    });
    if (!unchanged)
      throw new HttpError('File changed. Refresh and try again.', 409);
    // Remove the public origin copy before reporting private storage. Cached copies cannot be recalled.
    if (objectKey) await getObjectStorage().deleteObjects([objectKey]);
    else if (diskSource) {
      try {
        await fs.unlink(diskSource);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const changed = await db.file.updateMany({
      where: {
        id: file.id,
        deletedAt: null,
        isPublic: true,
        updatedAt: file.updatedAt,
      },
      data: { fileName: name, url: `/private/${name}`, isPublic: false },
    });
    if (changed.count !== 1)
      throw new HttpError('File changed. Refresh and try again.', 409);
    res.json({ success: true });
  } catch (error) {
    next(
      error instanceof HttpError
        ? error
        : new HttpError(
            'Could not finish making this file private. Please retry.',
            502,
          ),
    );
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
  }
}
