import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { prisma } from '@/lib/db';
import { deleteVideo, updateVideoTitle } from '@/lib/services/script';
import { STAGE_LABEL, VIDEO_STATUS_LABEL, REVIEW_STATUS_LABEL, MISSING } from '@/lib/constants';
import { cfg } from '@/lib/config';
import { adapterSummary } from '@/lib/ai';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const video = await prisma.video.findFirst({
      where: { id: params.id, ownerId: user.id, deletedAt: null },
      include: {
        classification: true,
        media: true,
        attempts: { orderBy: { queueSeq: 'asc' }, include: { usages: true } },
        revisions: {
          orderBy: { versionNo: 'desc' },
          include: { segments: { orderBy: { orderIndex: 'asc' } } },
        },
      },
    });
    if (!video) throw new HttpError(404, '任务不存在或无权访问');

    const current = video.revisions.find((r) => r.isCurrent) ?? video.revisions[0] ?? null;
    const usage = video.attempts.flatMap((a) => a.usages);
    const estimatedCost = usage.reduce((s, u) => s + (u.estimatedCost ?? 0), 0);
    const usagePending = usage.filter((u) => u.usageMissing || u.estimatedCost === null).length;

    return ok({
      id: video.id,
      seq: video.seq,
      title: video.title,
      titleDisplay: video.title?.trim() || MISSING.NOT_PROVIDED,
      titleSource: video.titleSource,
      /** 原视频标题：本地导入 = 原文件名；链接导入 = 网页标题 */
      sourceTitle: video.sourceTitle,
      sourceTitleDisplay: video.sourceTitle?.trim() || MISSING.NOT_PROVIDED,
      sourceType: video.sourceType,
      sourceUrl: video.sourceUrl,
      fileName: video.fileName,
      originalPath: video.originalPath,
      durationMs: video.durationMs,
      status: video.status,
      statusLabel: VIDEO_STATUS_LABEL[video.status] ?? video.status,
      currentStage: video.currentStage,
      currentStageLabel: video.currentStage ? STAGE_LABEL[video.currentStage] ?? video.currentStage : null,
      problemFlags: JSON.parse(video.problemFlags || '[]'),
      createdAt: video.createdAt,
      classification: video.classification
        ? {
            category: video.classification.category,
            categoryLabel: video.classification.categoryLabel,
            aiRatio: video.classification.aiRatio,
            aiUnionMs: video.classification.aiUnionMs,
            ratioEstimated: video.classification.ratioEstimated,
            uncertain: video.classification.uncertain,
            manualOverride: video.classification.manualOverride,
            evidence: video.classification.evidence,
            modelVersion: video.classification.modelVersion,
            overriddenBy: video.classification.overriddenBy,
            overriddenAt: video.classification.overriddenAt,
          }
        : null,
      mediaAvailable: Boolean(video.media?.status === 'READY'),
      mediaHasAudio: video.media?.hasAudio ?? null,
      attempts: video.attempts.map((a) => ({
        id: a.id,
        queueSeq: a.queueSeq,
        kind: a.kind,
        status: a.status,
        stage: a.stage,
        stageLabel: a.stage ? STAGE_LABEL[a.stage] ?? a.stage : null,
        errorCode: a.errorCode,
        errorMessage: a.errorMessage,
        retryIndex: a.retryIndex,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
      })),
      revisions: video.revisions.map((r) => ({
        id: r.id,
        versionNo: r.versionNo,
        isCurrent: r.isCurrent,
        reviewStatus: r.reviewStatus,
        reviewStatusLabel: REVIEW_STATUS_LABEL[r.reviewStatus] ?? r.reviewStatus,
        savedAt: r.savedAt,
        createdBy: r.createdBy,
        problems: JSON.parse(r.problems || '[]'),
        segmentCount: r.segments.length,
      })),
      current: current
        ? {
            id: current.id,
            versionNo: current.versionNo,
            isCurrent: current.isCurrent,
            reviewStatus: current.reviewStatus,
            savedAt: current.savedAt,
            createdBy: current.createdBy,
            problems: JSON.parse(current.problems || '[]'),
            /** 「视频分析」栏的画面场景：整条视频一次的概览 */
            sceneOverview: current.sceneOverview,
            /** 「脚本文案」栏：转写原文整段（人工可改） */
            transcriptText: current.transcriptText,
            segments: current.segments.map((s) => ({
              id: s.id,
              orderIndex: s.orderIndex,
              startMs: s.startMs,
              endMs: s.endMs,
              copyText: s.copyText,
              tag: s.tag,
              makeup: s.makeup,
              makeupFull: s.makeupFull,
              emotion: s.emotion,
              timeUncertain: s.timeUncertain,
              problemFlags: JSON.parse(s.problemFlags || '[]'),
            })),
          }
        : null,
      // 原网页板块（人群分析 / 分镜或高光时序 title / 创意标签），对应「视频分析」栏
      insight: (() => {
        try {
          const p = JSON.parse(video.sourceInsight || '{}');
          return p && typeof p === 'object' && Object.keys(p).length ? p : null;
        } catch {
          return null;
        }
      })(),
      cost: {
        estimatedTotal: Number(estimatedCost.toFixed(4)),
        currency: 'CNY',
        priceVersion: cfg.pricing.priceVersion,
        usagePending,
        calls: usage.length,
      },
      adapters: adapterSummary(),
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const r = await deleteVideo(params.id, user.id);
    return ok(r);
  } catch (e) {
    return handleError(e);
  }
}

/** 工作台「任务信息」修改标题（人工修改优先，不被自动获取的标题覆盖） */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = await readJson<{ title?: string }>(req);
    const r = await updateVideoTitle(params.id, user.id, body.title);
    return ok(r);
  } catch (e) {
    return handleError(e);
  }
}
