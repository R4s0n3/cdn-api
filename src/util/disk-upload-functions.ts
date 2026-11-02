import fs from 'fs';
import os from 'os';
import path from 'path';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { v7 as uuidV7 } from 'uuid';
import { maxUploadBytes } from '../config';
import { extensionForMime } from './content-types';
import { storageDirectory } from './paths';

export const uploadLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many upload requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

export const strictUploadLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: 'Hourly upload limit reached, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

function fileFilter(_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (extensionForMime(file.mimetype)) {
    cb(null, true);
    return;
  }
  cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, AVIF, SVG, and PDF files are allowed.'));
}

function uploadFileName(file: Express.Multer.File): string {
  const ext = extensionForMime(file.mimetype);
  if (!ext) {
    throw new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, AVIF, SVG, and PDF files are allowed.');
  }
  return `${uuidV7()}.${ext}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      cb(null, storageDirectory());
    } catch (error) {
      cb(error as Error, '');
    }
  },
  filename: (_req, file, cb) => {
    try {
      cb(null, uploadFileName(file));
    } catch (error) {
      cb(error as Error, '');
    }
  },
});

function uploadLimits(): multer.Options['limits'] {
  return {
    fileSize: maxUploadBytes(),
    files: 5,
    fields: 10,
    fieldSize: 1024,
  };
}

export const upload = multer({
  storage,
  limits: uploadLimits(),
  fileFilter,
});

function assetTempDir(): string {
  const dir = path.join(os.tmpdir(), 'cdn-api-uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const assetUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, assetTempDir());
    },
    filename: (_req, file, cb) => {
      try {
        const ext = extensionForMime(file.mimetype);
        if (!ext) {
          cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, AVIF, SVG, and PDF files are allowed.'), '');
          return;
        }
        cb(null, `${uuidV7()}.${ext}`);
      } catch (error) {
        cb(error as Error, '');
      }
    },
  }),
  limits: {
    ...uploadLimits(),
    files: 1,
  },
  fileFilter,
});
