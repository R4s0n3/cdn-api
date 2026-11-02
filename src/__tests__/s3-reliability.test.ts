import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { S3Storage } from '../storage/s3-storage';

const config = {
  endpoint: 'https://s3.example.com',
  region: 'test',
  bucket: 'test-bucket',
  accessKeyId: 'test',
  secretAccessKey: 'test',
  forcePathStyle: false,
  keyPrefix: '',
  maxAttempts: 3,
  cacheControl: 'public',
};
describe('S3 reliability', () => {
  it('reopens the file stream for a retry and destroys every attempt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 's3-retry-'));
    try {
      const file = path.join(root, 'file.jpg');
      await writeFile(file, 'bytes');
      const send = vi
        .fn()
        .mockRejectedValueOnce({ $metadata: { httpStatusCode: 503 } })
        .mockResolvedValueOnce({});
      const storage = new S3Storage(config, { send } as unknown as S3Client);
      await storage.uploadFile('key', {
        path: file,
        mimetype: 'image/jpeg',
        size: 5,
      });
      const first = send.mock.calls[0]?.[0].input.Body;
      const second = send.mock.calls[1]?.[0].input.Body;
      expect(first).not.toBe(second);
      expect(first.destroyed).toBe(true);
      expect(second.destroyed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not retry access-denied PUTs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 's3-denied-'));
    try {
      const file = path.join(root, 'file.jpg');
      await writeFile(file, 'bytes');
      const failure = {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      };
      const send = vi.fn().mockRejectedValue(failure);
      await expect(
        new S3Storage(config, { send } as unknown as S3Client).uploadFile(
          'key',
          { path: file, mimetype: 'image/jpeg', size: 5 },
        ),
      ).rejects.toBe(failure);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('distinguishes a missing bucket from a missing object on HEAD', async () => {
    const send = vi.fn().mockRejectedValue({ name: 'NotFound' });
    await expect(
      new S3Storage(config, { send } as unknown as S3Client).headObject('key'),
    ).rejects.toThrow('bucket is unavailable');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('preserves object 404 when the bucket is healthy', async () => {
    const failure = { name: 'NotFound' };
    const send = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({});
    await expect(
      new S3Storage(config, { send } as unknown as S3Client).headObject('key'),
    ).rejects.toBe(failure);
  });
});
