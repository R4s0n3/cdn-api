import fs from 'fs';
import os from 'os';
import path from 'path';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { v7 as uuidV7 } from 'uuid';
import { maxUploadBytes } from '../config';
import { extensionForMime } from './content-types';
import { clusterDirectory } from './paths';

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
  destination: (req, _file, cb) => {
    try {
      const appKey = (req as Express.Request & { apiKey?: string }).apiKey;
      const userId = (req as Express.Request & { userId?: string }).userId;
      if (!appKey || !userId) {
        cb(new Error('Missing API key'), '');
        return;
      }
      cb(null, clusterDirectory(getHashedCluster(appKey, userId)));
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

export function getHashedCluster(str1: string, str2: string, saltStr: string = process.env.SALT_STRING || ''): string {
  if (!saltStr) {
    throw new Error('SALT_STRING is not set');
  }

  const combined = str1 + str2 + saltStr;

  // Simple hash algorithm (FNV-1a). Kept stable so existing cluster directories stay valid.
  let hash = 2166136261;

  for (let i = 0; i < combined.length; i++) {
    hash ^= combined.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  hash = hash >>> 0;

  const result = hash.toString(36).padStart(12, '0').slice(0, 12);
  return result;
}
