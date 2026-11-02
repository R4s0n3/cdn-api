import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  deleteObjects: vi.fn(),
}));
vi.mock('../db', () => ({ db: { file: mocks } }));
vi.mock('../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config')>()),
  getConfig: () => ({ s3: { keyPrefix: 'production' } }),
}));
vi.mock('../util/upload-functions', () => ({
  getHashedCluster: () => 'cluster',
}));
vi.mock('../storage/s3-storage', () => ({
  buildObjectKey: (cluster: string, name: string, prefix: string) =>
    `${prefix}/${cluster}/${name}`,
  getObjectStorage: () => mocks,
}));
import { deleteMedia, listMedia } from '../controllers/media-controllers';

function response() {
  return { json: vi.fn(), status: vi.fn().mockReturnThis(), end: vi.fn() };
}
const auth = { apiKey: 'key', userId: 'owner' };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('S3_ENDPOINT', 'https://s3.example.com');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('media management', () => {
  it('paginates and searches the dedicated CDN database', async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
    const res = response();
    const next = vi.fn();
    await listMedia(
      { auth, query: { search: 'photo', page: '2' } } as never,
      res as never,
      next,
    );
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 48,
        take: 24,
        where: { deletedAt: null, originalName: { contains: 'photo' } },
      }),
    );
    expect(res.json).toHaveBeenCalledWith({ files: [], total: 0 });
    expect(next).not.toHaveBeenCalled();
  });
  it('rejects invalid pagination before reading the database', async () => {
    const next = vi.fn();
    await listMedia(
      { auth, query: { page: '-1' } } as never,
      response() as never,
      next,
    );
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 400 }));
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it('does not delete nonexistent files', async () => {
    mocks.findFirst.mockResolvedValue(null);
    const next = vi.fn();
    await deleteMedia(
      { auth, params: { id: 'other' } } as never,
      response() as never,
      next,
    );
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: 'other', deletedAt: null },
    });
    expect(mocks.deleteObjects).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 404 }));
  });
  it('deletes disk uploads without requiring S3 configuration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'media-delete-'));
    try {
      vi.stubEnv('S3_ENDPOINT', '');
      vi.stubEnv('SERVER_ROOT', root);
      await mkdir(path.join(root, 'storage'));
      const target = path.join(root, 'storage', 'photo.jpg');
      await writeFile(target, 'image');
      mocks.findFirst.mockResolvedValue({
        id: 'file',
        fileName: 'photo.jpg',
        url: '/storage/photo.jpg',
      });
      const res = response();
      const next = vi.fn();
      await deleteMedia(
        { auth, params: { id: 'file' } } as never,
        res as never,
        next,
      );
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(mocks.update).toHaveBeenCalled();
      expect(mocks.deleteObjects).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects paths outside the managed storage routes', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'file',
      fileName: '../secret',
      url: '/storage/../secret',
    });
    const next = vi.fn();
    await deleteMedia(
      { auth, params: { id: 'file' } } as never,
      response() as never,
      next,
    );
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 400 }));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.deleteObjects).not.toHaveBeenCalled();
  });
  it('retains metadata when object deletion fails', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'file',
      fileName: 'photo.jpg',
      url: '/storage/000000000001/photo.jpg',
    });
    mocks.deleteObjects.mockRejectedValue(new Error('S3 unavailable'));
    const next = vi.fn();
    await deleteMedia(
      { auth, params: { id: 'file' } } as never,
      response() as never,
      next,
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 502 }));
  });
  it('deletes the scoped S3 object before marking metadata deleted', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'file',
      fileName: 'photo.jpg',
      url: '/storage/000000000001/photo.jpg',
    });
    mocks.deleteObjects.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue({});
    const res = response();
    const next = vi.fn();
    await deleteMedia(
      { auth, params: { id: 'file' } } as never,
      res as never,
      next,
    );
    expect(mocks.deleteObjects).toHaveBeenCalledWith([
      'production/000000000001/photo.jpg',
    ]);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'file' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(res.status).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });
});
