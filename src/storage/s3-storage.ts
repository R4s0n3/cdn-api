import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';

import { getConfig, type AppConfig } from '../config';

type StoredFile = Pick<Express.Multer.File, 'mimetype' | 'path' | 'size'>;

export class S3Storage {
  private readonly client: S3Client;

  constructor(
    private readonly config: AppConfig['s3'],
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: config.forcePathStyle,
        maxAttempts: config.maxAttempts,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
  }

  async uploadFile(key: string, file: StoredFile): Promise<void> {
    const body = createReadStream(file.path);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentLength: file.size,
          ContentType: file.mimetype,
          CacheControl: this.config.cacheControl,
        }),
      );
    } finally {
      body.destroy();
    }
  }

  async getObject(key: string, range?: string): Promise<GetObjectCommandOutput> {
    return this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Range: range,
      }),
    );
  }

  async headObject(key: string): Promise<HeadObjectCommandOutput> {
    return this.client.send(
      new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );
  }

  async deleteObjects(keys: string[]): Promise<void> {
    const results = await Promise.allSettled(
      keys.map((key) =>
        this.client.send(
          new DeleteObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
          }),
        ),
      ),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);

    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to delete ${failures.length} S3 object(s)`);
    }
  }

  async checkBucket(abortSignal?: AbortSignal): Promise<void> {
    await this.client.send(
      new HeadBucketCommand({
        Bucket: this.config.bucket,
      }),
      { abortSignal },
    );
  }

  destroy(): void {
    this.client.destroy();
  }
}

export function buildObjectKey(
  cluster: string,
  fileName: string,
  keyPrefix: string,
): string {
  return [keyPrefix, cluster, fileName].filter(Boolean).join('/');
}

function encodeObjectKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function buildStorageUrl(
  cluster: string,
  fileName: string,
  config: AppConfig['s3'],
): string {
  if (config.publicBaseUrl) {
    const objectKey = buildObjectKey(cluster, fileName, config.keyPrefix);
    return `${config.publicBaseUrl}/${encodeObjectKey(objectKey)}`;
  }

  return `/storage/${encodeURIComponent(cluster)}/${encodeURIComponent(fileName)}`;
}

export function isObjectNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const storageError = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    storageError.name === 'NoSuchKey' ||
    storageError.name === 'NotFound' ||
    storageError.Code === 'NoSuchKey' ||
    storageError.Code === 'NotFound'
  );
}

export function isRangeNotSatisfiable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const storageError = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    storageError.name === 'InvalidRange' ||
    storageError.Code === 'InvalidRange' ||
    storageError.$metadata?.httpStatusCode === 416
  );
}

let storage: S3Storage | undefined;

export function getObjectStorage(): S3Storage {
  storage ??= new S3Storage(getConfig().s3);
  return storage;
}

export function destroyObjectStorage(): void {
  storage?.destroy();
  storage = undefined;
}
