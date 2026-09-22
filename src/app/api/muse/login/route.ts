import { HttpError, requireUser } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { readHealth, readLoginStatus, writeControl } from '@/lib/sources/muse-health';
import { isWorkerRunning } from '@/lib/worker-lock';

export const dynamic = 'force-dynamic';

/**
 * 网页内扫码登录（2026-09-20 需求迭代；2026-09-22 改为**人人可用、各扫各的**）。
 *
 * 流程：本端点只写「请求」，真正跑浏览器的是 worker（见 src/worker/muse-service.ts）。
 * 二维码图片由 worker 落到该用户自己的目录，前端从 /api/muse/login/qr 取。
 *
 * 为什么不在这里 spawn 子进程：Next dev 的 HMR / 重启会留下孤儿 Chromium，
 * 而且会与抓取抢同一个浏览器资源。交给 worker 后，任一时刻最多只有一个 Chromium。
 *
 * ## 2026-09-22 的权限变化（重要）
 *
 * 改动前：扫码接口硬门 `role !== 'MAINTAINER'` 直接 403，会话是**全机器共用的一份**，
 * 编导只能「请联系维护人员」。现在每个编导有自己的腾讯妙思账号，
 * 会话改成一人一份 —— 因此这里**不再看角色**，任何登录用户都能给自己扫码。
 *
 * 越权防线随之从「角色」移到「归属」：请求只写进 `users/<自己的 id>/control.json`，
 * 读也只读自己那一份。参数里**不接受任何 userId**，身份只来自会话 cookie ——
 * 一旦允许前端传 userId，任何人都能替别人发起登录、把别人的账号顶掉。
 */
export async function GET() {
  try {
    const user = await requireUser();
    return ok({
      status: readLoginStatus(user.id),
      health: readHealth(user.id),
      workerRunning: isWorkerRunning(),
      // 会话已按人隔离，所以「能不能操作」只取决于有没有登录，不再取决于角色
      canOperate: true,
    });
  } catch (e) {
    return handleError(e);
  }
}

/** action=start 开始扫码登录（force=true 换账号/强制重扫码）；action=cancel 取消正在等待的登录 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await readJson<{ action?: string; force?: boolean }>(req);
    const action = body.action ?? 'start';
    const force = body.force === true;

    if (!isWorkerRunning()) {
      throw new HttpError(
        409,
        '解析进程未运行，无法扫码登录。请先启动工作台（start-workbench.bat 或 npm run dev）。',
      );
    }

    if (action === 'start') {
      const cur = readLoginStatus(user.id);
      if (cur.phase === 'STARTING' || cur.phase === 'WAITING_SCAN') {
        return ok({ status: cur, alreadyRunning: true });
      }
      writeControl(user.id, {
        loginRequestedAt: new Date().toISOString(),
        loginRequestedBy: user.displayName || user.username,
        loginForce: force,
        // 清掉上一次的取消标记，否则新一轮会被立刻取消
        loginCancelAt: undefined,
      });
      return ok({ status: readLoginStatus(user.id), requested: true, force });
    }

    if (action === 'cancel') {
      writeControl(user.id, { loginCancelAt: new Date().toISOString() });
      return ok({ status: readLoginStatus(user.id), cancelled: true });
    }

    throw new HttpError(400, `不支持的操作：${action}`);
  } catch (e) {
    return handleError(e);
  }
}
