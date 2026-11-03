import { type S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Storage } from '../storage/s3-storage';
const config = {
  endpoint: 'https://nbg1.your-objectstorage.com',
  region: 'nbg1',
  bucket: 'private-files',
  accessKeyId: 'test',
  secretAccessKey: 'test',
  forcePathStyle: false,
  keyPrefix: 'app',
  maxAttempts: 1,
  cacheControl: 'private, no-store',
};
afterEach(() => vi.unstubAllGlobals());
describe('private S3 anonymous-access verification', () => {
  it('accepts a bucket only when object reads and prefix listings are denied', async () => {
    const send = vi.fn().mockResolvedValue({});
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await new S3Storage(config, {
      send,
    } as unknown as S3Client).verifyPrivateAccess();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/private-files\.nbg1\.your-objectstorage\.com\/app\/private\/probe-/,
    );
    expect(
      new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get('prefix'),
    ).toBe('app/private/');
    expect(send.mock.calls[0]?.[0].input.Body.toString()).toBe(
      'private-storage-verification',
    );
    expect(send.mock.calls[1]?.[0].input.Key).toMatch(/^app\/private\/probe-/);
  });
  it.each([[200], [403, 200], [404], [503]])(
    'fails closed when anonymous access is allowed or cannot be verified: %j',
    async (...statuses) => {
      const send = vi.fn().mockResolvedValue({});
      const fetch = vi.fn<typeof globalThis.fetch>();
      for (const status of statuses)
        fetch.mockResolvedValueOnce(new Response(null, { status }));
      vi.stubGlobal('fetch', fetch);
      await expect(
        new S3Storage(config, {
          send,
        } as unknown as S3Client).verifyPrivateAccess(),
      ).rejects.toThrow('reject anonymous');
      expect(send).toHaveBeenCalledTimes(2); // harmless probe creation and cleanup only
    },
  );
});
