import { PrismaClient } from '@prisma/client';

const createPrismaClient = () =>
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : [],
  });

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function getDb(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }
  return globalForPrisma.prisma;
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getDb();
    const value = client[prop as keyof PrismaClient];
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
});

export async function disconnectDb(): Promise<void> {
  if (!globalForPrisma.prisma) return;
  await globalForPrisma.prisma.$disconnect();
  globalForPrisma.prisma = undefined;
}
