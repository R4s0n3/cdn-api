import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkUploadStaging, sweepStaleUploads } from '../util/upload-staging';

afterEach(() => vi.unstubAllEnvs());
describe('upload staging', () => {
  it('removes only old owned files, preserving new uploads, unrelated files, and symlinks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'staging-test-'));
    try {
      vi.stubEnv('UPLOAD_TEMP_DIR', root);
      const stale = path.join(root, '00000000-0000-7000-8000-000000000001.jpg');
      const recent = path.join(
        root,
        '00000000-0000-7000-8000-000000000002.png',
      );
      const other = path.join(root, 'unrelated.txt');
      const link = path.join(root, '00000000-0000-7000-8000-000000000003.pdf');
      await Promise.all([
        writeFile(stale, 'old'),
        writeFile(recent, 'new'),
        writeFile(other, 'keep'),
      ]);
      await symlink(other, link);
      await utimes(stale, new Date(0), new Date(0));
      await sweepStaleUploads();
      await expect(access(stale)).rejects.toMatchObject({ code: 'ENOENT' });
      await Promise.all([access(recent), access(other), access(link)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('checks actual file creation and rejects an unusable staging path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'staging-probe-'));
    try {
      vi.stubEnv('UPLOAD_TEMP_DIR', path.join(root, 'uploads'));
      await checkUploadStaging();
      const blocked = path.join(root, 'blocked');
      await writeFile(blocked, 'not a directory');
      vi.stubEnv('UPLOAD_TEMP_DIR', blocked);
      await expect(checkUploadStaging()).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
