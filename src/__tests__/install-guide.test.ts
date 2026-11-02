import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const externalCalls = vi.hoisted(() => ({
  database: vi.fn(),
  objectStorage: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    $queryRawUnsafe: externalCalls.database,
    $transaction: externalCalls.database,
    apiKey: { findFirst: externalCalls.database },
    file: {
      create: externalCalls.database,
      findMany: externalCalls.database,
      findUnique: externalCalls.database,
    },
  },
}));

vi.mock('../storage/s3-storage', () => ({
  buildObjectKey: (cluster: string, fileName: string, prefix: string) =>
    [prefix, cluster, fileName].filter(Boolean).join('/'),
  buildStorageUrl: (cluster: string, fileName: string) =>
    `/storage/${cluster}/${fileName}`,
  getObjectStorage: externalCalls.objectStorage,
  isObjectNotFound: () => false,
  isRangeNotSatisfiable: () => false,
}));

import { createApp } from '../app';
import { type AppConfig } from '../config';
import {
  INSTALL_GUIDE_CACHE_CONTROL,
  loadInstallGuide,
} from '../install-guide';

const sensitiveValues = {
  apiKey: 'SENTINEL_API_KEY_DO_NOT_EXPOSE',
  databaseUrl: 'mysql://SENTINEL_DATABASE_SECRET@database:3306/cdn',
  saltString: 'SENTINEL_SALT_SECRET',
  s3AccessKey: 'SENTINEL_S3_ACCESS_KEY',
  s3Bucket: 'SENTINEL_S3_BUCKET',
  s3CacheControl: 'SENTINEL_S3_CACHE_CONTROL',
  s3Endpoint: 'SENTINEL_S3_ENDPOINT',
  s3KeyPrefix: 'SENTINEL_S3_KEY_PREFIX',
  s3PublicBaseUrl: 'SENTINEL_S3_PUBLIC_BASE_URL',
  s3Region: 'SENTINEL_S3_REGION',
  s3SecretKey: 'SENTINEL_S3_SECRET_KEY',
  uploadTempDir: 'SENTINEL_UPLOAD_TEMP_DIR',
};

const config: AppConfig = {
  nodeEnv: 'test',
  port: 9001,
  host: '127.0.0.1',
  publicApiBaseUrl: 'https://cdn-api.example.com',
  databaseUrl: sensitiveValues.databaseUrl,
  saltString: sensitiveValues.saltString,
  trustProxy: 1,
  readinessTimeoutMs: 5000,
  uploadTempDir: sensitiveValues.uploadTempDir,
  s3: {
    endpoint: sensitiveValues.s3Endpoint,
    region: sensitiveValues.s3Region,
    bucket: sensitiveValues.s3Bucket,
    accessKeyId: sensitiveValues.s3AccessKey,
    secretAccessKey: sensitiveValues.s3SecretKey,
    forcePathStyle: false,
    keyPrefix: sensitiveValues.s3KeyPrefix,
    publicBaseUrl: sensitiveValues.s3PublicBaseUrl,
    maxAttempts: 3,
    cacheControl: sensitiveValues.s3CacheControl,
  },
};

let server: Server;
let origin: string;

function allHeaders(response: Response): string {
  return [...response.headers.entries()]
    .flatMap(([name, value]) => [name, value])
    .join('\n');
}

beforeAll(async () => {
  externalCalls.database.mockRejectedValue(
    new Error('database should not be called'),
  );
  externalCalls.objectStorage.mockImplementation(() => {
    throw new Error('object storage should not be called');
  });

  server = http.createServer(createApp(config));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('downloadable CDN integration guide', () => {
  it('serves public Markdown with content-derived caching headers', async () => {
    const response = await fetch(`${origin}/api/install/AGENTS.md`, {
      headers: { 'X-API-Key': sensitiveValues.apiKey },
    });
    const body = await response.text();
    const expectedDigest = createHash('sha256')
      .update(body, 'utf8')
      .digest('hex');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/markdown; charset=utf-8',
    );
    expect(response.headers.get('content-disposition')).toBe(
      'inline; filename="AGENTS.md"',
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe(
      INSTALL_GUIDE_CACHE_CONTROL,
    );
    expect(response.headers.get('etag')).toBe(`"sha256-${expectedDigest}"`);
    expect(Number(response.headers.get('content-length'))).toBe(
      Buffer.byteLength(body, 'utf8'),
    );
    expect(body).toContain(
      'CDN_API_BASE_URL=https://cdn-api.example.com',
    );
    expect(body).toContain('POST /api/upload/single');
    expect(body).toContain('POST /api/upload/bulk');
    expect(body).not.toContain('{{PUBLIC_API_BASE_URL}}');

    const observableResponse = `${allHeaders(response)}\n${body}`;
    for (const secret of Object.values(sensitiveValues)) {
      expect(observableResponse).not.toContain(secret);
    }
  });

  it('returns matching GET, HEAD, and conditional responses', async () => {
    const getResponse = await fetch(`${origin}/api/install/AGENTS.md`);
    const getBody = await getResponse.arrayBuffer();
    const etag = getResponse.headers.get('etag');

    expect(etag).toBeTruthy();

    const headResponse = await fetch(`${origin}/api/install/AGENTS.md`, {
      method: 'HEAD',
    });
    expect(headResponse.status).toBe(200);
    expect((await headResponse.arrayBuffer()).byteLength).toBe(0);
    expect(headResponse.headers.get('etag')).toBe(etag);
    expect(headResponse.headers.get('content-length')).toBe(
      String(getBody.byteLength),
    );
    expect(headResponse.headers.get('content-type')).toBe(
      getResponse.headers.get('content-type'),
    );
    expect(headResponse.headers.get('content-disposition')).toBe(
      getResponse.headers.get('content-disposition'),
    );
    expect(headResponse.headers.get('cache-control')).toBe(
      INSTALL_GUIDE_CACHE_CONTROL,
    );
    expect(headResponse.headers.get('x-content-type-options')).toBe('nosniff');

    for (const method of ['GET', 'HEAD']) {
      const conditionalResponse = await fetch(
        `${origin}/api/install/AGENTS.md`,
        {
          method,
          headers: { 'If-None-Match': `"unrelated", W/${etag}` },
        },
      );

      expect(conditionalResponse.status).toBe(304);
      expect(conditionalResponse.headers.get('etag')).toBe(etag);
      expect(conditionalResponse.headers.get('cache-control')).toBe(
        INSTALL_GUIDE_CACHE_CONTROL,
      );
      expect(conditionalResponse.headers.get('content-disposition')).toBe(
        'inline; filename="AGENTS.md"',
      );
      expect(conditionalResponse.headers.get('content-type')).toBe(
        'text/markdown; charset=utf-8',
      );
      expect(
        conditionalResponse.headers.get('x-content-type-options'),
      ).toBe('nosniff');
      expect((await conditionalResponse.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it('uses a relative 308 redirect that ignores spoofed request hosts', async () => {
    const response = await fetch(`${origin}/api/install`, {
      redirect: 'manual',
      headers: {
        Host: 'attacker.example',
        Forwarded: 'host=attacker.example;proto=http',
        'X-Forwarded-Host': 'attacker.example',
        'X-Forwarded-Proto': 'http',
      },
    });

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/api/install/AGENTS.md');
    expect(await response.text()).not.toContain('attacker.example');
  });

  it('does not let Host or forwarding headers alter rendered content', async () => {
    const normalResponse = await fetch(`${origin}/api/install/AGENTS.md`);
    const spoofedResponse = await fetch(`${origin}/api/install/AGENTS.md`, {
      headers: {
        Host: 'attacker.example',
        Forwarded: 'host=attacker.example;proto=http',
        'X-Forwarded-Host': 'attacker.example',
        'X-Forwarded-Proto': 'http',
      },
    });

    expect(await spoofedResponse.text()).toBe(await normalResponse.text());
    expect(spoofedResponse.headers.get('etag')).toBe(
      normalResponse.headers.get('etag'),
    );
  });

  it('does not expose files through unsupported methods or path variants', async () => {
    const requests: Array<[string, RequestInit | undefined]> = [
      ['/api/install/AGENTS.md/extra', undefined],
      ['/api/install/AGENTS.md/', undefined],
      ['/api/install/', undefined],
      ['/api/install/%2e%2e%2f.env', undefined],
      ['/api/install/%252e%252e%252f.env', undefined],
      ['/api/install/templates/cdn-api-agents.md', undefined],
      ['/api/install/AGENTS.md', { method: 'POST' }],
      ['/api/install/AGENTS.md', { method: 'PUT' }],
    ];

    for (const [requestPath, init] of requests) {
      const response = await fetch(`${origin}${requestPath}`, init);
      const body = await response.text();

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).not.toContain(
        'text/markdown',
      );
      expect(body).not.toContain('# CDN API integration guide');
      for (const secret of Object.values(sensitiveValues)) {
        expect(`${allHeaders(response)}\n${body}`).not.toContain(secret);
      }
    }
  });

  it('performs no authentication, database, or object-storage work', () => {
    expect(externalCalls.database).not.toHaveBeenCalled();
    expect(externalCalls.objectStorage).not.toHaveBeenCalled();
  });

  it('resolves the packaged template independently of the working directory', () => {
    const originalWorkingDirectory = process.cwd();

    try {
      process.chdir(os.tmpdir());
      const guide = loadInstallGuide(config.publicApiBaseUrl);
      expect(guide.body).toContain(
        'CDN_API_BASE_URL=https://cdn-api.example.com',
      );
    } finally {
      process.chdir(originalWorkingDirectory);
    }
  });

  it('fails clearly for a missing, oversized, or invalid template', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cdn-guide-template-test-'),
    );

    try {
      const oversizedPath = path.join(directory, 'oversized.md');
      const invalidUtf8Path = path.join(directory, 'invalid-utf8.md');
      const missingPlaceholderPath = path.join(
        directory,
        'missing-placeholder.md',
      );
      const unsupportedPlaceholderPath = path.join(
        directory,
        'unsupported-placeholder.md',
      );
      await fs.writeFile(oversizedPath, Buffer.alloc(128 * 1024 + 1, 0x61));
      await fs.writeFile(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0xfd]));
      await fs.writeFile(missingPlaceholderPath, '# No placeholder here');
      await fs.writeFile(
        unsupportedPlaceholderPath,
        '{{PUBLIC_API_BASE_URL}} and {{databasePassword}}',
      );

      expect(() =>
        loadInstallGuide(
          config.publicApiBaseUrl,
          path.join(directory, 'missing.md'),
        ),
      ).toThrow('Failed to load CDN integration guide template');
      expect(() =>
        loadInstallGuide(config.publicApiBaseUrl, oversizedPath),
      ).toThrow('exceeds the 131072-byte limit');
      expect(() =>
        loadInstallGuide(config.publicApiBaseUrl, invalidUtf8Path),
      ).toThrow('is not valid UTF-8');
      expect(() =>
        loadInstallGuide(config.publicApiBaseUrl, missingPlaceholderPath),
      ).toThrow('is missing {{PUBLIC_API_BASE_URL}}');
      expect(() =>
        loadInstallGuide(config.publicApiBaseUrl, unsupportedPlaceholderPath),
      ).toThrow('contains unsupported placeholders: {{databasePassword}}');
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  });
});
