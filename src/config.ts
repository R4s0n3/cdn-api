import { z } from 'zod';
import { isAbsolute } from 'node:path';

const urlValue = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z.string().url(),
);

const optionalUrl = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmedValue = value.trim();
  return trimmedValue === '' ? undefined : trimmedValue;
}, z.string().url().optional());

const booleanValue = z.preprocess(
  (value) => (value === undefined ? 'false' : value),
  z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true'),
);

function hasOnlyOriginComponents(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\/[^/?#\\]+\/?$/i.test(value);
}

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(9001),
    HOST: z.string().min(1).default('0.0.0.0'),
    PUBLIC_API_BASE_URL: urlValue,
    DATABASE_URL: z.string().min(1),
    SALT_STRING: z.string().min(1),
    TRUST_PROXY: z.string().default('1'),
    S3_ENDPOINT: urlValue,
    S3_REGION: z.string().min(1),
    S3_BUCKET: z
      .string()
      .min(3)
      .max(63)
      .regex(
        /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
        'must contain only lowercase letters, numbers, and hyphens',
      ),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: booleanValue,
    S3_KEY_PREFIX: z.string().default(''),
    S3_PUBLIC_BASE_URL: optionalUrl,
    S3_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    STORAGE_CACHE_CONTROL: z
      .string()
      .min(1)
      .default('public, max-age=31536000, immutable'),
    READINESS_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(250)
      .max(30000)
      .default(5000),
    UPLOAD_TEMP_DIR: z
      .string()
      .min(1)
      .refine((value) => isAbsolute(value), 'must be an absolute path')
      .optional(),
  })
  .superRefine((env, context) => {
    const publicApiBaseUrl = new URL(env.PUBLIC_API_BASE_URL);
    const endpoint = new URL(env.S3_ENDPOINT);

    if (!['http:', 'https:'].includes(publicApiBaseUrl.protocol)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLIC_API_BASE_URL'],
        message: 'must use HTTP or HTTPS',
      });
    }

    if (
      env.NODE_ENV === 'production' &&
      publicApiBaseUrl.protocol !== 'https:'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLIC_API_BASE_URL'],
        message: 'must use HTTPS in production',
      });
    }

    if (
      publicApiBaseUrl.username ||
      publicApiBaseUrl.password ||
      publicApiBaseUrl.search ||
      publicApiBaseUrl.hash ||
      !hasOnlyOriginComponents(env.PUBLIC_API_BASE_URL)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLIC_API_BASE_URL'],
        message:
          'must be an origin without credentials, a path, a query, or a fragment',
      });
    }

    if (!['http:', 'https:'].includes(endpoint.protocol)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_ENDPOINT'],
        message: 'must use HTTP or HTTPS',
      });
    }

    if (env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_ENDPOINT'],
        message: 'must use HTTPS in production',
      });
    }

    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.pathname !== '' && endpoint.pathname !== '/')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_ENDPOINT'],
        message:
          'must be a service origin without credentials, a path, a query, or a fragment',
      });
    }

    if (endpoint.hostname.endsWith('.your-objectstorage.com')) {
      const endpointRegion = endpoint.hostname.split('.')[0];
      if (endpointRegion !== env.S3_REGION) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['S3_REGION'],
          message: `must match the Hetzner endpoint region (${endpointRegion})`,
        });
      }
    }

    if (env.S3_PUBLIC_BASE_URL) {
      const publicBaseUrl = new URL(env.S3_PUBLIC_BASE_URL);

      if (!['http:', 'https:'].includes(publicBaseUrl.protocol)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['S3_PUBLIC_BASE_URL'],
          message: 'must use HTTP or HTTPS',
        });
      }

      if (
        env.NODE_ENV === 'production' &&
        publicBaseUrl.protocol !== 'https:'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['S3_PUBLIC_BASE_URL'],
          message: 'must use HTTPS in production',
        });
      }

      if (
        publicBaseUrl.username ||
        publicBaseUrl.password ||
        publicBaseUrl.search ||
        publicBaseUrl.hash
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['S3_PUBLIC_BASE_URL'],
          message: 'must not contain credentials, a query, or a fragment',
        });
      }
    }
  });

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  publicApiBaseUrl: string;
  databaseUrl: string;
  saltString: string;
  trustProxy: boolean | number | string;
  readinessTimeoutMs: number;
  uploadTempDir?: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    keyPrefix: string;
    publicBaseUrl?: string;
    maxAttempts: number;
    cacheControl: string;
  };
};

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  return value;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeKeyPrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');

  if (
    prefix.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(
      'Invalid environment configuration: S3_KEY_PREFIX contains a path segment',
    );
  }

  return prefix;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const result = envSchema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`,
      )
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const env = result.data;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    publicApiBaseUrl: new URL(env.PUBLIC_API_BASE_URL).origin,
    databaseUrl: env.DATABASE_URL,
    saltString: env.SALT_STRING,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    readinessTimeoutMs: env.READINESS_TIMEOUT_MS,
    uploadTempDir: env.UPLOAD_TEMP_DIR,
    s3: {
      endpoint: trimTrailingSlashes(env.S3_ENDPOINT),
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      keyPrefix: normalizeKeyPrefix(env.S3_KEY_PREFIX),
      publicBaseUrl: env.S3_PUBLIC_BASE_URL
        ? trimTrailingSlashes(env.S3_PUBLIC_BASE_URL)
        : undefined,
      maxAttempts: env.S3_MAX_ATTEMPTS,
      cacheControl: env.STORAGE_CACHE_CONTROL,
    },
  };
}

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  cachedConfig ??= loadConfig();
  return cachedConfig;
}

import path from 'path';

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_CAP_BYTES = 200 * 1024 * 1024;

export function serverRoot(): string {
  const root = process.env.SERVER_ROOT;
  if (!root || !root.trim()) {
    throw new Error('SERVER_ROOT is not set');
  }
  if (!path.isAbsolute(root)) {
    throw new Error('SERVER_ROOT must be an absolute path');
  }
  return path.resolve(root);
}

export function port(): number {
  const raw = process.env.PORT || '9001';
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return value;
}

export function maxUploadBytes(): number {
  const raw = process.env.MAX_UPLOAD_BYTES;
  if (!raw || !raw.trim()) return DEFAULT_MAX_UPLOAD_BYTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_UPLOAD_CAP_BYTES) {
    throw new Error(
      `MAX_UPLOAD_BYTES must be a positive integer up to ${MAX_UPLOAD_CAP_BYTES}`,
    );
  }
  return value;
}

export function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const extras = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (extras.includes(origin)) return true;

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') {
    return process.env.NODE_ENV !== 'production' && url.protocol === 'http:';
  }

  if (url.protocol !== 'https:') return false;
  return host === 'miomideal.com' || host.endsWith('.miomideal.com');
}

export function assertConfig(): void {
  const missing: string[] = [];
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!process.env.CDN_API_KEY) missing.push('CDN_API_KEY');
  if (!process.env.SERVER_ROOT) missing.push('SERVER_ROOT');
  if (missing.length > 0) {
    throw new Error(`Missing required environment: ${missing.join(', ')}`);
  }
  const databaseUrl = process.env.DATABASE_URL || '';
  if (
    !databaseUrl.startsWith('postgresql://') &&
    !databaseUrl.startsWith('postgres://')
  ) {
    throw new Error('DATABASE_URL must start with postgresql://');
  }
  serverRoot();
  port();
  maxUploadBytes();
}
