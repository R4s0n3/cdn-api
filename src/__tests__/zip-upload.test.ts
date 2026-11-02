import { type Server } from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const create = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'zip-file' }));
vi.mock('../db', () => ({ db: { file: { create } } }));
let server: Server;
let root: string;
let baseUrl: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zip-upload-'));
  vi.stubEnv('SERVER_ROOT', root);
  vi.stubEnv('CDN_API_KEY', 'zip-test-key');
  vi.stubEnv('S3_ENDPOINT', '');
  const { createApp } = await import('../app');
  server = await new Promise((resolve) => {
    const listener = createApp().listen(0, '127.0.0.1', () =>
      resolve(listener),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe('ZIP upload and permalink', () => {
  it('stores an archive and serves identical bytes as an attachment', async () => {
    const bytes = Buffer.alloc(22);
    bytes.writeUInt32LE(0x06054b50);
    const form = new FormData();
    form.set(
      'file',
      new File([bytes], 'archive.zip', { type: 'application/zip' }),
    );
    const response = await fetch(`${baseUrl}/api/upload/single`, {
      method: 'POST',
      headers: { 'X-API-Key': 'zip-test-key' },
      body: form,
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      files: { url: string; originalName: string }[];
    };
    expect(result.files[0]?.originalName).toBe('archive.zip');
    expect(result.files[0]?.url).toMatch(/^\/storage\/.+\.zip$/);
    const download = await fetch(`${baseUrl}${result.files[0]?.url}`);
    expect(download.headers.get('content-type')).toBe('application/zip');
    expect(download.headers.get('content-disposition')).toBe('attachment');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  });
  it('rejects fake ZIP content before saving metadata and removes the staged file', async () => {
    const before = await readdir(path.join(root, 'storage'));
    const form = new FormData();
    form.set(
      'file',
      new File(['not a ZIP'], 'fake.zip', {
        type: 'application/x-zip-compressed',
      }),
    );
    const response = await fetch(`${baseUrl}/api/upload/single`, {
      method: 'POST',
      headers: { 'X-API-Key': 'zip-test-key' },
      body: form,
    });
    expect(response.status).toBe(415);
    await response.arrayBuffer();
    expect(create).toHaveBeenCalledTimes(1);
    expect(await readdir(path.join(root, 'storage'))).toEqual(before);
  });
});
