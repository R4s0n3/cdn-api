import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateFileContents } from '../util/upload-functions';

const temporaryDirectories: string[] = [];

async function createUploadedFile(
  bytes: Uint8Array,
  mimetype: string,
): Promise<Express.Multer.File> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdn-api-test-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'upload');
  await fs.writeFile(filePath, bytes);

  return {
    buffer: Buffer.alloc(0),
    destination: directory,
    encoding: '7bit',
    fieldname: 'file',
    filename: 'upload',
    mimetype,
    originalname: 'upload',
    path: filePath,
    size: bytes.length,
    stream: undefined as never,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe('validateFileContents', () => {
  it('accepts a PNG signature', async () => {
    const file = await createUploadedFile(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'image/png',
    );

    await expect(validateFileContents(file)).resolves.toBeUndefined();
  });

  it.each(['application/zip', 'application/x-zip-compressed'])(
    'accepts an empty ZIP archive with MIME %s',
    async (mimetype) => {
      const bytes = Buffer.alloc(22);
      bytes.writeUInt32LE(0x06054b50);
      const file = await createUploadedFile(bytes, mimetype);
      await expect(validateFileContents(file)).resolves.toBeUndefined();
    },
  );
  it('rejects a renamed non-ZIP payload', async () => {
    const file = await createUploadedFile(
      Buffer.from('not a ZIP archive'),
      'application/zip',
    );
    await expect(validateFileContents(file)).rejects.toMatchObject({
      code: 415,
    });
  });

  it('rejects a payload whose bytes do not match the declared type', async () => {
    const file = await createUploadedFile(
      Buffer.from('this is not a PDF'),
      'application/pdf',
    );

    await expect(validateFileContents(file)).rejects.toMatchObject({
      code: 415,
    });
  });
});
