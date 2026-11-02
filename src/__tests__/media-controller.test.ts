import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), update: vi.fn(), deleteObjects: vi.fn() }));
vi.mock('../db', () => ({ db: { file: mocks } }));
vi.mock('../config', () => ({ getConfig: () => ({ s3: { keyPrefix: 'production' } }) }));
vi.mock('../util/upload-functions', () => ({ getHashedCluster: () => 'cluster' }));
vi.mock('../storage/s3-storage', () => ({ buildObjectKey: (cluster: string, name: string, prefix: string) => `${prefix}/${cluster}/${name}`, getObjectStorage: () => mocks }));
import { deleteMedia, listMedia } from '../controllers/media-controllers';

function response() { return { json: vi.fn(), status: vi.fn().mockReturnThis(), end: vi.fn() }; }
const auth = { apiKey: 'key', userId: 'owner' };
beforeEach(() => { vi.resetAllMocks(); });

describe('media management', () => {
  it('scopes search and pagination to the authenticated owner and key', async () => {
    mocks.findMany.mockResolvedValue([]); mocks.count.mockResolvedValue(0);
    const res = response(); const next = vi.fn();
    await listMedia({ auth, query: { search: 'photo', page: '2' } } as never, res as never, next);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 48, take: 24, where: { appKey: 'key', createdById: 'owner', deletedAt: null, originalName: { contains: 'photo' } } }));
    expect(res.json).toHaveBeenCalledWith({ files: [], total: 0 });
    expect(next).not.toHaveBeenCalled();
  });
  it('rejects invalid pagination before reading the database', async () => {
    const next = vi.fn();
    await listMedia({ auth, query: { page: '-1' } } as never, response() as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 400 }));
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it('does not delete files belonging to a different owner', async () => {
    mocks.findFirst.mockResolvedValue(null); const next = vi.fn();
    await deleteMedia({ auth, params: { id: 'other' } } as never, response() as never, next);
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'other', appKey: 'key', createdById: 'owner', deletedAt: null } });
    expect(mocks.deleteObjects).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 404 }));
  });
  it('retains metadata when object deletion fails', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'file', fileName: 'photo.jpg' });
    mocks.deleteObjects.mockRejectedValue(new Error('S3 unavailable')); const next = vi.fn();
    await deleteMedia({ auth, params: { id: 'file' } } as never, response() as never, next);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 502 }));
  });
  it('deletes the scoped S3 object before marking metadata deleted', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'file', fileName: 'photo.jpg' });
    mocks.deleteObjects.mockResolvedValue(undefined); mocks.update.mockResolvedValue({});
    const res = response(); const next = vi.fn();
    await deleteMedia({ auth, params: { id: 'file' } } as never, res as never, next);
    expect(mocks.deleteObjects).toHaveBeenCalledWith(['production/cluster/photo.jpg']);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'file' }, data: { deletedAt: expect.any(Date) } });
    expect(res.status).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });
});
