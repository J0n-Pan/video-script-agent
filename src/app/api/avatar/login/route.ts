import { HttpError, requireUser } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import {
  readAvatarControl,
  readAvatarHealth,
  readAvatarLoginStatus,
  writeAvatarControl,
} from '@/lib/avatar/session-state';
import { isAvatarWorkerRunning } from '@/lib/worker-lock';

export const dynamic = 'force-dynamic';

/**
 * 鲲之益账号密码连接（2026-09-22 需求迭代）。
 *
 * 流程：本端点只把「登录请求 + 凭据」写进 control.json，真正开浏览器登录的是
 * 数字人进程（见 src/worker/avatar.ts 的 serviceAvatarLogin）。
 * 进度写 login-status.json，前端轮询本端点 GET 展示。
 *
 * ## 凭据处理（重要）
 *
 * 账号密码经这里写进 control.json，worker 取件后**立即清除**——凭据只在文件里
 * 存在「写入到取件」这一小段（通常不到 5 秒）。不入库、不进日志、响应不回显。
 * 连接成功后会话保存在服务器 data/avatar-session/state.json（全体共用一份）。
 *
 * ## 权限
 *
 * 会话全体共用一份（与妙思的一人一份不同），且数字人平台账号是公司统一配置的
 * —— 因此任何登录用户都可以发起连接（需求方 2026-09-22 确认）。
 * 身份只来自会话 cookie，**不接受任何 userId 参数**。
 */
export async function GET() {
  try {
    const user = await requireUser();
    return ok({
      status: readAvatarLoginStatus(),
      health: readAvatarHealth(),
      workerRunning: isAvatarWorkerRunning(),
      canOperate: true,
      viewer: { id: user.id, displayName: user.displayName || user.username },
    });
  } catch (e) {
    return handleError(e);
  }
}

/** action=start 发起账号密码登录；action=cancel 取消进行中的登录 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await readJson<{ action?: string; username?: string; password?: string }>(req);
    const action = body.action ?? 'start';

    if (action === 'cancel') {
      writeAvatarControl({ loginCancelAt: new Date().toISOString() });
      return ok({ status: readAvatarLoginStatus(), cancelled: true });
    }
    if (action !== 'start') {
      throw new HttpError(400, `不支持的操作：${action}`);
    }

    if (!isAvatarWorkerRunning()) {
      throw new HttpError(409, '数字人解析进程未运行，无法连接。请让维护人员启动工作台。');
    }

    const username = body.username?.trim() ?? '';
    const password = body.password ?? '';
    if (!username || !password) {
      throw new HttpError(400, '请填写鲲之益的账号和密码。');
    }

    const cur = readAvatarLoginStatus();
    if (cur.phase === 'STARTING' || cur.phase === 'LOGGING_IN') {
      return ok({ status: cur, alreadyRunning: true });
    }

    writeAvatarControl({
      loginRequestedAt: new Date().toISOString(),
      loginRequestedBy: user.displayName || user.username,
      loginUsername: username,
      loginPassword: password,
      loginCancelAt: undefined,
    });
    return ok({ status: readAvatarLoginStatus(), requested: true });
  } catch (e) {
    return handleError(e);
  }
}
