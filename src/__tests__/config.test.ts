import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config';

const validEnvironment: NodeJS.ProcessEnv = {
  PUBLIC_API_BASE_URL: 'https://cdn-api.example.com',
  DATABASE_URL: 'postgresql://user:password@database:5432/cdn',
  SALT_STRING: 'keep-this-value-during-migration',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_BUCKET: 'cdn-files',
  S3_ENDPOINT: 'https://nbg1.your-objectstorage.com/',
  S3_REGION: 'nbg1',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

describe('loadConfig', () => {
  it('loads Hetzner-compatible defaults', () => {
    const config = loadConfig({
      ...validEnvironment,
      S3_ENDPOINT: '  https://nbg1.your-objectstorage.com/  ',
      S3_PUBLIC_BASE_URL: '   ',
    });

    expect(config.port).toBe(9001);
    expect(config.host).toBe('0.0.0.0');
    expect(config.trustProxy).toBe(0);
    expect(config.publicApiBaseUrl).toBe('https://cdn-api.example.com');
    expect(config.s3.endpoint).toBe('https://nbg1.your-objectstorage.com');
    expect(config.s3.forcePathStyle).toBe(false);
    expect(config.s3.keyPrefix).toBe('');
    expect(config.s3.maxAttempts).toBe(3);
    expect(config.s3.publicBaseUrl).toBeUndefined();
  });

  it('rejects a region that does not match the Hetzner endpoint', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        S3_REGION: 'fsn1',
      }),
    ).toThrow('must match the Hetzner endpoint region (nbg1)');
  });

  it('requires HTTPS for production storage endpoints', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NODE_ENV: 'production',
        S3_ENDPOINT: 'http://nbg1.your-objectstorage.com',
      }),
    ).toThrow('must use HTTPS in production');
  });

  it('normalizes the configured public API origin', () => {
    const config = loadConfig({
      ...validEnvironment,
      PUBLIC_API_BASE_URL: '  https://cdn-api.example.com:8443/  ',
    });

    expect(config.publicApiBaseUrl).toBe('https://cdn-api.example.com:8443');
  });

  it('requires PUBLIC_API_BASE_URL', () => {
    const { PUBLIC_API_BASE_URL: _publicApiBaseUrl, ...environment } =
      validEnvironment;

    expect(() => loadConfig(environment)).toThrow('PUBLIC_API_BASE_URL');
  });

  it.each([
    'ftp://cdn-api.example.com',
    'https://user:password@cdn-api.example.com',
    'https://cdn-api.example.com/a/path',
    'https://cdn-api.example.com/a/..',
    'https://cdn-api.example.com/%2e%2e',
    'https://cdn-api.example.com\\hidden',
    'https://cdn-api.example.com?tenant=one',
    'https://cdn-api.example.com#install',
  ])('rejects a non-origin public API URL: %s', (publicApiBaseUrl) => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        PUBLIC_API_BASE_URL: publicApiBaseUrl,
      }),
    ).toThrow('PUBLIC_API_BASE_URL');
  });

  it('requires HTTPS for the production public API origin', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NODE_ENV: 'production',
        PUBLIC_API_BASE_URL: 'http://cdn-api.example.com',
      }),
    ).toThrow('PUBLIC_API_BASE_URL: must use HTTPS in production');
  });

  it('normalizes a nested object key prefix', () => {
    const config = loadConfig({
      ...validEnvironment,
      S3_KEY_PREFIX: '/production/files/',
    });

    expect(config.s3.keyPrefix).toBe('production/files');
  });

  it('rejects unsafe object key prefixes', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        S3_KEY_PREFIX: 'production/../files',
      }),
    ).toThrow('S3_KEY_PREFIX contains a path segment');
  });

  it('rejects a query or fragment in the public object base URL', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        S3_PUBLIC_BASE_URL: 'https://cdn.example.com/assets?token=value',
      }),
    ).toThrow('must not contain credentials, a query, or a fragment');
  });

  it('rejects a path on the S3 service endpoint', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        S3_ENDPOINT: 'https://nbg1.your-objectstorage.com/bucket',
      }),
    ).toThrow('must be a service origin');
  });

  it('requires an absolute temporary upload directory', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        UPLOAD_TEMP_DIR: 'relative/uploads',
      }),
    ).toThrow('must be an absolute path');
  });
});
