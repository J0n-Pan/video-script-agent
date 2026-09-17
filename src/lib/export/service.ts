import { prisma } from '../db';
import { cfg, ensureDirs } from '../config';
import { EXPORT_KIND, FORM, NON_EXPORTABLE_STATUSES, REVIEW_STATUS_LABEL, VIDEO_STATUS_LABEL, type ExportKind } from '../constants';
import { buildWorkbook, type ExportVideoPayload } from './xlsx';
import { buildScriptWorkbook } from './script-sheet';
import type { MuseInsight } from '../sources/muse-insight';

export type ExportRequestItem = { videoId: string; revisionId?: string | null };

/** 归一化前端传来的导出类型：非法值一律按「信息流素材库」处理，不静默换类型 */
export function normalizeExportKind(raw: unknown): ExportKind {
  return raw === EXPORT_KIND.SCRIPT ? EXPORT_KIND.SCRIPT : EXPORT_KIND.LIBRARY;
}

export type ExportValidation = {
  exportable: ExportRequestItem[];
  blocked: Array<{ videoId: string; title: string; reason: string }>;
};

/**
 * 导出边界（PRD 7.4）：
 * 可导出已完成、部分完成及混剪提示记录；排队中、处理中、失败且无可用结果、已取消的记录不能作为完整脚本导出，
 * 必须逐项说明并要求用户明确移除，禁止静默少导出。
 */
export async function validateExport(ownerId: string, items: ExportRequestItem[]): Promise<ExportValidation> {
  const exportable: ExportRequestItem[] = [];
  const blocked: ExportValidation['blocked'] = [];

  for (const item of items) {
    const video = await prisma.video.findFirst({
      where: { id: item.videoId, ownerId, deletedAt: null },
      include: { revisions: { where: { isCurrent: true } } },
    });
    if (!video) {
      blocked.push({ videoId: item.videoId, title: '', reason: '任务不存在或无权访问' });
      continue;
    }
    if (NON_EXPORTABLE_STATUSES.includes(video.status)) {
      blocked.push({
        videoId: video.id,
        title: video.title ?? '未提供',
        reason: `当前状态为「${VIDEO_STATUS_LABEL[video.status] ?? video.status}」，尚无可用结果，不能导出为完整脚本`,
      });
      continue;
    }
    const current = video.revisions[0];
    if (!current) {
      blocked.push({
        videoId: video.id,
        title: video.title ?? '未提供',
        reason: '失败且无可用结果（没有任何已保存的脚本版本）',
      });
      continue;
    }
    if (item.revisionId) {
      const chosen = await prisma.scriptRevision.findFirst({
        where: { id: item.revisionId, videoId: video.id },
      });
      if (!chosen) {
        blocked.push({ videoId: video.id, title: video.title ?? '未提供', reason: '所选保存版本不存在' });
        continue;
      }
    }
    exportable.push({ videoId: video.id, revisionId: item.revisionId ?? current.id });
  }

  return { exportable, blocked };
}

/** 以版本快照生成导出文件；未保存编辑不得混入（调用方须先完成显式保存） */
export async function createExport(ownerId: string, items: ExportRequestItem[], kind: ExportKind = EXPORT_KIND.LIBRARY) {
  ensureDirs();
  const { exportable, blocked } = await validateExport(ownerId, items);
  if (blocked.length > 0) {
    return { ok: false as const, blocked };
  }
  if (exportable.length === 0) {
    return { ok: false as const, blocked: [{ videoId: '', title: '', reason: '没有可导出的视频' }] };
  }

  const payloads: ExportVideoPayload[] = [];
  for (const item of exportable) {
    const revision = await prisma.scriptRevision.findUnique({
      where: { id: item.revisionId! },
      include: {
        segments: { orderBy: { orderIndex: 'asc' } },
        video: { include: { classification: true } },
      },
    });
    if (!revision) continue;
    const v = revision.video;
    // 原网页板块快照：解析失败按空值处理，不影响导出
    let insight: MuseInsight | null = null;
    try {
      const parsed = JSON.parse(v.sourceInsight || '{}');
      insight = parsed && typeof parsed === 'object' && Object.keys(parsed).length ? (parsed as MuseInsight) : null;
    } catch {
      insight = null;
    }
    payloads.push({
      videoId: v.id,
      title: v.title,
      // 原视频标题：本地导入 = 原文件名；链接导入 = 网页标题（老数据可能为空，导出按「未提供」）
      sourceTitle: v.sourceTitle,
      durationMs: v.durationMs,
      fileName: v.fileName,
      originalPath: v.originalPath,
      sourceUrl: v.sourceUrl,
      seq: v.seq,
      reviewStatus: revision.reviewStatus,
      reviewStatusLabel: REVIEW_STATUS_LABEL[revision.reviewStatus] ?? revision.reviewStatus,
      versionNo: revision.versionNo,
      savedAt: revision.savedAt,
      formLabel: v.classification?.categoryLabel ?? '未识别',
      isMixedCut: v.classification?.category === FORM.MIXED_CUT,
      insight,
      // 「视频分析」栏的画面场景：整条视频一次的概览，混剪时留空
      sceneOverview: revision.sceneOverview ?? '',
      // 「脚本文案」栏：转写原文整段（可能经人工修订），原样导出
      transcriptText: revision.transcriptText ?? '',
      segments: revision.segments.map((s) => ({
        orderIndex: s.orderIndex,
        startMs: s.startMs,
        endMs: s.endMs,
        copyText: s.copyText,
        tag: s.tag,
        makeup: s.makeupFull || s.makeup,
        emotion: s.emotion,
      })),
    });
  }

  const { filePath, fileName } =
    kind === EXPORT_KIND.SCRIPT
      ? await buildScriptWorkbook(payloads, cfg.exportDir)
      : await buildWorkbook(payloads, cfg.exportDir);
  const record = await prisma.exportRecord.create({
    data: {
      ownerId,
      status: 'READY',
      filePath,
      fileName,
      itemCount: payloads.length,
      items: {
        create: exportable.map((item, i) => ({
          videoId: item.videoId,
          revisionId: item.revisionId!,
          orderIndex: i + 1,
        })),
      },
    },
  });
  return { ok: true as const, exportId: record.id, fileName, filePath, itemCount: payloads.length, kind };
}
