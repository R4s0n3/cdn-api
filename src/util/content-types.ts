import path from 'path';

export const STORAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const ASSET_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

const INLINE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

export function extensionForMime(mime: string): string | undefined {
  return MIME_TO_EXTENSION[mime];
}

export function mimeMatchesExtension(mime: string, extension: string): boolean {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (mime === 'image/jpeg') return ext === 'jpg' || ext === 'jpeg';
  return MIME_TO_EXTENSION[mime] === ext;
}

export function publicFileHeaders(filePath: string, cacheControl: string): Record<string, string> {
  const ext = path.extname(filePath).toLowerCase();
  const headers: Record<string, string> = {
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Disposition': 'inline',
  };

  if (ext === '.svg') {
    headers['Content-Type'] = 'image/svg+xml';
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'";
    return headers;
  }

  const type = INLINE_TYPES[ext];
  if (type) {
    headers['Content-Type'] = type;
    return headers;
  }

  headers['Content-Type'] = 'application/octet-stream';
  headers['Content-Disposition'] = 'attachment';
  return headers;
}
