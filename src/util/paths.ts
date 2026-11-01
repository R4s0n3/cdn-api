import fs from 'fs';
import path from 'path';
import HttpError from '../models/http-error';
import { serverRoot } from '../config';
import { mimeMatchesExtension } from './content-types';

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const MAX_ASSET_PATH = 180;

export function isSafeFileName(value: string): boolean {
  return FILE_NAME.test(value) && !value.includes('..');
}

export function ensureStorageLayout(): void {
  const root = serverRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'storage'), { recursive: true });
}

export function storageDirectory(): string {
  const dir = path.join(serverRoot(), 'storage');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface AssetTarget {
  absolute: string;
  relative: string;
  url: string;
}

export function resolveAssetTarget(rawPath: string): AssetTarget {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 512) {
    throw new HttpError('Asset path is required.', 400);
  }
  if (rawPath.includes('\0') || rawPath.includes('\\')) {
    throw new HttpError('Invalid asset path.', 400);
  }

  let normalized = rawPath.replace(/^\/+/, '');
  if (normalized === 'assets' || normalized.startsWith('assets/')) {
    normalized = normalized.slice('assets/'.length);
  }
  const parts = normalized.split('/');
  if (parts.length === 0 || parts.length > 8 || parts.some((part) => part.length === 0)) {
    throw new HttpError('Invalid asset path.', 400);
  }
  if (!parts.every((part) => isSafeFileName(part))) {
    throw new HttpError('Invalid asset path.', 400);
  }
  if (normalized.length > MAX_ASSET_PATH) {
    throw new HttpError('Asset path is too long.', 400);
  }

  const extension = path.extname(parts[parts.length - 1]).toLowerCase();
  if (!extension || !mimeMatchesExtension(mimeForAssetExtension(extension), extension)) {
    throw new HttpError('Invalid file type for asset path.', 400);
  }

  const assetsRoot = path.resolve(serverRoot(), 'assets');
  const absolute = path.resolve(assetsRoot, ...parts);
  if (absolute !== assetsRoot && !absolute.startsWith(assetsRoot + path.sep)) {
    throw new HttpError('Invalid asset path.', 400);
  }

  return {
    absolute,
    relative: parts.join('/'),
    url: `/assets/${parts.join('/')}`,
  };
}

function mimeForAssetExtension(extension: string): string {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'avif') return 'image/avif';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'pdf') return 'application/pdf';
  return '';
}

export function resolveExistingFile(candidate: string, jailRoot: string): string | null {
  const root = path.resolve(jailRoot);
  const target = path.resolve(candidate);
  if (target !== root && !target.startsWith(root + path.sep)) return null;

  let realRoot: string;
  let realTarget: string;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return null;
    realRoot = fs.realpathSync(root);
    realTarget = fs.realpathSync(target);
  } catch {
    return null;
  }

  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  return realTarget;
}

export function resolveStorageFile(filename: string): string | null {
  if (!isSafeFileName(filename)) return null;
  const storageRoot = path.join(serverRoot(), 'storage');
  return resolveExistingFile(path.join(storageRoot, filename), storageRoot);
}

export function resolveAssetFile(segments: string[]): string | null {
  if (segments.length === 0 || segments.length > 8) return null;
  if (!segments.every((segment) => isSafeFileName(segment))) return null;
  const assetsRoot = path.join(serverRoot(), 'assets');
  return resolveExistingFile(path.join(assetsRoot, ...segments), assetsRoot);
}
