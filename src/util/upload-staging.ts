import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Resolve the shared staging directory used by S3 and named asset uploads. */
export function getUploadTempDirectory(): string {
  return (
    process.env.UPLOAD_TEMP_DIR || path.join(os.tmpdir(), 'cdn-api-uploads')
  );
}

/** Verify staging with an actual private file write and remove the probe afterward. */
export async function checkUploadStaging(): Promise<void> {
  const directory = getUploadTempDirectory();
  await fs.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.readiness-${randomUUID()}`);
  const handle = await fs.open(probe, 'wx', 0o600);
  try {
    await handle.writeFile('probe');
  } finally {
    await handle.close();
    await fs.unlink(probe);
  }
}

// Only our UUID-named staged files older than a day; never follow symlinks.
/** Remove only UUID-named regular staged files older than 24 hours, preserving other contents. */
export async function sweepStaleUploads(now = Date.now()): Promise<void> {
  const directory = getUploadTempDirectory();
  await fs.mkdir(directory, { recursive: true });
  const names = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of names) {
    if (
      !entry.isFile() ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(jpg|png|pdf|gif|webp|avif|svg|zip)$/i.test(
        entry.name,
      )
    )
      continue;
    const target = path.join(directory, entry.name);
    try {
      const stat = await fs.lstat(target);
      if (stat.isFile() && stat.mtimeMs < now - 24 * 60 * 60 * 1000)
        await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
