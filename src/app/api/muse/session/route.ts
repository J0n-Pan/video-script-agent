import { requireUser } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import {
  healthTtlMs,
  isHealthStale,
  needsAttention,
  readControl,
  readHealth,
  writeControl,
} from '@/lib/sources/muse-health';
import { isWorkerRunning } from '@/lib/worker-lock';

export const dynamic = 'force-dynamic';

/**
 * 妙思登录态健康状态（2026-09-20 需求迭代；2026-09-22 改为**只看自己的会话**）。
 *
 * 改动前：会话全机器共用，所以「谁能看到」没差别，人人都看同一份结论。
 * 改动后：每个编导扫自己的腾讯妙思账号，**每个人看到的都是自己那份** ——
 * 别人的会话过期不该弹到你头上，你的过期也不能指望别人发现。
 *
 * 触发探测：不做定时任务，**只在打开工作台时**检查一次（按需求约定）；
 *          结论未过期（TTL 内）不重复探测，避免在页面之间点来点去就反复花 10 秒。
 *
 * 探测本身由 worker 执行（Chromium 单一所有者），这里只投递请求并读结论。
 * 请求写进 `users/<自己的 id>/control.json`，worker 每轮遍历所有用户的通道。
 */
export async function GET() {
  try {
    const user = await requireUser();
    const health = readHealth(user.id);
    const stale = isHealthStale(health);
    const workerRunning = isWorkerRunning();

    // 结论过期（含从未检测）且解析进程在线 → 投递一次探测请求。
    // 已有未处理的请求就不重复投递：前端会周期轮询本端点，
    // 否则 worker 还没轮询到时会被反复覆盖时间戳。
    const ctl = readControl(user.id);
    const requestedAt = ctl.probeRequestedAt ? Date.parse(ctl.probeRequestedAt) : Number.NaN;
    // 未确认的请求超过这个时长即视为已丢失（worker 可能在探测途中退出）。
    // 不做这个兜底的话，一旦请求没被确认，提示栏会永远停在「正在检测…」。
    const PENDING_TTL_MS = 90_000;
    const stillFresh = Number.isFinite(requestedAt) && Date.now() - requestedAt < PENDING_TTL_MS;
    const probePending = Boolean(
      ctl.probeRequestedAt && ctl.probeRequestedAt !== ctl.ackedProbeAt && stillFresh,
    );
    let refreshRequested = false;
    if (stale && workerRunning && !probePending) {
      writeControl(user.id, { probeRequestedAt: new Date().toISOString() });
      refreshRequested = true;
    }

    return ok({
      health,
      stale,
      probePending,
      refreshRequested,
      workerRunning,
      ttlMs: healthTtlMs(),
      /** 结论是否需要人工处理 —— 前端据此决定横幅是否出现 */
      needsAttention: needsAttention(health),
      /** 会话按人隔离：任何登录用户都能给自己扫码 */
      canOperate: true,
      /**
       * 查看者身份。
       *
       * 为什么要下发：提示栏的「收起」记忆存在浏览器 sessionStorage 里，
       * 会话按人隔离后必须**按人区分** —— 否则同一台机器上换个账号登录，
       * 会把上一个人的「收起」继承过来，故障提示被静默吞掉。
       */
      viewer: { id: user.id, displayName: user.displayName || user.username },
    });
  } catch (e) {
    return handleError(e);
  }
}

/** 手动「重新检测」：无视 TTL 强行投递一次探测 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await readJson<{ action?: string }>(req).catch(() => ({ action: 'probe' }));
    if (body.action && body.action !== 'probe') {
      return ok({ refreshRequested: false, reason: `不支持的操作：${body.action}` });
    }
    if (!isWorkerRunning()) {
      return ok({
        refreshRequested: false,
        reason: '解析进程未运行，无法探测。请先启动工作台（start-workbench.bat）。',
      });
    }
    writeControl(user.id, { probeRequestedAt: new Date().toISOString() });
    return ok({ refreshRequested: true });
  } catch (e) {
    return handleError(e);
  }
}
