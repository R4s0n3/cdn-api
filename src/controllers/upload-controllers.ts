import type { NextFunction, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import HttpError from '../models/http-error';
import { mimeMatchesExtension } from '../util/content-types';
import { resolveAssetTarget } from '../util/paths';

async function removeFiles(files: Array<{ path: string }> | undefined) {
  if (!files) return;
  await Promise.all(files.map(async (file) => {
    try {
      await fs.unlink(file.path);
    } catch {
      console.error('failed to delete upload', { path: file.path });
    }
  }));
}

async function publishAsset(tmpPath: string, absolute: string, beforePublish: () => Promise<void>) {
  const dir = path.dirname(absolute);
  await fs.mkdir(dir, { recursive: true });
  const incoming = path.join(dir, `.${path.basename(absolute)}.${process.pid}.${Date.now()}.incoming`);
  try {
    await fs.copyFile(tmpPath, incoming);
    await beforePublish();
    await fs.rename(incoming, absolute);
  } catch (error) {
    await fs.unlink(incoming).catch(() => undefined);
    throw error;
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}

function assetPathFromRequest(req: Request): string {
  if (typeof req.body?.path === 'string' && req.body.path.trim()) return req.body.path;
  if (typeof req.query.path === 'string' && req.query.path.trim()) return req.query.path;
  return '';
}

function storedFile(file: Express.Multer.File) {
  return {
    originalName: file.originalname,
    fileName: file.filename,
    size: file.size,
    mimeType: file.mimetype,
    url: `/storage/${file.filename}`,
  };
}

const uploadControllers = {
  getHealth: ((_req: Request, res: Response) => {
    res.status(200).send('online');
  }),
  uploadFile: (async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) {
      next(new HttpError('No file uploaded', 400));
      return;
    }

    const record = storedFile(req.file);
    try {
      const createdFile = await db.file.create({
        data: record,
      });
      res.status(200).json({
        message: 'File uploaded successfully',
        files: [{
          id: createdFile.id,
          filename: req.file.filename,
          originalName: req.file.originalname,
          size: req.file.size,
          mimetype: req.file.mimetype,
          url: record.url,
        }],
      });
    } catch {
      console.error('upload metadata write failed');
      await removeFiles([req.file]);
      next(new HttpError('Failed to save files to database', 500));
    }
  }),
  bulkUpload: (async (req: Request, res: Response, next: NextFunction) => {
    const uploaded = req.files as Express.Multer.File[] | undefined;
    if (!uploaded || uploaded.length === 0) {
      next(new HttpError('No files uploaded', 400));
      return;
    }

    const files = uploaded.map(storedFile);
    try {
      await db.$transaction(async (prisma) => {
        await prisma.file.createMany({
          data: files,
        });
      });
      res.status(200).json({
        message: 'Files uploaded successfully',
        files: files.map(({ fileName, originalName, size, mimeType, url }) => ({
          filename: fileName,
          originalName,
          size,
          mimetype: mimeType,
          url,
        })),
      });
    } catch {
      console.error('bulk upload metadata write failed');
      await removeFiles(uploaded);
      next(new HttpError('Failed to save files to database', 500));
    }
  }),
  uploadAsset: (async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) {
      next(new HttpError('No file uploaded', 400));
      return;
    }

    const uploaded = req.file;
    try {
      const target = resolveAssetTarget(assetPathFromRequest(req));
      const extension = path.extname(target.relative);
      if (!mimeMatchesExtension(uploaded.mimetype, extension)) {
        await removeFiles([uploaded]);
        next(new HttpError('File type does not match the asset path.', 400));
        return;
      }

      let savedId = '';
      await publishAsset(uploaded.path, target.absolute, async () => {
        const data = {
          originalName: uploaded.originalname,
          fileName: target.relative,
          size: uploaded.size,
          mimeType: uploaded.mimetype,
          url: target.url,
        };
        const existing = await db.file.findFirst({
          where: { url: target.url },
          select: { id: true },
        });
        if (existing) {
          const updated = await db.file.update({
            where: { id: existing.id },
            data: { ...data, deletedAt: null },
            select: { id: true },
          });
          savedId = updated.id;
          return;
        }
        const created = await db.file.create({
          data,
          select: { id: true },
        });
        savedId = created.id;
      });

      res.status(200).json({
        message: 'File uploaded successfully',
        files: [{
          id: savedId,
          filename: path.basename(target.relative),
          originalName: uploaded.originalname,
          size: uploaded.size,
          mimetype: uploaded.mimetype,
          url: target.url,
        }],
      });
    } catch (error) {
      await removeFiles([uploaded]);
      if (error instanceof HttpError) {
        next(error);
        return;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        next(new HttpError('An asset with this path already exists.', 409));
        return;
      }
      console.error('asset upload failed');
      next(new HttpError('Failed to save files to database', 500));
    }
  }),
};

export default uploadControllers;
