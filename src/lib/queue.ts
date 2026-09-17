import { prisma } from './db';
import { cfg } from './config';

export type AttemptStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'FAILED'
  | 'UNSUPPORTED'
  | 'CANCELLED';

/**
 * 全局递增排队序号：服务端提交成功时分配（PRD 6.1）。
 * 同批次按提交清单顺序调用本函数即可保证清单内顺序。
 */
export async function nextQueueSeq(): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const c = await tx.counter.upsert({
      where: { name: 'queue' },
      create: { name: 'queue', value: 1 },
      update: { value: { increment: 1 } },
    });
    return c.value;
  });
}

/** 失败重试 / 补传 / 重新解析都作为新执行尝试排到队尾，不插队 */
export async function enqueueAttempt(videoId: string, kind: 'INITIAL' | 'RETRY' | 'REPARSE') {
  const seq = await nextQueueSeq();
  return prisma.attempt.create({
    data: { videoId, queueSeq: seq, kind, status: 'QUEUED', stage: null },
  });
}

/**
 * 原子领取下一条待执行尝试。
 * 全局同时最多一条视频执行解析：先确认没有 RUNNING，再领取最小 queueSeq。
 * 依据心跳判断中断，避免永久停留在处理中（PRD 6.3）。
 */
export async function claimNextAttempt() {
  const running = await prisma.attempt.findFirst({ where: { status: 'RUNNING' } });
  if (running) return null;

  const next = await prisma.attempt.findFirst({
    where: { status: 'QUEUED' },
    orderBy: { queueSeq: 'asc' },
  });
  if (!next) return null;

  const claimed = await prisma.attempt.updateMany({
    where: { id: next.id, status: 'QUEUED' },
    data: { status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date() },
  });
  if (claimed.count !== 1) return null;
  return prisma.attempt.findUnique({ where: { id: next.id } });
}

export async function heartbeat(attemptId: string) {
  await prisma.attempt.updateMany({
    where: { id: attemptId },
    data: { heartbeatAt: new Date() },
  });
}

export async function setStage(attemptId: string, stage: string) {
  await prisma.attempt.update({
    where: { id: attemptId },
    data: { stage, heartbeatAt: new Date() },
  });
}

/** 排队位置（仅展示本人任务的排队位置，不展示其他编导内容） */
export async function queuePosition(videoId: string, ownerId: string): Promise<number | null> {
  const attempt = await prisma.attempt.findFirst({
    where: { videoId, status: 'QUEUED', video: { ownerId } },
    orderBy: { queueSeq: 'asc' },
  });
  if (!attempt) return null;
  const ahead = await prisma.attempt.count({
    where: { status: 'QUEUED', queueSeq: { lt: attempt.queueSeq } },
  });
  return ahead + 1;
}

/**
 * 进程重启恢复：处于 RUNNING 但心跳过期的尝试标为「执行中断」。
 * 可恢复阶段继续处理，其余进入失败等待手动重试；不能永久停留在处理中。
 */
export async function recoverInterruptedAttempts() {
  const cutoff = new Date(Date.now() - Math.max(cfg.stageTimeoutMs / 4, 60_000));
  const stuck = await prisma.attempt.findMany({
    where: { status: 'RUNNING', OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: cutoff } }] },
  });
  for (const a of stuck) {
    const recoverable = a.stage === 'SAVE' || a.stage === 'ORGANIZE';
    await prisma.attempt.update({
      where: { id: a.id },
      data: {
        status: recoverable ? 'QUEUED' : 'FAILED',
        errorCode: 'INTERRUPTED',
        errorMessage: '执行中断（解析进程停止或超时），已按恢复规则处理',
        finishedAt: recoverable ? null : new Date(),
        stage: recoverable ? a.stage : a.stage,
      },
    });
    if (recoverable) {
      // 重新排到队尾，不插队
      const seq = await nextQueueSeq();
      await prisma.attempt.update({ where: { id: a.id }, data: { queueSeq: seq, status: 'QUEUED' } });
    }
  }
  return stuck.length;
}

/** 取消排队：不影响后续顺序 */
export async function cancelQueued(videoId: string) {
  const r = await prisma.attempt.updateMany({
    where: { videoId, status: 'QUEUED' },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  return r.count;
}

export function retryDelay(retryIndex: number) {
  return cfg.retryIntervalMs * Math.max(1, retryIndex + 1);
}
