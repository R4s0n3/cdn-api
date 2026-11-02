import { Readable, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getObject: vi.fn(),
  headObject: vi.fn(),
  keyPrefix: 'production',
}));

vi.mock('../config', () => ({
  getConfig: () => ({
    s3: {
      cacheControl: 'public, max-age=31536000, immutable',
      keyPrefix: mocks.keyPrefix,
    },
  }),
}));

vi.mock('../storage/s3-storage', () => ({
  buildObjectKey: (cluster: string, fileName: string, prefix: string) =>
    [prefix, cluster, fileName].filter(Boolean).join('/'),
  getObjectStorage: () => ({
    getObject: mocks.getObject,
    headObject: mocks.headObject,
  }),
  isObjectNotFound: (error: { name?: string }) =>
    error?.name === 'NoSuchKey' || error?.name === 'NotFound',
  isRangeNotSatisfiable: (error: {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  }) =>
    error?.name === 'InvalidRange' || error?.$metadata?.httpStatusCode === 416,
}));

import {
  getStoredFile,
  headStoredFile,
} from '../controllers/storage-controllers';

class TestResponse extends Writable {
  readonly chunks: Buffer[] = [];
  readonly headers = new Map<string, string>();
  headersSent = false;
  statusCode = 200;

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  setHeader(name: string, value: string | number): this {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function createRequest(range?: string) {
  return {
    header: vi.fn((name: string) => (name === 'Range' ? range : undefined)),
    params: {
      cluster: '0000009mcbxv',
      fileName: 'legacy-file.pdf',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.keyPrefix = 'production';
});

describe('storage controllers', () => {
  it('streams a legacy object using the configured key prefix and headers', async () => {
    mocks.getObject.mockResolvedValue({
      AcceptRanges: 'bytes',
      Body: Readable.from([Buffer.from('legacy-data')]),
      CacheControl: 'public, max-age=60',
      ContentLength: 11,
      ContentType: 'application/pdf',
      ETag: '"etag"',
    });
    const response = new TestResponse();
    const next = vi.fn();

    await getStoredFile(createRequest() as never, response as never, next);

    expect(mocks.getObject).toHaveBeenCalledWith(
      'production/0000009mcbxv/legacy-file.pdf',
      undefined,
    );
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toBe('legacy-data');
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-length')).toBe('11');
    expect(response.headers.get('etag')).toBe('"etag"');
  });

  it('forwards a byte range and returns a 206 partial body', async () => {
    mocks.getObject.mockResolvedValue({
      Body: Readable.from([Buffer.from('gac')]),
      ContentLength: 3,
      ContentRange: 'bytes 2-4/11',
      ContentType: 'application/pdf',
    });
    const response = new TestResponse();
    const next = vi.fn();

    await getStoredFile(
      createRequest('bytes=2-4') as never,
      response as never,
      next,
    );

    expect(mocks.getObject).toHaveBeenCalledWith(
      'production/0000009mcbxv/legacy-file.pdf',
      'bytes=2-4',
    );
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(206);
    expect(response.body.toString()).toBe('gac');
    expect(response.headers.get('content-range')).toBe('bytes 2-4/11');
  });

  it('returns object metadata without downloading a body for HEAD', async () => {
    mocks.headObject.mockResolvedValue({
      ContentLength: 11,
      ContentType: 'application/pdf',
      ETag: '"etag"',
    });
    const response = new TestResponse();
    const next = vi.fn();

    await headStoredFile(createRequest() as never, response as never, next);

    expect(mocks.headObject).toHaveBeenCalledWith(
      'production/0000009mcbxv/legacy-file.pdf',
    );
    expect(mocks.getObject).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveLength(0);
    expect(response.headers.get('content-length')).toBe('11');
  });

  it('returns 304 without downloading a body when an ETag matches', async () => {
    mocks.headObject.mockResolvedValue({
      ETag: '"unchanged"',
      ContentLength: 5000,
    });
    const request = createRequest();
    request.header.mockImplementation((name) =>
      name === 'If-None-Match' ? 'W/"unchanged"' : undefined,
    );
    const response = new TestResponse();
    const next = vi.fn();
    await getStoredFile(request as never, response as never, next);
    expect(response.statusCode).toBe(304);
    expect(mocks.getObject).not.toHaveBeenCalled();
    expect(response.headers.has('content-length')).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });
  it('honors If-None-Match precedence over If-Modified-Since', async () => {
    mocks.headObject.mockResolvedValue({
      ETag: '"new"',
      LastModified: new Date('2026-01-01'),
    });
    mocks.getObject.mockResolvedValue({ Body: Readable.from(['body']) });
    const request = createRequest();
    request.header.mockImplementation((name) =>
      name === 'If-None-Match'
        ? '"old"'
        : name === 'If-Modified-Since'
          ? 'Wed, 01 Jan 2030 00:00:00 GMT'
          : undefined,
    );
    const response = new TestResponse();
    await getStoredFile(request as never, response as never, vi.fn());
    expect(response.statusCode).toBe(200);
    expect(mocks.getObject).toHaveBeenCalled();
  });

  it('preserves S3 InvalidRange as HTTP 416', async () => {
    mocks.getObject.mockRejectedValue({
      name: 'InvalidRange',
      $metadata: { httpStatusCode: 416 },
    });
    const response = new TestResponse();
    const next = vi.fn();

    await getStoredFile(
      createRequest('bytes=999999-') as never,
      response as never,
      next,
    );

    expect(next.mock.calls[0]?.[0]).toMatchObject({ code: 416 });
    expect(response.body).toHaveLength(0);
  });
});
