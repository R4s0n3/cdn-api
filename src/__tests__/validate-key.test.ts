import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import validateKey from '../middleware/validate-key';

beforeEach(() => {
  vi.stubEnv('CDN_API_KEY', 'configured-key');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('validateKey', () => {
  it('rejects missing credentials', () => {
    const next = vi.fn();
    validateKey({ header: () => undefined } as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 401 }));
  });
  it('rejects incorrect credentials', () => {
    const next = vi.fn();
    validateKey({ header: () => 'wrong-key' } as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 403 }));
  });
  it('rejects credentials when the server key is unconfigured', () => {
    vi.stubEnv('CDN_API_KEY', '');
    const next = vi.fn();
    validateKey({ header: () => 'configured-key' } as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 403 }));
  });
  it('authenticates the configured deployment key', () => {
    const next = vi.fn();
    const request = { header: () => 'configured-key', auth: undefined };
    validateKey(request as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
    expect(request.auth).toMatchObject({ apiKey: 'configured-key' });
  });
});
