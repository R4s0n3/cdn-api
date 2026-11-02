import { open } from 'node:fs/promises';
import HttpError from '../models/http-error';

export function isZipMimeType(mimetype: string): boolean {
  return (
    mimetype === 'application/zip' ||
    mimetype === 'application/x-zip-compressed'
  );
}

/** Check ZIP signatures without extracting untrusted archive contents. */
export async function validateZipFile(
  file: Pick<Express.Multer.File, 'path' | 'mimetype'>,
): Promise<void> {
  if (!isZipMimeType(file.mimetype)) return;
  const handle = await open(file.path, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== 4 ||
      !['504b0304', '504b0506', '504b0708'].includes(header.toString('hex'))
    ) {
      throw new HttpError(
        'File content does not match its declared ZIP type',
        415,
      );
    }
  } finally {
    await handle.close();
  }
}
