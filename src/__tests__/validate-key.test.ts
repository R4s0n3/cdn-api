import { beforeEach, describe, expect, it, vi } from 'vitest';

const findFirst = vi.hoisted(() => vi.fn());

vi.mock('../db', () => ({
  db: {
    apiKey: {
      findFirst,
    },
  },
}));

import validateKey from '../middleware/validate-key';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('validateKey', () => {
  it('rejects soft-deleted API keys at the database query', async () => {
    findFirst.mockResolvedValue(null);
    const next = vi.fn();

    await validateKey(
      {
        header: vi.fn().mockReturnValue('revoked-key'),
      } as never,
      {} as never,
      next,
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        key: 'revoked-key',
      },
    });
    expect(next.mock.calls[0]?.[0]).toMatchObject({ code: 403 });
  });

  it('returns a fixed server error without exposing a database failure', async () => {
    findFirst.mockRejectedValue(new Error('mysql://private-host/schema details'));
    const next = vi.fn();

    await validateKey(
      {
        header: vi.fn().mockReturnValue('api-key'),
      } as never,
      {} as never,
      next,
    );

    expect(next.mock.calls[0]?.[0]).toMatchObject({
      code: 500,
      message: 'Internal server error; try again later',
    });
  });
});
