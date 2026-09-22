import fs from 'node:fs';
import path from 'node:path';
import {
  IDLE_LOGIN,
  controlPath,
  probeMuseSession,
  qrPath,
  readControl,
  readHealth,
  readLoginOwner,
  readLoginStatus,
  writeControl,
  writeLoginOwner,
  writeLoginStatus,
} from '../lib/sources/muse-health';
import { listMuseUserIds, museSessionRoot } from '../lib/sources/muse-session-paths';
import { runMuseLogin } from '../lib/sources/muse-login-flow';

/**
 * 解析进程里的妙思会话服务（2026-09-20 需求迭代；2026-09-22 改为**按用户**）。
 *
 * 为什么放在 worker 而不是 web（Next.js）进程里：
 *   1. Chromium 只允许一个所有者 —— 抓取本来就在 worker 里开浏览器，
 *      探测与扫码登录也放这里，避免两个进程同时开 Chromium 抢内存；
 *   2. web 请求不会被探测阻塞 10 秒；
 *   3. Next dev 的 HMR/重启不会留下孤儿 Chromium。
 *
 * 通信方式是最朴素的**单向文件协议**（web 写请求、worker 读并执行、结果写回文件），
 * 不引入新表、新队列，也不让 web 反过来调 worker。
 *
 * ## 2026-09-22：从「一份全局会话」改成「一人一份」
 *
 * 每个编导用**自己的腾讯妙思账号**，所以：
 *   - 每个用户一条独立通道 `data/muse-session/users/<userId>/control.json`；
 *   - 本服务每轮**遍历所有用户的通道**，发现请求就处理；
 *   - 但**扫码登录一次只处理一个** —— Chromium 只有一个，
 *     其余人的请求留在文件里等着，同时把「前面是谁在扫」写进他们的登录状态，
 *     这样排队的人看到的是一句准确的话，而不是盯着「正在打开登录页…」猜是不是卡了。
 *
 * 探测也是开浏览器的操作，同样串行、每轮**最多处理一个**（轮转，避免总是同一个人优先）。
 */
const log = (s: string) => console.log(`[worker][muse] ${s}`);

/** 每个用户已处理过的登录请求时间戳，避免同一条请求被反复触发 */
const handledLoginRequestAt = new Map<string, string>();
/** 已经播报过的取消请求时间戳，避免每轮主循环都刷一行日志 */
const loggedCancelAt = new Map<string, string>();
/** 探测轮转游标：上一轮处理到第几个用户 */
let probeCursor = 0;
let loginBusy = false;

/** 主循环用：登录进行中就不要领新任务，保证同时只有一个 Chromium */
export function museLoginBusy(): boolean {
  return loginBusy;
}

/** 当前正在扫码的用户 id（供界面提示排队原因） */
function currentLoginOwnerId(): string | null {
  return readLoginOwner()?.userId ?? null;
}

/**
 * 每轮主循环调用一次（廉价：读若干个小 JSON 文件）。
 *
 * 探测是短任务（约 10 秒），直接 await；登录是长任务（等扫码最长 10 分钟），
 * 放到后台跑，但期间不领新任务。
 */
export async function serviceMuseControl(): Promise<void> {
  const userIds = listMuseUserIds();
  if (userIds.length === 0) return;

  // ① 探测请求：每轮最多处理一个（开浏览器约 10 秒，串行避免 N 个用户一起爆内存）
  await serviceOneProbe(userIds);

  // ② 取消请求：只播报一次，否则主循环每轮都会打一行
  for (const userId of userIds) {
    let ctl;
    try {
      ctl = readControl(userId);
    } catch {
      continue;
    }
    if (ctl.loginCancelAt && ctl.loginCancelAt !== loggedCancelAt.get(userId)) {
      loggedCancelAt.set(userId, ctl.loginCancelAt);
      if (loginBusy && currentLoginOwnerId() === userId) log('收到取消登录请求');
    }
  }

  // ③ 登录请求：一次只处理一个
  await serviceOneLogin(userIds);

  // ④ 排队提示：正在等别人扫完的人，界面上要说清在等谁
  syncQueueHints(userIds);
}

/** 挑一个用户的过期结论去探测（轮转，避免总是同一个人被优先/被饿死） */
async function serviceOneProbe(userIds: string[]): Promise<void> {
  for (let i = 0; i < userIds.length; i += 1) {
    const idx = (probeCursor + i) % userIds.length;
    const userId = userIds[idx];
    let ctl;
    try {
      ctl = readControl(userId);
    } catch (e) {
      log(`读取控制文件失败（${userId}）：${(e as Error).message}`);
      continue;
    }
    if (!ctl.probeRequestedAt || ctl.probeRequestedAt === ctl.ackedProbeAt) continue;

    probeCursor = (idx + 1) % userIds.length;
    writeControl(userId, { ackedProbeAt: ctl.probeRequestedAt });
    try {
      const h = await probeMuseSession(userId);
      log(`登录态探测完成（${userId}）：${h.status}（${h.costMs ?? '-'}ms）`);
    } catch (e) {
      log(`登录态探测异常（${userId}）：${(e as Error).message}`);
    }
    return;
  }
}

/** 处理一个登录请求（有请求且当前没有登录在跑时才动） */
async function serviceOneLogin(userIds: string[]): Promise<void> {
  if (loginBusy) return; // 正在有人扫码：其余请求留在文件里排队，下轮再看

  for (const userId of userIds) {
    let ctl;
    try {
      ctl = readControl(userId);
    } catch {
      continue;
    }
    if (!ctl.loginRequestedAt) continue;
    if (ctl.loginRequestedAt === handledLoginRequestAt.get(userId)) continue;

    // 请求在取件前就被取消了（「开始扫码」后几毫秒内点「取消」的竞态）：
    // 取消时间晚于请求时间 → 这条请求是死的，直接记为已取消，绝不能开浏览器 ——
    // 否则一个没人扫的二维码会占住唯一的 Chromium，把后面所有人的请求堵在队列里。
    // （ISO 8601 同格式字符串可直接按字典序比较时间。）
    if (ctl.loginCancelAt && ctl.loginCancelAt >= ctl.loginRequestedAt) {
      handledLoginRequestAt.set(userId, ctl.loginRequestedAt);
      writeLoginStatus(userId, {
        phase: 'CANCELLED',
        message: '登录请求已取消。',
        queuedBehind: undefined,
      });
      log(`登录请求在执行前已被取消，跳过（${ctl.loginRequestedBy ?? '未知'}）`);
      continue;
    }

    const by = ctl.loginRequestedBy ?? '未知';
    const force = ctl.loginForce === true;
    const cancelAt = ctl.loginCancelAt ?? null;

    loginBusy = true;
    // 「已受理」必须记在**真正开始执行之后**：
    // 若在这里之前就标记，忙碌期间收到的请求会被当成已处理而永远丢失 ——
    // 用户界面上却毫无异样（请求静静地躺在 control 里没人理）。
    handledLoginRequestAt.set(userId, ctl.loginRequestedAt);

    // 记下「现在这台浏览器归谁用」，排队的人靠它知道在等谁
    writeLoginOwner({ userId, displayName: by, startedAt: new Date().toISOString() });
    writeLoginStatus(userId, {
      phase: 'STARTING',
      startedAt: new Date().toISOString(),
      message: force ? '正在打开腾讯妙思登录页（强制重新登录，用于更换账号）…' : '正在打开腾讯妙思登录页…',
      qrAt: null,
      qrExpiresAt: null,
      startedBy: by,
      queuedBehind: undefined,
    });
    log(`开始扫码登录（${by}${force ? '，强制重新登录' : ''}）`);

    // 后台执行，不阻塞主循环（但主循环会因 museLoginBusy() 暂停领任务）
    void runMuseLogin({
      ownerId: userId,
      headless: true,
      force,
      hooks: {
        onLog: (s) => log(s),
        onPhase: (phase, message) => writeLoginStatus(userId, { phase, message }),
        onQr: (jpeg, meta) => {
          try {
            fs.mkdirSync(path.dirname(qrPath(userId)), { recursive: true });
            fs.writeFileSync(qrPath(userId), jpeg);
          } catch (e) {
            log(`二维码写盘失败（${userId}）：${(e as Error).message}`);
          }
          writeLoginStatus(userId, {
            phase: 'WAITING_SCAN',
            qrAt: new Date().toISOString(),
            qrExpiresAt: meta.expiresAt,
            message: '请使用微信扫描二维码完成登录。',
          });
        },
        shouldCancel: () => {
          // 取消：control 里出现比本次请求更晚的 loginCancelAt。
          // 取件时就已存在的取消标记只有一种情况是「残留」：它比本次请求还早
          // （上一轮的取消没清掉）。晚于请求的取消说明请求本身已被取消
          // —— 虽然上面的取件检查正常情况下拦得住，这里仍要兜底。
          const c = readControl(userId);
          if (!c.loginCancelAt) return false;
          if (cancelAt && c.loginCancelAt === cancelAt && cancelAt < (ctl.loginRequestedAt ?? '')) {
            return false; // 早于本次请求的旧取消：残留，忽略
          }
          return true;
        },
      },
    })
      .then((r) => {
        if (r.ok) {
          // runMuseLogin 内部已 markFromFetch('OK')，这里只对齐状态文件
          writeLoginStatus(userId, { phase: 'SUCCESS', message: r.message });
          log(`${by} 登录成功（会话类 cookie ${r.sessionCookies.length} 条）`);
        } else {
          const cur = readLoginStatus(userId);
          if (cur.phase !== 'CANCELLED') writeLoginStatus(userId, { phase: 'FAILED', message: r.message });
          log(`${by} 登录失败：${r.message}`);
        }
      })
      .catch((e) => {
        writeLoginStatus(userId, { phase: 'FAILED', message: `登录异常：${(e as Error).message}` });
        log(`${by} 登录异常：${(e as Error).message}`);
      })
      .finally(() => {
        loginBusy = false;
        // 浏览器已释放，清掉占用标记
        const owner = readLoginOwner();
        if (owner && owner.userId === userId) writeLoginOwner(null);
      });

    return; // 一次只起一个
  }
}

/**
 * 把「前面有人在扫」写进排队者的登录状态。
 *
 * 为什么要主动写：排队的人界面上只有一个「已提交请求」，
 * 不告诉他前面是谁，他无法判断到底是排队还是坏了。
 */
function syncQueueHints(userIds: string[]): void {
  const owner = readLoginOwner();
  for (const userId of userIds) {
    if (owner && owner.userId === userId) continue;
    const ctl = readControl(userId);
    const queued = Boolean(ctl.loginRequestedAt && ctl.loginRequestedAt !== handledLoginRequestAt.get(userId));
    const s = readLoginStatus(userId);

    if (queued && owner) {
      const already = s.queuedBehind === owner.displayName && s.phase === 'STARTING';
      if (!already) {
        writeLoginStatus(userId, {
          phase: 'STARTING',
          message: `前面 ${owner.displayName} 正在扫码登录，请在队列中稍候（同一时刻只能有一个人扫码）。`,
          queuedBehind: owner.displayName,
        });
      }
    } else if (!queued && s.queuedBehind) {
      // 请求已被处理（自己的码出来了），把排队残留清掉
      writeLoginStatus(userId, { queuedBehind: undefined });
    }
  }
}

/** 启动时把上一轮残留的「进行中」登录状态归一化，避免界面显示永远在等扫码 */
export function resetStaleLoginStatus(): void {
  const userIds = listMuseUserIds();

  for (const userId of userIds) {
    const s = readLoginStatus(userId);
    if (s.phase === 'STARTING' || s.phase === 'WAITING_SCAN') {
      writeLoginStatus(userId, { phase: 'IDLE', message: '上一次登录未完成（解析进程已重启）。' });
    } else if (s.phase === 'IDLE' && !s.updatedAt) {
      writeLoginStatus(userId, { ...IDLE_LOGIN });
    }

    /**
     * 关键：把**启动前就已经存在**的登录请求标记为「已处理」。
     *
     * 否则 control.json 里残留的 loginRequestedAt 会被新进程当成新请求执行 ——
     * 表现为「什么都没做，只是重启了 worker，它就自己开始扫码登录并暂停队列」。
     * 实测踩到：重启后立刻打印「开始扫码登录（发起人：部署维护人员）」。
     */
    const ctl = readControl(userId);
    if (ctl.loginRequestedAt) handledLoginRequestAt.set(userId, ctl.loginRequestedAt);
    if (ctl.loginCancelAt) loggedCancelAt.set(userId, ctl.loginCancelAt);
  }

  // 上一轮留下的「浏览器被谁占用」标记一律作废：进程都重启了，没人占着
  if (readLoginOwner()) writeLoginOwner(null);

  console.log(`[worker][muse] 会话根目录：${museSessionRoot()}`);
  console.log(`[worker][muse] 已有会话的用户：${userIds.length ? userIds.join(', ') : '（暂无）'}`);
  for (const userId of userIds) {
    const h = readHealth(userId);
    console.log(`[worker][muse]   ${userId} → ${h.status}（${h.source}，${h.checkedAt ?? '从未检测'}）`);
  }
}
