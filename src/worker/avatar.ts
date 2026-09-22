// 数字人任务处理服务（2026-09-20 需求迭代 §9）。
//
// 为什么是**独立进程**而不是并进视频分析 worker：
// 数字人等待动辄十几分钟，而视频分析队列是全局串行的；放进同一个循环会让
// 「等一个数字人」直接卡住整条视频分析流水线（A21 明确要求不能阻塞）。
//
// 启动：2026-09-22 起**随工作台一起启动**（npm run dev / start-workbench.bat 的
//   concurrently 第三进程），编导只开网页也能正常提交数字人任务。
//   仍可单独运行：npm run worker:avatar（改配置重启数字人链路时用）。
// 单实例锁：data/avatar-worker.lock，自愈式（新进程覆写 PID，不需要手动删）

import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/db';
import { cfg, ensureDirs } from '../lib/config';
import { advanceAvatarJob } from '../lib/avatar/service';
import {
  checkAvatarSessionFile,
  clearAvatarCredentials,
  readAvatarControl,
  readAvatarHealth,
  resetStaleAvatarLoginStatus,
  writeAvatarControl,
  writeAvatarHealth,
  writeAvatarLoginStatus,
} from '../lib/avatar/session-state';
import { probeAvatarSession, runAvatarLogin } from '../lib/avatar/platform-login';

const LOCK = path.resolve(process.cwd(), 'data', 'avatar-worker.lock');
const IDLE_SLEEP_MS = 4000;

let stopping = false;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 单实例锁：直接覆写 PID。旧进程若已退出，锁自然失效，不需要人工介入 */
function takeLock() {
  ensureDirs();
  try {
    if (fs.existsSync(LOCK)) {
      const old = Number(fs.readFileSync(LOCK, 'utf8').trim());
      if (old && old !== process.pid) {
        try {
          // 进程存在则说明确有两个实例在跑；这时**让新进程退出**，避免两个浏览器同时提交
          process.kill(old, 0);
          console.error(`[avatar-worker] 已有实例在运行（PID ${old}），本次退出`);
          process.exit(0);
        } catch {
          /* 旧进程不存在，继续接管 */
        }
      }
    }
  } catch {
    /* 锁文件读取失败按无锁处理 */
  }
  fs.writeFileSync(LOCK, String(process.pid), 'utf8');
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK) && Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK);
    }
  } catch {
    /* 忽略 */
  }
}

/* ─────────────────────────────────────────────────────────────
 * 连接状态服务（2026-09-22 需求迭代）：探测 + 账号密码自动登录。
 *
 * web 通过 control.json 投递请求（与妙思同构的文件协议）：
 *   - 探测：网页打开工作台时结论过期 → 投 probeRequestedAt → 这里执行并写 health.json
 *   - 登录：编导在弹窗输入鲲之益账号密码 → web 写 control（含凭据）→ 这里执行
 *     账密自动登录 → 成败都把凭据清掉 → 进度写 login-status.json 供弹窗轮询
 *
 * 登录在主循环里**内联执行**（约 10~50 秒）：单实例进程没有并发问题；
 * 期间数字人任务推进短暂暂停，可接受 —— 没连接平台时任务本来也推不动。
 * ───────────────────────────────────────────────────────────── */

/** 处理一个探测请求（有请求且未确认时才动） */
async function serviceAvatarProbe(): Promise<void> {
  const ctl = readAvatarControl();
  if (!ctl.probeRequestedAt || ctl.probeRequestedAt === ctl.ackedProbeAt) return;
  writeAvatarControl({ ackedProbeAt: ctl.probeRequestedAt });
  try {
    await probeAvatarSession();
    const h = readAvatarHealth();
    console.log(`[avatar-worker] 连接探测完成：${h.status}（${h.costMs ?? '-'}ms）`);
  } catch (e) {
    console.error('[avatar-worker] 连接探测异常：', e instanceof Error ? e.message : e);
  }
}

/** 处理一个登录请求（编导在网页输入鲲之益账号密码后触发） */
async function serviceAvatarLogin(): Promise<void> {
  const ctl = readAvatarControl();
  if (!ctl.loginRequestedAt) return;

  const requestedAt = ctl.loginRequestedAt;
  const cancelAt = ctl.loginCancelAt ?? null;

  // 请求在取件前就被取消（取消时间晚于请求时间）→ 直接记已取消，绝不去登录。
  // 与妙思 worker 同一个竞态：不拦的话一次没人用的登录会白占进程几十秒。
  if (cancelAt && cancelAt >= requestedAt) {
    writeAvatarControl({ loginRequestedAt: undefined, loginUsername: undefined, loginPassword: undefined });
    writeAvatarLoginStatus({ phase: 'CANCELLED', message: '登录请求已取消。', startedBy: undefined });
    console.log('[avatar-worker] 登录请求在执行前已被取消，跳过');
    return;
  }

  const by = ctl.loginRequestedBy ?? '未知';
  const username = ctl.loginUsername ?? '';
  const password = ctl.loginPassword ?? '';

  // 先清凭据再干活：密码只允许在 control.json 里存在「从写入到取件」这一小段
  clearAvatarCredentials();

  if (!username || !password) {
    writeAvatarLoginStatus({ phase: 'FAILED', message: '登录请求里缺少账号或密码，请重新在弹窗里填写。' });
    // 必须把请求标记一起清掉：否则这条残缺请求会被主循环每轮重新捞起，无限刷失败
    writeAvatarControl({ loginRequestedAt: undefined, loginRequestedBy: undefined, loginCancelAt: undefined });
    console.error('[avatar-worker] 登录请求缺少凭据，已忽略');
    return;
  }

  writeAvatarLoginStatus({ phase: 'STARTING', message: '正在打开鲲之益登录页…', startedAt: new Date().toISOString(), startedBy: by });
  console.log(`[avatar-worker] 开始鲲之益账号密码登录（发起人：${by}，不记录也不打印凭据）`);

  writeAvatarLoginStatus({ phase: 'LOGGING_IN', message: '正在登录鲲之益平台，通常需要 10~30 秒…' });
  let outcome;
  try {
    outcome = await runAvatarLogin({
      username,
      password,
      shouldCancel: () => {
        // 只认晚于本次请求的取消标记（与妙思 worker 同判据，残留取消不算）
        const c = readAvatarControl();
        if (!c.loginCancelAt) return false;
        if (cancelAt && c.loginCancelAt === cancelAt && cancelAt < requestedAt) return false;
        return true;
      },
    });
  } catch (e) {
    outcome = { outcome: 'FAILED' as const, message: `登录过程出现异常：${e instanceof Error ? e.message : String(e)}` };
  }

  if (outcome.outcome === 'OK' || outcome.outcome === 'ALREADY') {
    const fileState = checkAvatarSessionFile();
    writeAvatarLoginStatus({ phase: 'SUCCESS', message: outcome.message });
    writeAvatarHealth({
      status: 'VALID',
      checkedAt: new Date().toISOString(),
      source: 'PROBE',
      message: '鲲之益平台连接正常，可以直接生成数字人视频。',
      sessionMtime: fileState.sessionMtime,
      cookieCount: fileState.cookieCount,
    });
    console.log(`[avatar-worker] 鲲之益登录完成：${outcome.outcome}`);
  } else {
    writeAvatarLoginStatus({ phase: 'FAILED', message: outcome.message });
    writeAvatarHealth({
      status: 'EXPIRED',
      checkedAt: new Date().toISOString(),
      source: 'PROBE',
      message: outcome.message,
    });
    console.error(`[avatar-worker] 鲲之益登录失败：${outcome.message}`);
  }
  // 请求处理完毕：清掉请求标记，避免进程重启后被重新执行
  writeAvatarControl({ loginRequestedAt: undefined, loginRequestedBy: undefined, loginCancelAt: undefined });
}

/**
 * 取出一个可推进的任务。
 * 优先级：QUEUED（新任务）→ SUBMITTING（上次进程中断，状态未知，重查而非重提）→ VENDOR_RUNNING（轮询）。
 * NEEDS_LOGIN 也纳入重试，但加冷却时间：否则登录没恢复时会每几秒拉一次浏览器，白耗资源。
 */
async function pickJob() {
  const cooldown = new Date(Date.now() - 60_000);

  const order = [
    { status: 'QUEUED' },
    { status: 'SUBMITTING' },
    { status: 'VENDOR_RUNNING' },
    { status: 'NEEDS_LOGIN', updatedAt: { lt: cooldown } },
  ];

  for (const where of order) {
    const job = await prisma.avatarVideoJob.findFirst({
      where: where as any,
      orderBy: { updatedAt: 'asc' },
    });
    if (job) return job;
  }
  return null;
}

async function main() {
  takeLock();
  console.log(
    `[avatar-worker] 启动：适配器=${cfg.avatar.adapter}，提交方式=${cfg.avatar.submitMode}，` +
      `形象=${cfg.avatar.avatarName}，音色=${cfg.avatar.voiceName}`,
  );
  // 上次进程中断可能把登录状态卡在「进行中」：先归位，别让弹窗永远转圈
  resetStaleAvatarLoginStatus();
  // 进程重启期间留下的登录请求一律作废（与妙思 worker 同理由：重启≠有人还在等）
  const bootCtl = readAvatarControl();
  if (bootCtl.loginRequestedAt) {
    writeAvatarControl({ loginRequestedAt: undefined, loginRequestedBy: undefined, loginUsername: undefined, loginPassword: undefined });
    console.log('[avatar-worker] 作废重启前遗留的登录请求');
  }
  /**
   * 提交方式必须显式打出来：它决定了这个进程是「自己替人选参数并点提交」还是
   * 「弹出窗口等人来操作」。启动日志里不写，运维看日志根本判断不出它会不会花钱、会不会弹窗。
   */
  if (cfg.avatar.adapter === 'playwright' && cfg.avatar.submitMode === 'assist') {
    console.log(
      `[avatar-worker] 人工接手：会打开**可见**的浏览器窗口并预填作品名与文案，` +
        `等人自己点「生成视频」；无人操作 ${Math.round(cfg.avatar.assistTimeoutMs / 60000)} 分钟后按「已取消」收尾（零额度）。`,
    );
  }
  if (cfg.avatar.adapter === 'playwright' && !fs.existsSync(cfg.avatar.storageState)) {
    console.warn('[avatar-worker] 尚未连接鲲之益平台：编导登录工作台后会自动弹出连接窗口（输入账号密码即可），也可 npm run avatar:login');
  }

  while (!stopping) {
    // 先服务连接状态请求（探测/登录），再推进数字人任务：
    // 探测秒级、登录几十秒，都远短于一次任务推进；没连接时任务也推不动。
    try {
      await serviceAvatarProbe();
      await serviceAvatarLogin();
    } catch (e) {
      console.error('[avatar-worker] 连接服务异常：', e instanceof Error ? e.message : e);
    }

    let job: Awaited<ReturnType<typeof pickJob>> = null;
    try {
      job = await pickJob();
    } catch (e) {
      console.error('[avatar-worker] 取任务失败：', e instanceof Error ? e.message : e);
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    if (!job) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    try {
      const status = await advanceAvatarJob(job.id);
      console.log(`[avatar-worker] 任务 ${job.id} → ${status}`);
      // 平台生成中/待登录：按轮询间隔再看；其余状态立即处理下一个
      if (status === 'VENDOR_RUNNING' || status === 'NEEDS_LOGIN') await sleep(cfg.avatar.pollIntervalMs);
      else await sleep(800);
    } catch (e) {
      console.error(`[avatar-worker] 任务 ${job.id} 处理异常：`, e instanceof Error ? e.message : e);
      await sleep(IDLE_SLEEP_MS);
    }
  }

  releaseLock();
  await prisma.$disconnect();
  console.log('[avatar-worker] 已停止');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

main().catch((e) => {
  console.error('[avatar-worker] 启动失败：', e);
  releaseLock();
  process.exitCode = 1;
});
