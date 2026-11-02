import { type File as FileModel } from '@prisma/client';
import { type NextFunction, type Request, type Response } from 'express';

import { getConfig } from '../config';
import { db } from '../db';
import HttpError from '../models/http-error';
import {
  buildObjectKey,
  buildStorageUrl,
  getObjectStorage,
} from '../storage/s3-storage';
import {
  getHashedCluster,
  removeTempFiles,
  validateFileContents,
} from '../util/upload-functions';

type FileRecordInput = {
  appKey: string;
  createdById: string;
  fileName: string;
  mimeType: string;
  originalName: string;
  size: number;
  url: string;
};

function getAuth(request: Request): NonNullable<Request['auth']> {
  if (!request.auth) {
    throw new HttpError('Invalid API-KEY', 403);
  }

  return request.auth;
}

async function rollbackObjects(objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) {
    return;
  }

  try {
    await getObjectStorage().deleteObjects(objectKeys);
  } catch (error) {
    console.error('Storage reconciliation required', {
      error,
      objectKeys: [...objectKeys],
      reason: 'Failed to delete objects during upload rollback',
    });
  }
}

async function cleanupTempFiles(files: Express.Multer.File[]): Promise<void> {
  try {
    await removeTempFiles(files);
  } catch (error) {
    console.error('Failed to clean up temporary upload files', error);
  }
}

function retainObjectsForReconciliation(
  objectKeys: string[],
  reason: string,
  error?: unknown,
): void {
  console.error('Storage reconciliation required', {
    error,
    objectKeys: [...objectKeys],
    reason,
  });
  objectKeys.length = 0;
}

function mapUploadError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  console.error('Object storage upload failed', error);
  return new HttpError('Object storage is temporarily unavailable', 502);
}

function toFileRecord(
  file: Express.Multer.File,
  apiKey: string,
  userId: string,
  cluster: string,
): FileRecordInput & { objectKey: string } {
  const config = getConfig();

  return {
    appKey: apiKey,
    createdById: userId,
    fileName: file.filename,
    mimeType: file.mimetype,
    objectKey: buildObjectKey(cluster, file.filename, config.s3.keyPrefix),
    originalName: file.originalname,
    size: file.size,
    url: buildStorageUrl(cluster, file.filename, config.s3),
  };
}

const uploadControllers = {
  getHealth: (_req: Request, res: Response): void => {
    res.status(200).send('online');
  },

  uploadFile: async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const file = req.file;

    if (!file) {
      next(new HttpError('No file uploaded', 400));
      return;
    }

    const uploadedObjectKeys: string[] = [];

    try {
      const { apiKey, userId } = getAuth(req);
      await validateFileContents(file);

      const cluster = getHashedCluster(apiKey, userId);
      const { objectKey, ...record } = toFileRecord(file, apiKey, userId, cluster);

      uploadedObjectKeys.push(objectKey);
      await getObjectStorage().uploadFile(objectKey, file);

      let createdFile: FileModel;
      try {
        createdFile = await db.file.create({ data: record });
      } catch (error) {
        console.error('Failed to save uploaded file metadata', error);

        try {
          const committedFile = await db.file.findUnique({
            where: { fileName: record.fileName },
          });

          if (committedFile) {
            createdFile = committedFile;
            console.warn('Recovered an upload after an ambiguous database response', {
              fileName: record.fileName,
            });
          } else {
            await rollbackObjects(uploadedObjectKeys);
            uploadedObjectKeys.length = 0;
            throw new HttpError('Failed to save file metadata', 500);
          }
        } catch (verificationError) {
          if (verificationError instanceof HttpError) {
            throw verificationError;
          }

          retainObjectsForReconciliation(
            uploadedObjectKeys,
            'Could not determine whether single-file metadata committed',
            verificationError,
          );
          throw new HttpError('Failed to confirm file metadata', 500);
        }
      }
      uploadedObjectKeys.length = 0;

      res.status(200).json({
        message: 'File uploaded successfully',
        files: [
          {
            id: createdFile.id,
            filename: file.filename,
            originalName: file.originalname,
            size: file.size,
            mimetype: file.mimetype,
            url: record.url,
          },
        ],
      });
    } catch (error) {
      await rollbackObjects(uploadedObjectKeys);
      next(mapUploadError(error));
    } finally {
      await cleanupTempFiles([file]);
    }
  },

  bulkUpload: async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    if (files.length === 0) {
      next(new HttpError('No files uploaded', 400));
      return;
    }

    const uploadedObjectKeys: string[] = [];

    try {
      const { apiKey, userId } = getAuth(req);
      const cluster = getHashedCluster(apiKey, userId);

      for (const file of files) {
        await validateFileContents(file);
      }

      const records = files.map((file) => toFileRecord(file, apiKey, userId, cluster));

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const record = records[index];

        if (!file || !record) {
          throw new HttpError('Invalid bulk upload state', 500);
        }

        uploadedObjectKeys.push(record.objectKey);
        await getObjectStorage().uploadFile(record.objectKey, file);
      }

      try {
        await db.$transaction(async (prisma) => {
          await prisma.file.createMany({
            data: records.map(({ objectKey: _objectKey, ...record }) => record),
          });
        });
      } catch (error) {
        console.error('Failed to save bulk upload metadata', error);

        try {
          const committedFiles = await db.file.findMany({
            where: {
              fileName: {
                in: records.map((record) => record.fileName),
              },
            },
            select: { fileName: true },
          });

          if (committedFiles.length === records.length) {
            console.warn('Recovered a bulk upload after an ambiguous database response', {
              fileNames: committedFiles.map((fileRecord) => fileRecord.fileName),
            });
          } else if (committedFiles.length === 0) {
            await rollbackObjects(uploadedObjectKeys);
            uploadedObjectKeys.length = 0;
            throw new HttpError('Failed to save file metadata', 500);
          } else {
            retainObjectsForReconciliation(
              uploadedObjectKeys,
              'Only part of the bulk metadata was visible after a database error',
              error,
            );
            throw new HttpError('Failed to confirm all file metadata', 500);
          }
        } catch (verificationError) {
          if (verificationError instanceof HttpError) {
            throw verificationError;
          }

          retainObjectsForReconciliation(
            uploadedObjectKeys,
            'Could not determine whether bulk metadata committed',
            verificationError,
          );
          throw new HttpError('Failed to confirm file metadata', 500);
        }
      }
      uploadedObjectKeys.length = 0;

      res.status(200).json({
        message: 'Files uploaded successfully',
        files: records.map((record) => ({
          filename: record.fileName,
          originalName: record.originalName,
          size: record.size,
          mimetype: record.mimeType,
          url: record.url,
        })),
      });
    } catch (error) {
      await rollbackObjects(uploadedObjectKeys);
      next(mapUploadError(error));
    } finally {
      await cleanupTempFiles(files);
    }
  },
};

export default uploadControllers;
