import { getConfig } from '../config';
import HttpError from '../models/http-error';
import { S3Storage, buildObjectKey } from './s3-storage';

const clients = new Map<string, S3Storage>();

/** Reuse the existing S3 connection; permit a separate private bucket when public delivery is configured. */
export function privateStorageLocation(filename: string): {
  bucket: string;
  key: string;
} {
  if (!process.env.S3_ENDPOINT)
    throw new HttpError(
      'S3 storage is not configured for private uploads.',
      503,
    );
  const config = getConfig().s3;
  const bucket = process.env.S3_PRIVATE_BUCKET?.trim() || config.bucket;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
    throw new HttpError('Invalid private S3 bucket configuration.', 503);
  if (config.publicBaseUrl && bucket === config.bucket)
    throw new HttpError(
      'Set S3_PRIVATE_BUCKET to a separate private bucket when using a public S3 delivery URL.',
      503,
    );
  return { bucket, key: buildObjectKey('private', filename, config.keyPrefix) };
}

export function getPrivateStorage(bucket: string): S3Storage {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
    throw new HttpError('Invalid private S3 bucket configuration.', 503);
  let client = clients.get(bucket);
  if (!client) {
    client = new S3Storage({
      ...getConfig().s3,
      bucket,
      publicBaseUrl: undefined,
      cacheControl: 'private, no-store',
    });
    clients.set(bucket, client);
  }
  return client;
}
