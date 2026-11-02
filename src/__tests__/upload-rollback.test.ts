import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createFile: vi.fn(),
  createMany: vi.fn(),
  deleteObjects: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  transaction: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock('../config', () => ({
  getConfig: () => ({
    saltString: 'test-salt',
    s3: {
      cacheControl: 'public, max-age=31536000, immutable',
      keyPrefix: '',
    },
  }),
}));

vi.mock('../db', () => ({
  db: {
    file: {
      create: mocks.createFile,
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('../storage/s3-storage', () => ({
  buildObjectKey: (cluster: string, fileName: string, prefix: string) =>
    [prefix, cluster, fileName].filter(Boolean).join('/'),
  buildStorageUrl: (cluster: string, fileName: string) =>
    `/storage/${cluster}/${fileName}`,
  getObjectStorage: () => ({
    deleteObjects: mocks.deleteObjects,
    uploadFile: mocks.uploadFile,
  }),
}));

import uploadControllers from '../controllers/upload-controllers';

const temporaryDirectories: string[] = [];

async function createUploadedFile(fileName: string): Promise<Express.Multer.File> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdn-api-rollback-test-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, fileName);
  const contents = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  await fs.writeFile(filePath, contents);

  return {
    buffer: Buffer.alloc(0),
    destination: directory,
    encoding: '7bit',
    fieldname: 'file',
    filename: fileName,
    mimetype: 'image/jpeg',
    originalname: fileName,
    path: filePath,
    size: contents.length,
    stream: undefined as never,
  };
}

function createResponse() {
  const response = {
    json: vi.fn(),
    send: vi.fn(),
    status: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  mocks.createFile.mockResolvedValue({ id: 'file-id' });
  mocks.createMany.mockResolvedValue({ count: 2 });
  mocks.deleteObjects.mockResolvedValue(undefined);
  mocks.findMany.mockResolvedValue([]);
  mocks.findUnique.mockResolvedValue(null);
  mocks.transaction.mockImplementation(async (callback) =>
    callback({ file: { createMany: mocks.createMany } }),
  );
  mocks.uploadFile.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('upload rollback behavior', () => {
  it('deletes the attempted key when an S3 PUT has an ambiguous failure', async () => {
    const file = await createUploadedFile('single.jpg');
    mocks.uploadFile.mockRejectedValue(new Error('response lost after PUT'));
    const next = vi.fn();

    await uploadControllers.uploadFile(
      {
        auth: { apiKey: 'api-key', userId: 'user-id' },
        file,
      } as never,
      createResponse() as never,
      next,
    );

    expect(mocks.deleteObjects).toHaveBeenCalledWith([
      expect.stringMatching(/\/single\.jpg$/),
    ]);
    expect(next.mock.calls[0]?.[0]).toMatchObject({ code: 502 });
    await expect(fs.access(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('logs exact keys when rollback deletion also fails', async () => {
    const file = await createUploadedFile('rollback-failure.jpg');
    mocks.uploadFile.mockRejectedValue(new Error('upload response lost'));
    mocks.deleteObjects.mockRejectedValue(new Error('delete unavailable'));

    await uploadControllers.uploadFile(
      {
        auth: { apiKey: 'api-key', userId: 'user-id' },
        file,
      } as never,
      createResponse() as never,
      vi.fn(),
    );

    expect(console.error).toHaveBeenCalledWith(
      'Storage reconciliation required',
      expect.objectContaining({
        objectKeys: [expect.stringMatching(/\/rollback-failure\.jpg$/)],
      }),
    );
  });

  it('removes S3 data when MySQL confirms that metadata did not commit', async () => {
    const file = await createUploadedFile('database-failure.jpg');
    mocks.createFile.mockRejectedValue(new Error('database write failed'));
    mocks.findUnique.mockResolvedValue(null);
    const next = vi.fn();

    await uploadControllers.uploadFile(
      {
        auth: { apiKey: 'api-key', userId: 'user-id' },
        file,
      } as never,
      createResponse() as never,
      next,
    );

    expect(mocks.deleteObjects).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]?.[0]).toMatchObject({ code: 500 });
  });

  it('retains S3 data when the MySQL commit result cannot be determined', async () => {
    const file = await createUploadedFile('ambiguous-database.jpg');
    mocks.createFile.mockRejectedValue(new Error('commit response lost'));
    mocks.findUnique.mockRejectedValue(new Error('database still unavailable'));
    const next = vi.fn();

    await uploadControllers.uploadFile(
      {
        auth: { apiKey: 'api-key', userId: 'user-id' },
        file,
      } as never,
      createResponse() as never,
      next,
    );

    expect(mocks.deleteObjects).not.toHaveBeenCalled();
    expect(next.mock.calls[0]?.[0]).toMatchObject({ code: 500 });
  });

  it('rolls back every attempted key after a partial bulk S3 failure', async () => {
    const firstFile = await createUploadedFile('first.jpg');
    const secondFile = await createUploadedFile('second.jpg');
    mocks.uploadFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second upload failed'));
    const next = vi.fn();

    await uploadControllers.bulkUpload(
      {
        auth: { apiKey: 'api-key', userId: 'user-id' },
        files: [firstFile, secondFile],
      } as never,
      createResponse() as never,
      next,
    );

    expect(mocks.deleteObjects).toHaveBeenCalledWith([
      expect.stringMatching(/\/first\.jpg$/),
      expect.stringMatching(/\/second\.jpg$/),
    ]);
    expect(next.mock.calls[0]?.[0]).toMatchObject({ code: 502 });
    await expect(fs.access(firstFile.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(secondFile.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
