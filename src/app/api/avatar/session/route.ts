import { requireUser } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import {
  avatarHealthTtlMs,
  avatarNeedsAttention,
  isAvatarHealthStale,
  readAvatarControl,
  readAvatarHealth,
  writeAvatarControl,
} from '@/lib/avatar/session-state';
import { isAvatarWorkerRunning } from '@/lib/worker-lock';

export const dynamic = 'force-dynamic';

/**
 * 鲲之益（数字人平台）连接状态（2026-09-22 需求迭代）。
 *
 * 会话**全体共用一份**（平台形象/音色/额度由公司统一配置），所以这里
 * 不区分查看者 —— 人人看到同一个结论，人人都可以发起连接。
 *
 * 触发探测：与妙思同策略 —— 打开工作台时结论过期（TTL 15 分钟）就投递一次，
 * 由数字人进程执行真实浏览器探测（约 8~15 秒），web 只读结论文件。
 */
export async function GET() {
  try {
    const user = await requireUser();
    const health = readAvatarHealth();
    const stale = isAvatarHealthStale(health);
    const workerRunning = isAvatarWorkerRunning();

    const ctl = readAvatarControl();
    const requestedAt = ctl.probeRequestedAt ? Date.parse(ctl.probeRequestedAt) : Number.NaN;
    // 未确认的请求超过这个时长视为丢失（worker 可能在探测途中退出），允许重投
    const PENDING_TTL_MS = 90_000;
    const stillFresh = Number.isFinite(requestedAt) && Date.now() - requestedAt < PENDING_TTL_MS;
    const probePending = Boolean(ctl.probeRequestedAt && ctl.probeRequestedAt !== ctl.ackedProbeAt && stillFresh);

    let refreshRequested = false;
    if (stale && workerRunning && !probePending) {
      writeAvatarControl({ probeRequestedAt: new Date().toISOString() });
      refreshRequested = true;
    }

    return ok({
      health,
      stale,
      probePending,
      refreshRequested,
      workerRunning,
      ttlMs: avatarHealthTtlMs(),
      /** 前端据此决定是否自动弹出连接窗口 */
      needsAttention: avatarNeedsAttention(health),
      viewer: { id: user.id, displayName: user.displayName || user.username },
    });
  } catch (e) {
    return handleError(e);
  }
}

/** 手动「重新检测」：无视 TTL 强行投递一次探测 */
export async function POST(req: Request) {
  try {
    await requireUser();
    const body = await readJson<{ action?: string }>(req).catch(() => ({ action: 'probe' }));
    if (body.action && body.action !== 'probe') {
      return ok({ refreshRequested: false, reason: `不支持的操作：${body.action}` });
    }
    if (!isAvatarWorkerRunning()) {
      return ok({
        refreshRequested: false,
        reason: '数字人解析进程未运行，无法探测。请让维护人员启动工作台。',
      });
    }
    writeAvatarControl({ probeRequestedAt: new Date().toISOString() });
    return ok({ refreshRequested: true });
  } catch (e) {
    return handleError(e);
  }
}
