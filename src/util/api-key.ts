import { createHmac, timingSafeEqual } from 'crypto';

const digestKey = Buffer.from('cdn-api-key');

export function apiKeysMatch(provided: string, expected: string): boolean {
  const providedDigest = createHmac('sha256', digestKey).update(provided, 'utf8').digest();
  const expectedDigest = createHmac('sha256', digestKey).update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
