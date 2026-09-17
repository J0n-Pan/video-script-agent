import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { HttpError } from '../auth';
import { enqueueAttempt } from '../queue';
import { MISSING, FORM, FORM_LABEL, MIXED_CUT_MESSAGE, REVIEW_STATUS, normalizeTag } from '../constants';
import { validateSegments } from '../validate';
import { removeVideoMedia, safeExt, baseFileName, fileSize } from '../storage';
import { stagedPath } from './submit';

export type SegmentInput = {
  id?: string;
  startMs: number;
  endMs: number;
  copyText: string;
  /** 唯一标签：人设/痛点/干货（解决方案）/营销内容（产品介绍）/福利/其他 */
  tag: string;
  makeup: string;
  emotion: string;
};

/**
 * 显式保存（PRD 3.5 / 10.2）：
 * 客户端提交读取时的版本，服务端发现版本已变化则返回冲突，不静默覆盖。
 * 保存后更新版本号和保存时间；修改已复核内容后回到未复核。
 */
export async function saveRevision(params: {
  videoId: string;
  ownerId: string;
  baseRevisionId: string;
  segments: SegmentInput[];
  isMixedCutNotice?: boolean;
  /** 「视频分析」栏的画面场景：整条视频一次的概览（人工可改） */
  sceneOverview?: string;
  /** 「脚本文案」栏：转写原文整段（人工可改；不传时沿用当前版本） */
  transcriptText?: string;
}) {
  const video = await prisma.video.findFirst({
    where: { id: params.videoId, ownerId: params.ownerId, deletedAt: null },
    include: { revisions: { where: { isCurrent: true } }, classification: true },
  });
  if (!video) throw new HttpError(404, '任务不存在或无权访问');
  const current = video.revisions[0];
  if (!current) throw new HttpError(409, '当前没有可编辑的保存版本，请先解析或重新解析');
  if (params.baseRevisionId && current.id !== params.baseRevisionId) {
    throw new HttpError(409, '版本冲突：其他页面已保存了更新的修改，请重新加载后再保存（不覆盖较新版本）');
  }

  const duration = video.durationMs ?? 0;
  const normalized = params.segments.map((s) => ({
    startMs: Math.round(s.startMs),
    endMs: Math.round(s.endMs),
    copyText: s.copyText ?? '',
    // 人工编辑同样受标签约束：越界或缺失一律归「其他」，并在校验中留痕
    tag: normalizeTag(s.tag),
    voiceover: '',
    makeup: s.makeup ?? '',
    emotion: s.emotion ?? '',
    sourceUtteranceIds: [] as string[],
  }));
  const problems = validateSegments(normalized, duration).map((p) => ({
    code: p.code,
    message: p.message,
    segmentIndex: p.segmentIndex,
    severity: p.severity,
  }));

  const versionNo = current.versionNo + 1;
  const saved = await prisma.$transaction(async (tx) => {
    await tx.scriptRevision.updateMany({ where: { videoId: params.videoId, isCurrent: true }, data: { isCurrent: false } });
    const rev = await tx.scriptRevision.create({
      data: {
        videoId: params.videoId,
        attemptId: current.attemptId,
        versionNo,
        isCurrent: true,
        // 修改后回到未复核
        reviewStatus: REVIEW_STATUS.NOT_REVIEWED,
        reviewProblemAck: '[]',
        problems: JSON.stringify(problems),
        // 画面场景为整条视频一次的概览；不传时沿用当前版本的值
        sceneOverview: params.sceneOverview ?? current.sceneOverview ?? '',
        // 脚本文案：整段转写原文；不传时沿用当前版本的值
        transcriptText: params.transcriptText ?? current.transcriptText ?? '',
        createdBy: 'HUMAN',
      },
    });
    for (let i = 0; i < normalized.length; i += 1) {
      const s = normalized[i];
      const prev = params.segments[i].id
        ? await tx.segment.findUnique({ where: { id: params.segments[i].id! } })
        : null;
      await tx.segment.create({
        data: {
          revisionId: rev.id,
          orderIndex: i + 1,
          startMs: s.startMs,
          endMs: s.endMs,
          copyText: s.copyText,
          tag: s.tag,
          voiceover: '',
          makeup: s.makeup,
          makeupFull: s.makeup === MISSING.SAME_AS_ABOVE ? prev?.makeupFull ?? '' : s.makeup,
          emotion: s.emotion,
          timeUncertain: s.endMs <= s.startMs,
        },
      });
    }
    return rev;
  });

  await prisma.video.update({
    where: { id: params.videoId },
    data: { problemFlags: JSON.stringify(problems.map((p) => ({ code: p.code, count: 1 }))) },
  });

  return { revisionId: saved.id, versionNo: saved.versionNo, problems };
}

/** 标记复核：只确认已保存版本；仍存在问题标记时明确列出并由编导确认 */
export async function markReviewed(params: {
  videoId: string;
  ownerId: string;
  revisionId: string;
  acknowledgeProblems: boolean;
}) {
  const rev = await prisma.scriptRevision.findFirst({
    where: { id: params.revisionId, videoId: params.videoId, video: { ownerId: params.ownerId, deletedAt: null } },
  });
  if (!rev) throw new HttpError(404, '版本不存在或无权访问');
  if (!rev.isCurrent) throw new HttpError(409, '只能标记当前保存版本为已复核');
  const problems = JSON.parse(rev.problems || '[]') as Array<{ code: string; message: string; severity: string }>;
  const mustAck = problems.filter((p) => p.severity !== 'info');
  if (mustAck.length > 0 && !params.acknowledgeProblems) {
    // 识别过程的「有缺失」与人工复核状态分别保存，点击复核不能被用来消除问题记录
    throw new HttpError(409, `当前版本仍有 ${mustAck.length} 个问题标记，需明确确认后再标记已复核`);
  }
  await prisma.scriptRevision.update({
    where: { id: rev.id },
    data: {
      reviewStatus: REVIEW_STATUS.REVIEWED,
      reviewedAt: new Date(),
      reviewProblemAck: JSON.stringify(mustAck.map((p) => p.code)),
    },
  });
  return { ok: true, problemsCount: mustAck.length };
}

/** 纠正形式：人工覆盖优先作用于整条视频；仅修改标签不自动启动解析 */
export async function overrideClassification(params: {
  videoId: string;
  ownerId: string;
  operator: string;
  category: string;
}) {
  const video = await prisma.video.findFirst({ where: { id: params.videoId, ownerId: params.ownerId, deletedAt: null } });
  if (!video) throw new HttpError(404, '任务不存在或无权访问');
  if (!Object.values(FORM).includes(params.category as (typeof FORM)[keyof typeof FORM])) {
    throw new HttpError(400, '不支持的形式取值');
  }
  await prisma.classification.upsert({
    where: { videoId: params.videoId },
    create: {
      videoId: params.videoId,
      category: params.category,
      categoryLabel: FORM_LABEL[params.category] ?? params.category,
      manualOverride: true,
      overriddenBy: params.operator,
      overriddenAt: new Date(),
      evidence: '人工纠正',
    },
    update: {
      category: params.category,
      categoryLabel: FORM_LABEL[params.category] ?? params.category,
      manualOverride: true,
      overriddenBy: params.operator,
      overriddenAt: new Date(),
      uncertain: false,
      evidence: '人工纠正（覆盖自动判断，保留原判断供追溯）',
    },
  });
  // 若被纠正为非混剪，当前混剪提示版本不再代表最新判断，但旧版本保留
  if (params.category !== FORM.MIXED_CUT && video.status === 'UNSUPPORTED') {
    await prisma.video.update({ where: { id: params.videoId }, data: { status: 'COMPLETED' } });
  }
  return { ok: true };
}

/** 重新解析：产生独立结果，不覆盖旧人工版本；新尝试排到队尾 */
export async function reparse(videoId: string, ownerId: string) {
  const video = await prisma.video.findFirst({ where: { id: videoId, ownerId, deletedAt: null } });
  if (!video) throw new HttpError(404, '任务不存在或无权访问');
  await prisma.attempt.updateMany({
    where: { videoId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  const attempt = await enqueueAttempt(videoId, 'REPARSE');
  await prisma.video.update({ where: { id: videoId }, data: { status: 'QUEUED', currentStage: null, problemFlags: '[]' } });
  return { attemptId: attempt.id };
}

/** 失败重试：保留原链接和已有结果，不复用失效执行状态 */
export async function retry(videoId: string, ownerId: string) {
  const video = await prisma.video.findFirst({ where: { id: videoId, ownerId, deletedAt: null } });
  if (!video) throw new HttpError(404, '任务不存在或无权访问');
  const attempt = await enqueueAttempt(videoId, 'RETRY');
  await prisma.video.update({ where: { id: videoId }, data: { status: 'QUEUED', currentStage: null } });
  return { attemptId: attempt.id };
}

/** 本地补传：关联原视频记录，保留已填标题和来源信息 */
export async function supplement(videoId: string, ownerId: string, stageId: string, fileName: string) {
  const video = await prisma.video.findFirst({ where: { id: videoId, ownerId, deletedAt: null } });
  if (!video) throw new HttpError(404, '任务不存在或无权访问');
  const staged = stagedPath(stageId);
  if (!fs.existsSync(staged)) throw new HttpError(400, '暂存文件不存在，请重新上传');
  const ext = safeExt(fileName);
  if (ext && !['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.flv', '.wmv'].includes(ext)) {
    throw new HttpError(400, `补传文件格式 ${ext} 暂不支持`);
  }
  await prisma.mediaAsset.deleteMany({ where: { videoId } });
  await prisma.mediaAsset.create({
    data: {
      videoId,
      cachePath: staged,
      fileName: baseFileName(fileName),
      sizeBytes: fileSize(staged),
      status: 'PENDING',
    },
  });
  await prisma.video.update({
    where: { id: videoId },
    data: { status: 'QUEUED', currentStage: null, fileName: video.fileName ?? baseFileName(fileName) },
  });
  const attempt = await enqueueAttempt(videoId, 'RETRY');
  return { attemptId: attempt.id };
}

/**
 * 修改任务标题（工作台「任务信息」）：
 * 人工改过即标记来源为 MANUAL，后续解析/重新解析不会用自动获取的标题把它覆盖掉。
 * 清空标题表示回到「未提供」（NONE）。
 * 「原视频标题」（sourceTitle）不随此操作变化，它保留本地文件名 / 网页标题的原样。
 */
export async function updateVideoTitle(videoId: string, ownerId: string, title: unknown) {
  const video = await prisma.video.findFirst({ where: { id: videoId, ownerId, deletedAt: null } });
  if (!video) throw new HttpError(404, '任务不存在或无权访问');
  if (typeof title !== 'string') throw new HttpError(400, '标题必须是文本');
  const next = title.replace(/\s+/g, ' ').trim();
  if (next.length > 200) throw new HttpError(400, '标题最多 200 字');

  await prisma.video.update({
    where: { id: videoId },
    data: next ? { title: next, titleSource: 'MANUAL' } : { title: null, titleSource: 'NONE' },
  });
  return { title: next || null, titleSource: next ? 'MANUAL' : 'NONE' };
}

/** 删除本人视频记录：清理版本、媒体；包含该视频的合并导出文件同步失效并清理 */
export async function deleteVideo(videoId: string, ownerId: string) {
  const video = await prisma.video.findFirst({ where: { id: videoId, ownerId, deletedAt: null } });
  if (!video) throw new HttpError(404, '任务不存在或无权访问');

  await prisma.attempt.updateMany({
    where: { videoId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });

  // 包含该视频的合并导出文件失效并清理
  const affected = await prisma.exportRecord.findMany({ where: { ownerId, items: { some: { videoId } } } });
  for (const ex of affected) {
    if (ex.filePath && fs.existsSync(ex.filePath)) {
      try {
        fs.rmSync(ex.filePath, { force: true });
      } catch {
        // 忽略
      }
    }
  }
  await prisma.exportRecord.deleteMany({ where: { id: { in: affected.map((a) => a.id) } } });

  removeVideoMedia(videoId);
  await prisma.video.delete({ where: { id: videoId } });
  return { ok: true, invalidatedExports: affected.length };
}

/** 取消排队：等待任务已取消；再次提交产生新尝试 */
export async function cancelQueuedVideo(videoId: string, ownerId: string) {
  const video = await prisma.video.findFirst({ where: { id: videoId, ownerId, deletedAt: null } });
  if (!video) throw new HttpError(404, '任务不存在或无权访问');
  const r = await prisma.attempt.updateMany({
    where: { videoId, status: 'QUEUED' },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  if (r.count > 0) {
    await prisma.video.update({ where: { id: videoId }, data: { status: 'CANCELLED', currentStage: null } });
  }
  return { cancelled: r.count };
}

export function mixedCutReason() {
  return MIXED_CUT_MESSAGE;
}
