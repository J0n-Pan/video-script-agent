import { prisma } from '../src/lib/db';
import { museStatePath } from '../src/lib/sources/muse-session-paths';

/**
 * 命令行脚本共用的「妙思会话属于谁」解析（2026-09-22 需求迭代）。
 *
 * ## 为什么需要它
 *
 * 会话已从「全机器一份」改为**一人一份**（`data/muse-session/users/<userId>/`）。
 * 命令行诊断脚本（muse-login / muse-probe / muse-detail-replay / muse-blocks-probe /
 * muse-insight-check）以前读的是全局那一份，现在必须知道「看谁的了」。
 *
 * ## 解析规则
 *
 * 1. 显式 `--user=<用户名>`：按用户名查（也接受完整 userId）。
 * 2. 不传：回落到**唯一的维护人员** —— 改动前的全局会话就是维护人员扫的，
 *    迁移脚本（`npm run muse:migrate`）也会把那份会话复制到维护人员名下，
 *    所以「不传 = 维护人员」与改动前的行为一致。
 * 3. 存在多个维护人员时不猜，直接报错让人显式指定 ——
 *    猜错人的诊断结论比没有结论更糟。
 */

export type MuseTarget = {
  userId: string;
  username: string;
  displayName: string;
  storageStatePath: string;
};

export async function resolveMuseTarget(userArg?: string): Promise<MuseTarget> {
  if (userArg) {
    const u =
      (await prisma.user.findUnique({ where: { username: userArg } })) ??
      (await prisma.user.findUnique({ where: { id: userArg } }));
    if (!u) {
      throw new Error(`找不到用户「${userArg}」，请确认账号名（或直接传 userId）`);
    }
    return {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      storageStatePath: museStatePath(u.id),
    };
  }

  const maintainers = await prisma.user.findMany({
    where: { role: 'MAINTAINER' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, username: true, displayName: true },
  });
  if (maintainers.length === 1) {
    const u = maintainers[0];
    return {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      storageStatePath: museStatePath(u.id),
    };
  }
  if (maintainers.length === 0) {
    throw new Error('库里没有维护人员账号，无法推断会话归属；请用 --user=<用户名> 显式指定');
  }
  throw new Error(
    `有 ${maintainers.length} 个维护人员账号（${maintainers.map((m) => m.username).join('、')}），` +
      '无法推断会话归属；请用 --user=<用户名> 显式指定',
  );
}

/** 从 argv 里取 --user=<用户名> */
export function readUserArg(argv: string[]): string | undefined {
  return argv.find((a) => a.startsWith('--user='))?.slice('--user='.length);
}
