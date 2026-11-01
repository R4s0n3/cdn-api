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
    throw new Error(`MAX_UPLOAD_BYTES must be a positive integer up to ${MAX_UPLOAD_CAP_BYTES}`);
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
  if (!process.env.SALT_STRING) missing.push('SALT_STRING');
  if (!process.env.SERVER_ROOT) missing.push('SERVER_ROOT');
  if (missing.length > 0) {
    throw new Error(`Missing required environment: ${missing.join(', ')}`);
  }
  serverRoot();
  port();
  maxUploadBytes();
}
