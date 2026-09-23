import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * 口令不写死在代码里：公开仓库不携带任何可直接使用的凭据。
 * 部署时通过 .env 提供下列变量；**未提供就干脆不建这个账号**。
 *
 * 早期版本会退化成占位口令 'change-me-before-deploy'，而这个串就写在公开仓库里，
 * 等于给每个装了工作台的机器留了一把公开的钥匙。现在改成缺口令即跳过。
 */
function pickPassword(envKey: string): string | null {
  const v = process.env[envKey]?.trim();
  if (v) return v;
  console.warn(`[seed] 未设置 ${envKey}，跳过该账号（不创建任何可直接登录的账号）`);
  return null;
}

/**
 * 建号：一律标记为「首次登录须改密」。
 * update 分支刻意不动 passwordHash 与 mustChangePassword——
 * 重复跑 seed 不会把编导已改过的口令打回初始状态。
 */
async function upsertUser(username: string, password: string | null, displayName: string, role: string) {
  if (!password) return null;
  const passwordHash = bcrypt.hashSync(password, 10);
  const u = await prisma.user.upsert({
    where: { username },
    create: { username, displayName, passwordHash, role, mustChangePassword: true },
    update: { displayName, role, status: 'ACTIVE' },
  });
  // 不回显口令，避免终端历史与日志留痕
  console.log(`已配置账号：${username}（${role === 'MAINTAINER' ? '部署维护人员' : '编导'}，首次登录须改密）`);
  return u;
}

async function main() {
  // 账号由维护人员配置，不开放自助注册（PRD 2.1 实现约定）
  await upsertUser('maintainer', pickPassword('SEED_MAINTAINER_PASSWORD'), '部署维护人员', 'MAINTAINER');
  await upsertUser('editor', pickPassword('SEED_EDITOR_PASSWORD'), '首批编导', 'EDITOR');
  // 第二个账号用于验证多账号共享串行队列且互相不可见（验收 A13）。
  // 只在显式配置了口令时才建：装机分发不带它，免得多一个拿公开占位口令就能进的账号。
  await upsertUser('editor2', pickPassword('SEED_EDITOR2_PASSWORD'), '第二编导（联调用）', 'EDITOR');

  /**
   * 追加编导（多人测试部署用）。
   * 格式：SEED_EXTRA_EDITORS="用户名:口令:显示名,用户名2:口令2:显示名2"
   * 未设置时跳过；已存在的同名账号会重置口令并恢复启用。
   */
  const extra = process.env.SEED_EXTRA_EDITORS?.trim();
  if (extra) {
    for (const entry of extra.split(',')) {
      const [username, password, displayName] = entry.split(':').map((s) => s?.trim());
      if (!username || !password || !displayName) {
        console.warn(`[seed] SEED_EXTRA_EDITORS 条目格式不对（需 用户名:口令:显示名）：${entry}`);
        continue;
      }
      await upsertUser(username, password, displayName, 'EDITOR');
    }
  }
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
