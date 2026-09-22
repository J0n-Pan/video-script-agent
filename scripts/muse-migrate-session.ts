import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/db';
import { museStatePath, museLegacyStatePath, museUserDir } from '../src/lib/sources/muse-session-paths';
import { readUserArg, resolveMuseTarget } from './_muse-target';

/**
 * 一次性迁移：把改动前的全局妙思会话复制到指定用户名下（2026-09-22 需求迭代）。
 *
 * ## 背景
 *
 * 会话从「全机器一份（data/muse-session/state.json，由维护人员扫码）」
 * 改成「一人一份（data/muse-session/users/<userId>/）」。
 * 老的那份会话是维护人员用自己的微信扫的 —— 它本来就属于维护人员，
 * 所以**复制**（不是移动）到维护人员名下，维护人员就不用重新扫码。
 *
 * ## 为什么是复制而不是移动
 *
 * 老文件保留着可以做对照（迁移前后行为差异排查）；它不再被任何代码读取
 * （所有读写都走 muse-session-paths），所以留着没有副作用，也不含什么敏感新增。
 * 想清掉的话手工删 data/muse-session/state.json 即可（.gitignore 已排除 data/）。
 *
 * ## 用法
 *
 *   npx tsx scripts/muse-migrate-session.ts                 # 迁给唯一的维护人员
 *   npx tsx scripts/muse-migrate-session.ts --user=editor   # 迁给指定用户（少见：那份会话是谁扫的就该给谁）
 *
 * 幂等：目标位置已有会话文件时不覆盖（退出码 0，说明无事可做）。
 */

async function main() {
  const src = museLegacyStatePath();
  if (!fs.existsSync(src)) {
    console.log(`没有找到老的全局会话（${src}），无需迁移。`);
    return;
  }

  const target = await resolveMuseTarget(readUserArg(process.argv.slice(2)));
  const dest = museStatePath(target.userId);

  if (fs.existsSync(dest)) {
    console.log(`${target.displayName}（${target.username}）名下已有会话文件，不覆盖：\n  ${dest}`);
    console.log('（如确实要覆盖，请先手工删掉目标文件再跑一次。）');
    return;
  }

  fs.mkdirSync(museUserDir(target.userId), { recursive: true });
  fs.copyFileSync(src, dest);

  const bytes = fs.statSync(dest).size;
  console.log('迁移完成：');
  console.log(`  来源  ${src}`);
  console.log(`  目标  ${dest}`);
  console.log(`  归属  ${target.displayName}（${target.username}）`);
  console.log(`  大小  ${(bytes / 1024).toFixed(1)} KB`);

  // 顺手看一眼 cookie 数量，确认复制的是一份有内容的会话
  try {
    const raw = JSON.parse(fs.readFileSync(dest, 'utf8'));
    const cookies = Array.isArray(raw?.cookies) ? raw.cookies.length : 0;
    console.log(`  cookie ${cookies} 条${cookies === 0 ? '（注意：0 条等同于未登录，建议重新扫码）' : ''}`);
  } catch {
    console.log('  （会话文件解析失败，建议重新扫码登录）');
  }
  console.log('\n下一步：重启解析进程（worker 会按用户目录读会话）。');
  console.log(`提示：老的全局会话文件保留在 ${path.dirname(src)} 作存档，不再被任何代码读取。`);
}

main()
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  })
  .then(() => prisma.$disconnect());
