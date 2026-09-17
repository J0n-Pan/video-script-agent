import fs from 'node:fs';
import path from 'node:path';
import { prisma, ensureSqlitePragmas } from '../lib/db';
import { cfg, ensureDirs } from '../lib/config';
import { adapterSummary } from '../lib/ai';
import { claimNextAttempt, heartbeat, recoverInterruptedAttempts, retryDelay, cancelQueued } from '../lib/queue';
import { runPipeline } from './pipeline';
import { STAGE_LABEL } from '../lib/constants';

/** 明确的临时错误才做有限自动重试；确定性错误不循环重试（PRD 8 实现约定） */
const RETRYABLE_CODES = new Set(['DOWNLOAD_FAILED', 'CACHE_INCOMPLETE', 'VISION_FAILED', 'ORGANIZE_FAILED']);

let stopping = false;

async function processAttempt(attemptId: string) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt) return;

  await prisma.video.update({
    where: { id: attempt.videoId },
    data: { status: 'PROCESSING', currentStage: attempt.stage ?? 'FETCH' },
  });

  const hb = setInterval(() => {
    heartbeat(attemptId).catch(() => undefined);
  }, 10_000);

  try {
    const outcome = await runPipeline({
      videoId: attempt.videoId,
      attemptId,
      retryIndex: attempt.retryIndex,
    });

    // 重试判定
    if (
      outcome.status === 'FAILED' &&
      outcome.errorCode &&
      RETRYABLE_CODES.has(outcome.errorCode) &&
      attempt.retryIndex < cfg.maxAttemptRetry
    ) {
      await prisma.attempt.update({
        where: { id: attemptId },
        data: {
          status: 'FAILED',
          errorCode: outcome.errorCode,
          errorMessage: `${outcome.errorMessage ?? ''}（第 ${attempt.retryIndex + 1} 次尝试失败，将自动重试）`,
          finishedAt: new Date(),
        },
      });
      const delay = retryDelay(attempt.retryIndex);
      console.log(`[worker] 尝试 ${attemptId} 失败(${outcome.errorCode})，${delay}ms 后重试`);
      await sleep(delay);
      // 重试作为新的执行尝试排到队尾，保留尝试历史，不插队
      const { enqueueAttempt } = await import('../lib/queue');
      const next = await enqueueAttempt(attempt.videoId, 'RETRY');
      await prisma.attempt.update({ where: { id: next.id }, data: { retryIndex: attempt.retryIndex + 1 } });
      await prisma.video.update({
        where: { id: attempt.videoId },
        data: { status: 'QUEUED', currentStage: null },
      });
      return;
    }

    await prisma.attempt.update({
      where: { id: attemptId },
      data: {
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
        finishedAt: new Date(),
        stage: 'SAVE',
      },
    });

    if (outcome.status === 'FAILED') {
      // 失败不能阻塞后续任务；有其他可用版本时保持原当前版本有效
      const hasRevision = await prisma.scriptRevision.count({ where: { videoId: attempt.videoId } });
      await prisma.video.update({
        where: { id: attempt.videoId },
        data: {
          status: hasRevision > 0 ? 'PARTIAL' : 'FAILED',
          currentStage: null,
        },
      });
      console.log(`[worker] 尝试 ${attemptId} 失败：${outcome.errorCode} ${outcome.errorMessage}`);
    } else {
      console.log(`[worker] 尝试 ${attemptId} 完成：${outcome.status}`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    await prisma.attempt.update({
      where: { id: attemptId },
      data: { status: 'FAILED', errorCode: 'UNEXPECTED', errorMessage: msg, finishedAt: new Date() },
    });
    const hasRevision = await prisma.scriptRevision.count({ where: { videoId: attempt.videoId } });
    await prisma.video.update({
      where: { id: attempt.videoId },
      data: { status: hasRevision > 0 ? 'PARTIAL' : 'FAILED', currentStage: null },
    });
    console.error(`[worker] 尝试 ${attemptId} 异常：${msg}`);
  } finally {
    clearInterval(hb);
  }
}

/** 已取消的排队任务：跳过并同步任务状态 */
async function sweepCancelled() {
  const cancelled = await prisma.attempt.findMany({ where: { status: 'CANCELLED' }, include: { video: true } });
  for (const a of cancelled) {
    const others = await prisma.attempt.count({
      where: { videoId: a.videoId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (others === 0 && a.video.status === 'QUEUED') {
      await prisma.video.update({ where: { id: a.videoId }, data: { status: 'CANCELLED', currentStage: null } });
    }
  }
}

async function main() {
  ensureDirs();
  await ensureSqlitePragmas();
  claimWorkerLock();
  const recovered = await recoverInterruptedAttempts();
  console.log(`[worker] 启动，PID=${process.pid}，AI 模式=${cfg.aiMode}，适配器=${JSON.stringify(adapterSummary())}`);
  if (recovered > 0) console.log(`[worker] 恢复中断尝试 ${recovered} 条`);

  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });

  while (!stopping) {
    // 单实例锁：新进程启动后会改写锁文件，旧进程见此自觉退出，
    // 避免误开两个解析进程破坏「全局同时只解析一条视频」的约定（PRD 5）
    if (lockOwnerChanged()) {
      console.log(`[worker] 检测到新的解析进程已接管，本进程（PID=${process.pid}）退出`);
      break;
    }
    try {
      await sweepCancelled();
      const attempt = await claimNextAttempt();
      if (!attempt) {
        await sleep(1200);
        continue;
      }
      console.log(
        `[worker] 领取尝试 ${attempt.id}（seq=${attempt.queueSeq}，阶段=${STAGE_LABEL[attempt.stage ?? ''] ?? '待开始'}）`,
      );
      await processAttempt(attempt.id);
    } catch (e) {
      console.error(`[worker] 主循环异常：${(e as Error).message}`);
      await sleep(2000);
    }
  }
  releaseWorkerLock();
  console.log('[worker] 已停止');
  await prisma.$disconnect();
}

/**
 * 解析进程单实例锁（data/worker.lock，内容是本进程 PID）。
 *
 * 用途：重启解析进程时不必先猜出旧进程 PID 再结束它 ——
 * 新进程写入自己的 PID，旧进程下一轮循环就会发现锁不是自己的并自行退出。
 */
const LOCK_FILE = path.resolve(projectRootDataDir(), 'worker.lock');

function projectRootDataDir(): string {
  return path.join(process.cwd(), 'data');
}

function claimWorkerLock(): void {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
  } catch (e) {
    console.error(`[worker] 写入单实例锁失败（不影响解析）：${(e as Error).message}`);
  }
}

function lockOwnerChanged(): boolean {
  try {
    const owner = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    return owner !== '' && owner !== String(process.pid);
  } catch {
    // 锁文件被删除或不可读时不阻断解析（锁只是防重复，不承担正确性）
    return false;
  }
}

function releaseWorkerLock(): void {
  try {
    if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    /* 锁文件已不存在或已被接管，忽略 */
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('[worker] 致命错误', e);
  process.exit(1);
});

export { cancelQueued };
