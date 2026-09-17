import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * 口令不写死在代码里：公开仓库不携带任何可直接使用的凭据。
 * 部署时通过 .env 提供下列变量；未提供时退化为占位口令，脚本会打印提醒。
 */
const PLACEHOLDER_PASSWORD = 'change-me-before-deploy';

function pickPassword(envKey: string): string {
  const v = process.env[envKey]?.trim();
  if (v) return v;
  console.warn(`[seed] 未设置 ${envKey}，本次使用占位口令（部署前请务必替换）`);
  return PLACEHOLDER_PASSWORD;
}

async function upsertUser(username: string, password: string, displayName: string, role: string) {
  const passwordHash = bcrypt.hashSync(password, 10);
  const u = await prisma.user.upsert({
    where: { username },
    create: { username, displayName, passwordHash, role },
    update: { displayName, role, status: 'ACTIVE' },
  });
  // 不回显口令，避免终端历史与日志留痕
  console.log(`已配置账号：${username}（${role === 'MAINTAINER' ? '部署维护人员' : '编导'}）`);
  return u;
}

async function main() {
  // 账号由维护人员配置，不开放自助注册（PRD 2.1 实现约定）
  await upsertUser('maintainer', pickPassword('SEED_MAINTAINER_PASSWORD'), '部署维护人员', 'MAINTAINER');
  await upsertUser('editor', pickPassword('SEED_EDITOR_PASSWORD'), '首批编导', 'EDITOR');
  // 第二个账号用于验证多账号共享串行队列且互相不可见（验收 A13）
  await upsertUser('editor2', pickPassword('SEED_EDITOR2_PASSWORD'), '第二编导（联调用）', 'EDITOR');
  console.log('种子数据完成。');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
