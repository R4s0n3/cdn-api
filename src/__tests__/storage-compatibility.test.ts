import { describe, expect, it } from 'vitest';

import { type AppConfig } from '../config';
import {
  buildObjectKey,
  buildStorageUrl,
  isObjectNotFound,
  isRangeNotSatisfiable,
} from '../storage/s3-storage';
import { parseByteRange } from '../controllers/storage-controllers';
import { getHashedCluster } from '../util/upload-functions';

const s3Config: AppConfig['s3'] = {
  endpoint: 'https://nbg1.your-objectstorage.com',
  region: 'nbg1',
  bucket: 'cdn-files',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
  forcePathStyle: false,
  keyPrefix: '',
  maxAttempts: 3,
  cacheControl: 'public, max-age=31536000, immutable',
};

describe('legacy storage compatibility', () => {
  it('keeps the existing salted cluster algorithm stable', () => {
    expect(getHashedCluster('api-key', 'user-123', 'legacy-salt')).toBe(
      '0000009mcbxv',
    );
  });

  it('keeps the existing cluster/filename object layout by default', () => {
    expect(buildObjectKey('0000009mcbxv', 'file-name.pdf', '')).toBe(
      '0000009mcbxv/file-name.pdf',
    );
  });

  it('keeps relative storage URLs when no public base URL is configured', () => {
    expect(buildStorageUrl('0000009mcbxv', 'file-name.pdf', s3Config)).toBe(
      '/storage/0000009mcbxv/file-name.pdf',
    );
  });

  it('builds encoded direct URLs for a public bucket or CDN', () => {
    expect(
      buildStorageUrl('0000009mcbxv', 'file name.pdf', {
        ...s3Config,
        keyPrefix: 'production',
        publicBaseUrl: 'https://cdn-files.nbg1.your-objectstorage.com',
      }),
    ).toBe(
      'https://cdn-files.nbg1.your-objectstorage.com/production/0000009mcbxv/file%20name.pdf',
    );
  });

  it('recognizes S3 not-found errors without exposing other failures as 404s', () => {
    expect(isObjectNotFound({ name: 'NoSuchKey' })).toBe(true);
    expect(isObjectNotFound({ name: 'NotFound' })).toBe(true);
    expect(isObjectNotFound({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })).toBe(
      false,
    );
    expect(isObjectNotFound({ $metadata: { httpStatusCode: 503 } })).toBe(false);
  });

  it('accepts single HTTP byte ranges and rejects invalid ranges', () => {
    expect(parseByteRange(undefined)).toBeUndefined();
    expect(parseByteRange('bytes=0-99')).toBe('bytes=0-99');
    expect(parseByteRange('bytes=100-')).toBe('bytes=100-');
    expect(parseByteRange('bytes=-100')).toBe('bytes=-100');
    expect(() => parseByteRange('bytes=10-5')).toThrow('Invalid byte range');
    expect(() => parseByteRange('bytes=-0')).toThrow('Invalid byte range');
    expect(() => parseByteRange('bytes=0-1,4-5')).toThrow('Invalid byte range');
  });

  it('recognizes unsatisfiable ranges separately from storage outages', () => {
    expect(isRangeNotSatisfiable({ name: 'InvalidRange' })).toBe(true);
    expect(isRangeNotSatisfiable({ $metadata: { httpStatusCode: 416 } })).toBe(true);
    expect(isRangeNotSatisfiable({ $metadata: { httpStatusCode: 503 } })).toBe(false);
  });
});
