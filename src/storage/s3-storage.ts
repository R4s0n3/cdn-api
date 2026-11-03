import { isZipMimeType } from '../util/zip-files';
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
import { randomUUID } from 'node:crypto';

import { getConfig, type AppConfig } from '../config';

/** Identify retryable storage/network failures without retrying permanent permission errors. */
function isTransientStorageError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as {
    name?: string;
    code?: string;
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const status = failure.$metadata?.httpStatusCode;
  return (
    Boolean(failure.$retryable) ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    [
      'ETIMEDOUT',
      'ECONNRESET',
      'EPIPE',
      'EAI_AGAIN',
      'TimeoutError',
      'RequestTimeout',
      'SlowDown',
    ].includes(failure.code ?? failure.name ?? '')
  );
}

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

  /** Retry transient PUT failures with a fresh stream per attempt; close every stream. */
  async uploadFile(key: string, file: StoredFile): Promise<void> {
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      const body = createReadStream(file.path);
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            Body: body,
            ContentLength: file.size,
            ContentType: file.mimetype,
            ContentDisposition: isZipMimeType(file.mimetype)
              ? 'attachment'
              : undefined,
            CacheControl: this.config.cacheControl,
          }),
        );
        return;
      } catch (error) {
        if (
          attempt === this.config.maxAttempts ||
          !isTransientStorageError(error)
        )
          throw error;
      } finally {
        body.destroy();
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000, 100 * 2 ** (attempt - 1))),
      );
    }
  }

  /** Check anonymous read/list denial using harmless bytes before accepting private client content. */
  async verifyPrivateAccess(): Promise<void> {
    const key = [this.config.keyPrefix, 'private', `probe-${randomUUID()}`]
      .filter(Boolean)
      .join('/');
    const bucketUrl = new URL(this.config.endpoint);
    if (this.config.forcePathStyle)
      bucketUrl.pathname = `/${this.config.bucket}/`;
    else {
      bucketUrl.hostname = `${this.config.bucket}.${bucketUrl.hostname}`;
      bucketUrl.pathname = '/';
    }
    const objectUrl = new URL(
      key.split('/').map(encodeURIComponent).join('/'),
      bucketUrl,
    );
    const listUrl = new URL(bucketUrl);
    listUrl.search = new URLSearchParams({
      'list-type': '2',
      'max-keys': '1',
      prefix: [this.config.keyPrefix, 'private', '']
        .filter((part, index) => part || index === 2)
        .join('/'),
    }).toString();
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: Buffer.from('private-storage-verification'),
          ContentType: 'application/octet-stream',
          CacheControl: 'no-store',
        }),
      );
      for (const url of [objectUrl, listUrl]) {
        const response = await fetch(url, {
          method: 'GET',
          headers: url === objectUrl ? { Range: 'bytes=0-0' } : {},
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        });
        void response.body?.cancel().catch(() => undefined);
        if (![401, 403].includes(response.status))
          throw new Error(
            'Private S3 storage must reject anonymous object reads and listings',
          );
      }
    } finally {
      await this.deleteObjects([key]);
    }
  }

  /** Fetch the full object or a single requested byte range. */
  async getObject(
    key: string,
    range?: string,
  ): Promise<GetObjectCommandOutput> {
    return this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Range: range,
      }),
    );
  }

  /** Fetch metadata and verify bucket availability before classifying an ambiguous HEAD 404. */
  async headObject(key: string): Promise<HeadObjectCommandOutput> {
    try {
      return await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
    } catch (error) {
      // HEAD 404 has no body: distinguish a missing bucket from a missing object.
      if (isObjectNotFound(error)) {
        try {
          await this.checkBucket();
        } catch (cause) {
          throw new Error('Object storage bucket is unavailable', { cause });
        }
      }
      throw error;
    }
  }

  /** Attempt every object deletion and surface aggregate failures to rollback or retry callers. */
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
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .map((result) => result.reason);

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to delete ${failures.length} S3 object(s)`,
      );
    }
  }

  /** Check bucket availability, allowing a readiness deadline to abort the request. */
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

/** Join the configured namespace, stable cluster, and filename into the bucket key. */
export function buildObjectKey(
  cluster: string,
  fileName: string,
  keyPrefix: string,
): string {
  return [keyPrefix, cluster, fileName].filter(Boolean).join('/');
}

/** Encode each key segment while preserving S3 path separators. */
function encodeObjectKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Return a public bucket URL or the API proxy permalink for the stored object. */
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

/** Recognize object 404 variants; ambiguous HEAD failures require a separate bucket check. */
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

/** Recognize storage range failures separately from general upstream outages. */
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

/** Reuse a single configured S3 client for the lifetime of the process. */
export function getObjectStorage(): S3Storage {
  storage ??= new S3Storage(getConfig().s3);
  return storage;
}

/** Release S3 client resources during process shutdown. */
export function destroyObjectStorage(): void {
  storage?.destroy();
  storage = undefined;
}
