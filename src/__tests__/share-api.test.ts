import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  files: vi.fn(),
  findFile: vi.fn(),
  createFile: vi.fn(),
  fileUpdate: vi.fn(),
  deleteObjects: vi.fn(),
  create: vi.fn(),
  find: vi.fn(),
  list: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
}));
vi.mock('../db', () => ({
  db: {
    file: {
      findMany: mocks.files,
      findFirst: mocks.findFile,
      create: mocks.createFile,
      updateMany: mocks.fileUpdate,
    },
    mediaShare: {
      create: mocks.create,
      findUnique: mocks.find,
      findMany: mocks.list,
      count: mocks.count,
      updateMany: mocks.update,
    },
  },
}));
vi.mock('../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config')>()),
  getConfig: () => ({ s3: { keyPrefix: 'production' } }),
}));
vi.mock('../storage/s3-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/s3-storage')>()),
  getObjectStorage: () => ({
    getObject: mocks.getObject,
    headObject: mocks.headObject,
    deleteObjects: mocks.deleteObjects,
  }),
}));
const date = new Date('2026-01-01T00:00:00Z');
const source = {
  id: 'file-1',
  fileName: 'test.zip',
  originalName: 'client files.zip',
  mimeType: 'application/zip',
  isPublic: true,
  size: 12,
  updatedAt: date,
  deletedAt: null as Date | null,
  url: '/storage/test.zip',
};
const token = 'a'.repeat(43);
let share: {
  id: string;
  title: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  files: {
    fileId: string;
    name: string;
    size: number;
    fileUpdatedAt: Date;
    file: typeof source;
  }[];
};
let server: Server;
let root: string;
let base: string;
const key = {
  'X-API-Key': 'owner-server-key',
  'Content-Type': 'application/json',
};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cdn-shares-'));
  vi.stubEnv('SERVER_ROOT', root);
  vi.stubEnv('S3_ENDPOINT', '');
  vi.stubEnv('CDN_API_KEY', 'owner-server-key');
  await mkdir(path.join(root, 'storage'), { recursive: true });
  await writeFile(path.join(root, 'storage', 'test.zip'), 'shared-bytes');
  const { createApp } = await import('../app');
  server = await new Promise((resolve) => {
    const instance = createApp().listen(0, '127.0.0.1', () =>
      resolve(instance),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  vi.clearAllMocks();
  await writeFile(path.join(root, 'storage', 'test.zip'), 'shared-bytes');
  await rm(path.join(root, 'private'), { recursive: true, force: true });
  vi.stubEnv('S3_ENDPOINT', '');
  share = {
    id: 'share-1',
    title: 'Client delivery',
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 86400000),
    revokedAt: null,
    files: [
      {
        fileId: source.id,
        name: source.originalName,
        size: source.size,
        fileUpdatedAt: date,
        file: { ...source },
      },
    ],
  };
  mocks.find.mockImplementation(
    ({ where }: { where: { tokenHash?: string; id?: string } }) =>
      Promise.resolve(
        where.tokenHash === share.tokenHash || where.id === share.id
          ? share
          : null,
      ),
  );
  mocks.files.mockResolvedValue([source]);
  mocks.create.mockResolvedValue({
    id: 'share-1',
    title: 'Client delivery',
    expiresAt: share.expiresAt,
  });
  mocks.update.mockImplementation(() => {
    share.revokedAt = new Date();
    return Promise.resolve({ count: 1 });
  });
  mocks.list.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (root) await rm(root, { force: true, recursive: true });
  vi.unstubAllEnvs();
});
async function request(url: string, init?: RequestInit) {
  return fetch(base + url, init);
}

describe('client media shares', () => {
  it('keeps a new private upload unreachable through every public raw-file path', async () => {
    const bytes = Buffer.alloc(22);
    bytes.writeUInt32LE(0x06054b50);
    mocks.createFile.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'private-file', ...data }),
    );
    const form = new FormData();
    form.set(
      'file',
      new File([bytes], 'client.zip', { type: 'application/zip' }),
    );
    const response = await request('/api/upload/single', {
      method: 'POST',
      headers: {
        'X-API-Key': 'owner-server-key',
        'X-Upload-Visibility': 'private',
      },
      body: form,
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      files: { id: string; filename: string; url: string; isPublic: boolean }[];
    };
    const saved = result.files[0]!;
    expect(saved.isPublic).toBe(false);
    expect(saved.url).toBe(`/private/${saved.filename}`);
    for (const url of [
      saved.url,
      `/storage/${saved.filename}`,
      `/assets/${saved.filename}`,
      '/private',
    ]) {
      const raw = await request(url);
      expect(raw.status).toBe(404);
      await raw.arrayBuffer();
    }
    const anonymous = await request('/api/upload/files/private-file/download');
    expect(anonymous.status).toBe(401);
    await anonymous.arrayBuffer();
    const privateFile = {
      ...source,
      id: saved.id,
      fileName: saved.filename,
      originalName: 'client.zip',
      size: bytes.length,
      isPublic: false,
      url: saved.url,
    };
    mocks.findFile.mockResolvedValue(privateFile);
    const owner = await request('/api/upload/files/private-file/download', {
      headers: key,
    });
    expect(owner.status).toBe(200);
    expect(Buffer.from(await owner.arrayBuffer())).toEqual(bytes);
    expect(owner.headers.get('cache-control')).toContain('no-store');
    share.files = [
      {
        fileId: saved.id,
        name: 'client.zip',
        size: bytes.length,
        fileUpdatedAt: date,
        file: privateFile,
      },
    ];
    const shared = await request(`/share/${token}/files/${saved.id}`);
    expect(shared.status).toBe(200);
    expect(Buffer.from(await shared.arrayBuffer())).toEqual(bytes);
    share.revokedAt = new Date();
    const revoked = await request(`/share/${token}/files/${saved.id}`);
    expect(revoked.status).toBe(404);
    await revoked.arrayBuffer();
  });
  it('moves an existing public file into private storage only after explicit authenticated action', async () => {
    const record = { ...source };
    mocks.findFile.mockResolvedValue(record);
    mocks.fileUpdate.mockImplementation(
      ({ data }: { data: Partial<typeof source> }) => {
        Object.assign(record, data, {
          updatedAt: new Date(date.getTime() + 1),
        });
        return Promise.resolve({ count: 1 });
      },
    );
    const unauthorized = await request(
      `/api/upload/files/${source.id}/private`,
      { method: 'POST' },
    );
    expect(unauthorized.status).toBe(401);
    await unauthorized.arrayBuffer();
    const result = await request(`/api/upload/files/${source.id}/private`, {
      method: 'POST',
      headers: key,
    });
    expect(result.status).toBe(200);
    await result.arrayBuffer();
    expect(record.isPublic).toBe(false);
    expect(record.url).toMatch(/^\/private\//);
    const oldLink = await request(source.url);
    expect(oldLink.status).toBe(404);
    await oldLink.arrayBuffer();
    const privateRaw = await request(record.url);
    expect(privateRaw.status).toBe(404);
    await privateRaw.arrayBuffer();
    const owner = await request(`/api/upload/files/${record.id}/download`, {
      headers: key,
    });
    expect(owner.status).toBe(200);
    expect(await owner.text()).toBe('shared-bytes');
  });
  it('can recover a privacy move after public deletion succeeds but the database update fails', async () => {
    const record = { ...source };
    mocks.findFile.mockResolvedValue(record);
    mocks.fileUpdate
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockImplementationOnce(({ data }: { data: Partial<typeof source> }) => {
        Object.assign(record, data);
        return Promise.resolve({ count: 1 });
      });
    const failed = await request(`/api/upload/files/${source.id}/private`, {
      method: 'POST',
      headers: key,
    });
    expect(failed.status).toBe(502);
    await failed.arrayBuffer();
    const oldLink = await request(source.url);
    expect(oldLink.status).toBe(404);
    await oldLink.arrayBuffer();
    const retry = await request(`/api/upload/files/${source.id}/private`, {
      method: 'POST',
      headers: key,
    });
    expect(retry.status).toBe(200);
    await retry.arrayBuffer();
    const owner = await request(`/api/upload/files/${record.id}/download`, {
      headers: key,
    });
    expect(await owner.text()).toBe('shared-bytes');
  });
  it('does not claim a public S3 object is private if source deletion fails, and supports retry', async () => {
    vi.stubEnv('S3_ENDPOINT', 'https://s3.example.com');
    const record = { ...source, url: '/storage/000000000001/test.zip' };
    mocks.findFile.mockResolvedValue(record);
    mocks.getObject.mockResolvedValue({
      Body: Readable.from(['shared-bytes']),
    });
    mocks.deleteObjects
      .mockRejectedValueOnce(new Error('S3 delete failed'))
      .mockResolvedValueOnce(undefined);
    mocks.fileUpdate.mockImplementation(
      ({ data }: { data: Partial<typeof source> }) => {
        Object.assign(record, data);
        return Promise.resolve({ count: 1 });
      },
    );
    const failed = await request(`/api/upload/files/${source.id}/private`, {
      method: 'POST',
      headers: key,
    });
    expect(failed.status).toBe(502);
    await failed.arrayBuffer();
    expect(record.isPublic).toBe(true);
    expect(mocks.fileUpdate).not.toHaveBeenCalled();
    const retry = await request(`/api/upload/files/${source.id}/private`, {
      method: 'POST',
      headers: key,
    });
    expect(retry.status).toBe(200);
    await retry.arrayBuffer();
    expect(record.isPublic).toBe(false);
    expect(mocks.getObject).toHaveBeenCalledTimes(1);
    expect(mocks.deleteObjects).toHaveBeenLastCalledWith([
      'production/000000000001/test.zip',
    ]);
    const owner = await request(`/api/upload/files/${record.id}/download`, {
      headers: key,
    });
    expect(await owner.text()).toBe('shared-bytes');
  });
  it('does not expose storage listings or accept private named-asset uploads', async () => {
    for (const url of [
      '/storage',
      '/assets',
      '/private',
      '/api/upload/files',
    ]) {
      const response = await request(url);
      expect([401, 404]).toContain(response.status);
      await response.arrayBuffer();
    }
    const response = await request('/api/upload/asset', {
      method: 'POST',
      headers: { ...key, 'X-Upload-Visibility': 'private' },
    });
    expect(response.status).toBe(400);
    await response.arrayBuffer();
  });
  it('requires the deployment key for every management endpoint', async () => {
    for (const [method, url] of [
      ['POST', '/api/upload/shares'],
      ['GET', '/api/upload/shares'],
      ['DELETE', '/api/upload/shares/share-1'],
    ]) {
      const response = await request(url!, { method });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('creates a random token, persists only its hash, and snapshots the selected file revision', async () => {
    const response = await request('/api/upload/shares', {
      method: 'POST',
      headers: key,
      body: JSON.stringify({
        title: 'Client delivery',
        fileIds: [source.id],
        expiresInDays: 7,
      }),
    });
    expect(response.status).toBe(201);
    const result = (await response.json()) as { token: string };
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const saved = mocks.create.mock.calls[0]?.[0] as {
      data: { tokenHash: string; files: { create: unknown[] } };
    };
    expect(saved.data.tokenHash).toBe(
      createHash('sha256').update(result.token).digest('hex'),
    );
    expect(JSON.stringify(saved)).not.toContain(result.token);
    expect(saved.data.files.create).toEqual([
      {
        fileId: source.id,
        name: source.originalName,
        size: source.size,
        fileUpdatedAt: date,
      },
    ]);
  });
  it('rejects missing files and excessive selections', async () => {
    mocks.files.mockResolvedValue([]);
    const missing = await request('/api/upload/shares', {
      method: 'POST',
      headers: key,
      body: JSON.stringify({ title: 'test', fileIds: ['missing'] }),
    });
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
    const excess = await request('/api/upload/shares', {
      method: 'POST',
      headers: key,
      body: JSON.stringify({
        title: 'test',
        fileIds: Array.from({ length: 51 }, (_, index) => `file-${index}`),
      }),
    });
    expect(excess.status).toBe(400);
    await excess.arrayBuffer();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('exposes only selected metadata, never source permalinks or credentials', async () => {
    const response = await request(`/share/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const data = await response.text();
    expect(data).toContain('client files.zip');
    expect(data).not.toContain('/storage/');
    expect(data).not.toContain('owner-server-key');
    expect(data).not.toContain('tokenHash');
  });
  it('downloads matching bytes as an attachment and supports byte ranges and HEAD', async () => {
    const url = `/share/${token}/files/${source.id}`;
    const response = await request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain(
      'client files.zip',
    );
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.text()).toBe('shared-bytes');
    const range = await request(url, { headers: { Range: 'bytes=0-5' } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('shared');
    const head = await request(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });
  it('streams private S3 data without exposing its source URL or cache settings', async () => {
    vi.stubEnv('S3_ENDPOINT', 'https://s3.example.com');
    share.files[0]!.file = { ...source, url: '/storage/000000000001/test.zip' };
    mocks.getObject.mockResolvedValue({
      Body: Readable.from(['shared-bytes']),
      ContentLength: 12,
      ContentType: 'text/html',
      CacheControl: 'public, max-age=31536000',
    });
    const response = await request(`/share/${token}/files/${source.id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('shared-bytes');
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(mocks.getObject).toHaveBeenCalledWith(
      'production/000000000001/test.zip',
      undefined,
    );
  });
  it('rejects malformed tokens before looking up a share', async () => {
    const response = await request('/share/too-short');
    expect(response.status).toBe(404);
    await response.arrayBuffer();
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it('blocks files not selected for the share', async () => {
    const response = await request(`/share/${token}/files/another-file`);
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  });
  it('checks expiry and revocation on both the page metadata and download requests', async () => {
    for (const state of ['expired', 'revoked']) {
      share.expiresAt = new Date(Date.now() + 86400000);
      share.revokedAt = null;
      if (state === 'expired') share.expiresAt = new Date(Date.now() - 1);
      else share.revokedAt = new Date();
      for (const path of [
        `/share/${token}`,
        `/share/${token}/files/${source.id}`,
      ]) {
        const response = await request(path);
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toContain('no-store');
        await response.arrayBuffer();
      }
    }
  });
  it('revokes a share through the authenticated API and immediately blocks its download', async () => {
    const revoked = await request('/api/upload/shares/share-1', {
      method: 'DELETE',
      headers: key,
    });
    expect(revoked.status).toBe(204);
    const response = await request(`/share/${token}/files/${source.id}`);
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  });
  it('blocks deleted or replaced files without changing the other share entries', async () => {
    for (const state of ['deleted', 'changed']) {
      share.files[0]!.file = {
        ...source,
        ...(state === 'deleted'
          ? { deletedAt: new Date() }
          : { updatedAt: new Date(date.getTime() + 1) }),
      } as typeof source;
      const metadata = await request(`/share/${token}`);
      const body = (await metadata.json()) as {
        files: { available: boolean }[];
      };
      expect(body.files[0]?.available).toBe(false);
      const response = await request(`/share/${token}/files/${source.id}`);
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    }
  });
  it('does not follow a disk symlink outside the storage root', async () => {
    const outside = path.join(root, 'secret.txt');
    await writeFile(outside, 'private');
    await symlink(outside, path.join(root, 'storage', 'escape.zip'));
    share.files[0]!.file = {
      ...source,
      fileName: 'escape.zip',
      url: '/storage/escape.zip',
    };
    const response = await request(`/share/${token}/files/${source.id}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('private');
  });
});
