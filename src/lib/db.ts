import { PrismaClient } from '@prisma/client';
import { loadDotEnv } from './load-env';

// 必须先加载 .env 再实例化：独立进程不会自动读取，否则 DATABASE_URL 会回落到默认值。
loadDotEnv();

// 开发环境下 Next.js 热重载会重复实例化，挂到 globalThis 复用；同时启用 WAL 提升本地并发写稳定性。
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log: process.env.PRISMA_VERBOSE === 'true' ? ['warn', 'error'] : ['error'],
  });

if (!globalForPrisma.__prisma) {
  globalForPrisma.__prisma = prisma;
}

let pragmaDone = false;
/** 本地 SQLite 调优：WAL + busy_timeout，避免网页与解析进程互相锁死 */
export async function ensureSqlitePragmas() {
  if (pragmaDone) return;
  try {
    // 注意：PRAGMA 会返回结果行，必须用 $queryRawUnsafe；用 $executeRawUnsafe 会报
    // "Execute returned results, which is not allowed in SQLite"。
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=8000;');
    await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL;');
    pragmaDone = true;
  } catch {
    // 首次初始化（表尚未建立）时忽略
  }
}
