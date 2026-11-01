import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import { isAllowedOrigin, serverRoot } from '../config';
import { ASSET_CACHE_CONTROL, STORAGE_CACHE_CONTROL, publicFileHeaders } from '../util/content-types';
import { isClusterName, isSafeFileName, resolveAssetFile, resolveStorageFile } from '../util/paths';

function continueIfPublicRead(req: Request, res: Response, next: NextFunction) {
  const origin = req.header('origin');
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).setHeader('Allow', 'GET, HEAD, OPTIONS').type('text/plain').send('Method not allowed');
    return;
  }

  next();
}

function notFound(res: Response) {
  res.status(404).type('text/plain').send('Not found');
}

function sendPublicFile(req: Request, res: Response, next: NextFunction, absolute: string, cacheControl: string) {
  try {
    const root = fs.realpathSync(serverRoot());
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      notFound(res);
      return;
    }

    res.sendFile(relative, {
      root,
      dotfiles: 'deny',
      acceptRanges: true,
      cacheControl: false,
      headers: publicFileHeaders(absolute, cacheControl),
    }, (err) => {
      if (!err || res.headersSent) return;
      const status = (err as { status?: number }).status || 404;
      if (status === 404) {
        notFound(res);
        return;
      }
      console.error('failed to read file', { path: req.path, status });
      res.status(500).type('text/plain').send('Failed to read file');
    });
  } catch (error) {
    next(error);
  }
}

function pathSegments(req: Request): string[] {
  return req.path.split('/').filter((part) => part.length > 0);
}

export function storageFiles(req: Request, res: Response, next: NextFunction) {
  continueIfPublicRead(req, res, () => {
    const parts = pathSegments(req);
    if (parts.length !== 2 || !isClusterName(parts[0]) || !isSafeFileName(parts[1])) {
      notFound(res);
      return;
    }

    const file = resolveStorageFile(parts[0], parts[1]);
    if (!file) {
      notFound(res);
      return;
    }

    sendPublicFile(req, res, next, file, STORAGE_CACHE_CONTROL);
  });
}

export function assetFiles(req: Request, res: Response, next: NextFunction) {
  continueIfPublicRead(req, res, () => {
    const file = resolveAssetFile(pathSegments(req));
    if (!file) {
      notFound(res);
      return;
    }
    sendPublicFile(req, res, next, file, ASSET_CACHE_CONTROL);
  });
}
