import { type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
const reads = vi.hoisted(() =>
  vi.fn(
    (_req: unknown, res: { status: (code: number) => { end: () => void } }) =>
      res.status(200).end(),
  ),
);
vi.mock('../controllers/storage-controllers', () => ({
  getStoredFile: reads,
  headStoredFile: reads,
}));
import { createApp } from '../app';
import { type AppConfig } from '../config';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('public S3 download protection', () => {
  it('limits requests even if direct clients vary X-Forwarded-For', async () => {
    vi.stubEnv('TRUST_PROXY', '0');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({
      publicApiBaseUrl: 'https://cdn.example.com',
    } as AppConfig);
    expect(app.get('trust proxy')).toBe(0);
    const server: Server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No test port');
      const url = `http://127.0.0.1:${address.port}/storage/000000000001/file.jpg`;
      for (let index = 0; index < 300; index += 1) {
        const response = await fetch(url, {
          headers: index
            ? { 'X-Forwarded-For': `203.0.113.${index % 250}` }
            : {},
        });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
      const blocked = await fetch(url, {
        headers: { 'X-Forwarded-For': '198.51.100.1' },
      });
      expect(blocked.status).toBe(429);
      await blocked.arrayBuffer();
      expect(reads).toHaveBeenCalledTimes(300);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
