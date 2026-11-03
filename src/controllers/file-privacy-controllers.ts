import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
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
} from '../storage/s3-storage';
import {
  getPrivateStorage,
  privateStorageLocation,
} from '../storage/private-storage';
import { getUploadTempDirectory } from '../util/upload-staging';
import {
  resolvePrivateFile,
  resolveStorageFile,
  resolveAssetFile,
} from '../util/paths';

/** Move public files or legacy private disk copies into verified private S3 storage without changing file contents. */
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
    if (!file.isPublic && file.privateBucket && file.privateObjectKey) {
      res.json({ success: true });
      return;
    }
    const extension = path.extname(file.fileName);
    const name = `private-${createHash('sha256').update(`${file.id}:${file.updatedAt.toISOString()}`).digest('hex')}${/^\.[a-zA-Z0-9]{1,12}$/.test(extension) ? extension : '.bin'}`;
    const destination = privateStorageLocation(name);
    const storage = getPrivateStorage(destination.bucket);
    await storage.verifyPrivateAccess();
    const pathname = new URL(file.url, 'http://cdn.invalid').pathname;
    const cluster = /\/([a-z0-9]{12})\/[^/]+$/.exec(pathname)?.[1];
    let sourceKey: string | undefined;
    let diskSource: string | null = null;
    if (file.isPublic && cluster && process.env.S3_ENDPOINT) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(file.fileName) ||
        file.fileName.includes('..') ||
        !pathname.endsWith(`/${file.fileName}`)
      )
        throw new HttpError('Unsupported file path', 400);
      sourceKey = buildObjectKey(
        cluster,
        file.fileName,
        getConfig().s3.keyPrefix,
      );
    } else if (!file.isPublic && pathname === `/private/${file.fileName}`)
      diskSource = resolvePrivateFile(file.fileName);
    else if (pathname === `/storage/${file.fileName}`)
      diskSource = resolveStorageFile(file.fileName);
    else if (pathname === `/assets/${file.fileName}`)
      diskSource = resolveAssetFile(file.fileName.split('/'));
    else throw new HttpError('Unsupported file path', 400);
    let copied = false;
    try {
      await storage.headObject(destination.key);
      copied = true;
    } catch (error) {
      if (!isObjectNotFound(error)) throw error;
    }
    if (!copied) {
      await fs.mkdir(getUploadTempDirectory(), { recursive: true });
      temporary = path.join(
        getUploadTempDirectory(),
        `${randomUUID()}${/^\.[a-zA-Z0-9]{1,12}$/.test(extension) ? extension : '.bin'}`,
      );
      let input: Readable;
      if (sourceKey) {
        const object = await getObjectStorage().getObject(sourceKey);
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
      const stat = await fs.stat(temporary);
      await storage.uploadFile(destination.key, {
        path: temporary,
        size: stat.size,
        mimetype: file.mimeType,
      });
    }
    const unchanged = await db.file.findFirst({
      where: { id: file.id, deletedAt: null, updatedAt: file.updatedAt },
      select: { id: true },
    });
    if (!unchanged)
      throw new HttpError('File changed. Refresh and try again.', 409);
    if (sourceKey) await getObjectStorage().deleteObjects([sourceKey]);
    else if (diskSource) {
      try {
        await fs.unlink(diskSource);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    // Preserve the content revision so existing shares keep working after a storage-only move.
    const changed = await db.file.updateMany({
      where: { id: file.id, deletedAt: null, updatedAt: file.updatedAt },
      data: {
        fileName: name,
        url: `/private/${name}`,
        isPublic: false,
        privateBucket: destination.bucket,
        privateObjectKey: destination.key,
        updatedAt: file.updatedAt,
      },
    });
    if (changed.count !== 1)
      throw new HttpError('File changed. Refresh and try again.', 409);
    res.json({ success: true });
  } catch (error) {
    next(
      error instanceof HttpError
        ? error
        : new HttpError(
            'Could not finish moving this file to private S3 storage. Please retry.',
            502,
          ),
    );
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
  }
}
