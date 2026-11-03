import { type Request, type Response, type NextFunction } from 'express';
import { db } from '../db';
import HttpError from '../models/http-error';
import {
  getPrivateStorage,
  privateStorageLocation,
} from '../storage/private-storage';
import {
  validateFileContents,
  removeTempFiles,
} from '../util/upload-functions';

/** Stage temporarily, verify S3 privacy, then persist private objects and their exact bucket/key metadata. */
export async function uploadPrivateFiles(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const files = req.file
    ? [req.file]
    : (req.files as Express.Multer.File[] | undefined) || [];
  const attempted: string[] = [];
  let rollback: (() => Promise<void>) | undefined;
  try {
    if (!req.auth) throw new HttpError('Unauthorized', 401);
    if (!files.length) throw new HttpError('No file uploaded', 400);
    for (const file of files) await validateFileContents(file);
    const locations = files.map((file) =>
      privateStorageLocation(file.filename),
    );
    const storage = getPrivateStorage(locations[0].bucket);
    rollback = () => storage.deleteObjects(attempted);
    await storage.verifyPrivateAccess();
    for (let index = 0; index < files.length; index++) {
      attempted.push(locations[index].key);
      await storage.uploadFile(locations[index].key, files[index]);
    }
    const records = files.map((file, index) => ({
      fileName: file.filename,
      originalName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
      url: `/private/${file.filename}`,
      isPublic: false,
      privateBucket: locations[index].bucket,
      privateObjectKey: locations[index].key,
    }));
    let saved;
    try {
      saved = await db.$transaction(async (tx) =>
        Promise.all(records.map((data) => tx.file.create({ data }))),
      );
    } catch {
      // Never delete data when an interrupted commit might already have saved metadata.
      try {
        saved = await db.file.findMany({
          where: { fileName: { in: records.map((record) => record.fileName) } },
        });
        if (
          saved.length !== records.length ||
          saved.some(
            (file) =>
              file.isPublic ||
              !records.some(
                (record) =>
                  record.fileName === file.fileName &&
                  record.privateBucket === file.privateBucket &&
                  record.privateObjectKey === file.privateObjectKey,
              ),
          )
        ) {
          if (saved.length > 0) rollback = undefined;
          throw new HttpError(
            'Could not confirm private file metadata. Please refresh the library.',
            502,
          );
        }
      } catch (error) {
        if (!(error instanceof HttpError)) rollback = undefined;
        throw error;
      }
    }
    rollback = undefined;
    res.json({
      files: saved.map((file) => ({
        id: file.id,
        isPublic: false,
        filename: file.fileName,
        originalName: file.originalName,
        size: file.size,
        mimetype: file.mimeType,
        url: file.url,
      })),
    });
  } catch (error) {
    if (rollback && attempted.length)
      await rollback().catch(() =>
        console.error('Private S3 upload requires reconciliation', {
          objectKeys: attempted,
        }),
      );
    next(
      error instanceof HttpError
        ? error
        : new HttpError(
            'Private S3 upload failed. Verify that the bucket blocks anonymous reads and listings.',
            503,
          ),
    );
  } finally {
    await removeTempFiles(files).catch(() =>
      console.error('Failed to remove temporary private-upload staging files'),
    );
  }
}
