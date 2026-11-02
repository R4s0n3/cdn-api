import { isZipMimeType, validateZipFile } from './zip-files';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { v7 as uuidV7 } from 'uuid';

import { getConfig } from '../config';
import HttpError from '../models/http-error';
import { getUploadTempDirectory } from './upload-staging';
export { getUploadTempDirectory } from './upload-staging';

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

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    const uploadTempDir = getUploadTempDirectory();
    fs.mkdir(uploadTempDir, { recursive: true }, (error) => {
      callback(error, uploadTempDir);
    });
  },
  filename: (_req, file, callback) => {
    const mimeToExtension: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'application/pdf': 'pdf',
      'application/zip': 'zip',
      'application/x-zip-compressed': 'zip',
    };
    const extension = mimeToExtension[file.mimetype];

    callback(null, `${uuidV7()}.${extension}`);
  },
});

const fileFilter = (
  _req: Express.Request,
  file: Express.Multer.File,
  callback: multer.FileFilterCallback,
) => {
  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'application/pdf',
    'application/zip',
    'application/x-zip-compressed',
  ];

  if (allowedTypes.includes(file.mimetype)) {
    callback(null, true);
  } else {
    callback(
      new HttpError('Only JPEG, PNG, PDF, and ZIP files are allowed', 415),
    );
  }
};

export const upload = multer({
  storage,
  limits: {
    fieldSize: 64 * 1024,
    fields: 10,
    fileSize: 50 * 1024 * 1024,
    files: 5,
    parts: 15,
  },
  fileFilter,
});

/** Verify JPEG, PNG, PDF, or ZIP signatures before sending staged content to S3. */
export async function validateFileContents(
  file: Express.Multer.File,
): Promise<void> {
  if (isZipMimeType(file.mimetype)) return validateZipFile(file);
  const handle = await fsPromises.open(file.path, 'r');
  const header = Buffer.alloc(8);

  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    const isValid =
      (file.mimetype === 'image/jpeg' &&
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff) ||
      (file.mimetype === 'image/png' &&
        bytes.length >= 8 &&
        bytes.equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )) ||
      (file.mimetype === 'application/pdf' &&
        bytes.length >= 5 &&
        bytes.subarray(0, 5).toString('ascii') === '%PDF-');

    if (!isValid) {
      throw new HttpError('File content does not match its declared type', 415);
    }
  } finally {
    await handle.close();
  }
}

/** Attempt cleanup of every staged file and report failures other than already missing files. */
export async function removeTempFiles(
  files: Express.Multer.File[],
): Promise<void> {
  const results = await Promise.allSettled(
    files.map((file) => fsPromises.unlink(file.path)),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected' &&
      (result.reason as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT',
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Failed to remove ${failures.length} temporary upload file(s)`,
    );
  }
}

/** Preserve the legacy salted cluster algorithm used in existing object paths. */
export function getHashedCluster(
  str1: string,
  str2: string,
  saltStr: string = getConfig().saltString,
): string {
  const combined = str1 + str2 + saltStr;
  let hash = 2166136261;

  for (let index = 0; index < combined.length; index += 1) {
    hash ^= combined.charCodeAt(index);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  hash = hash >>> 0;
  return hash.toString(36).padStart(12, '0').slice(0, 12);
}
