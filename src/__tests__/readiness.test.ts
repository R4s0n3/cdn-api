import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  bucket: vi.fn(),
  staging: vi.fn(),
}));
vi.mock('../config', () => ({ getConfig: () => ({ readinessTimeoutMs: 20 }) }));
vi.mock('../db', () => ({ db: { $queryRawUnsafe: mocks.database } }));
vi.mock('../storage/s3-storage', () => ({
  getObjectStorage: () => ({ checkBucket: mocks.bucket }),
}));
vi.mock('../util/upload-staging', () => ({
  checkUploadStaging: mocks.staging,
}));
import { getReadiness } from '../controllers/health-controllers';
function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.bucket.mockResolvedValue(undefined);
  mocks.staging.mockResolvedValue(undefined);
  mocks.database.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('readiness', () => {
  it('reports unavailable if staging is unwritable even with healthy dependencies', async () => {
    mocks.staging.mockRejectedValue(new Error('read-only filesystem'));
    const res = response();
    await getReadiness({} as never, res as never);
    expect(res.status).toHaveBeenCalledWith(503);
  });
  it('does not issue more database probes while a timed-out query remains pending', async () => {
    let resolveQuery!: (value: unknown) => void;
    mocks.database.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const first = response();
    const running = getReadiness({} as never, first as never);
    await vi.advanceTimersByTimeAsync(21);
    await running;
    expect(first.status).toHaveBeenCalledWith(503);
    const second = response();
    await getReadiness({} as never, second as never);
    expect(second.status).toHaveBeenCalledWith(503);
    expect(mocks.database).toHaveBeenCalledTimes(1);
    resolveQuery([]);
    await vi.advanceTimersByTimeAsync(0);
    const recovered = response();
    await getReadiness({} as never, recovered as never);
    expect(recovered.status).toHaveBeenCalledWith(200);
    expect(mocks.database).toHaveBeenCalledTimes(2);
  });
});
