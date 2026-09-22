import { prisma } from '../db';
import { cfg, ensureDirs } from '../config';
import { EXPORT_KIND, FORM, NON_EXPORTABLE_STATUSES, REVIEW_STATUS_LABEL, VIDEO_STATUS_LABEL, type ExportKind } from '../constants';
import { buildWorkbook, type ExportVideoPayload } from './xlsx';
import { buildScriptWorkbook } from './script-sheet';
import { buildRewriteWorkbook, type ExportRewritePayload } from './rewrite-sheet';
import { REWRITE_PLATFORM_LABEL } from '../rewrite/rules';
import type { MuseInsight } from '../sources/muse-insight';

/**
 * 导出条目：
 * - SCRIPT / LIBRARY 用 videoId + revisionId（脚本版本）；
 * - REWRITE 用 rewriteRevisionId（改写稿修订），此时没有 videoId。
 */
export type ExportRequestItem = {
  videoId?: string | null;
  revisionId?: string | null;
  rewriteRevisionId?: string | null;
};

/** 归一化前端传来的导出类型：非法值一律按「信息流素材库」处理，不静默换类型 */
export function normalizeExportKind(raw: unknown): ExportKind {
  if (raw === EXPORT_KIND.SCRIPT) return EXPORT_KIND.SCRIPT;
  if (raw === EXPORT_KIND.REWRITE) return EXPORT_KIND.REWRITE;
  return EXPORT_KIND.LIBRARY;
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
export async function validateExport(
  ownerId: string,
  items: ExportRequestItem[],
  kind: ExportKind = EXPORT_KIND.LIBRARY,
): Promise<ExportValidation> {
  // 改写稿是另一套对象（没有视频脚本版本），校验口径不同
  if (kind === EXPORT_KIND.REWRITE) return validateRewriteExport(ownerId, items);

  const exportable: ExportRequestItem[] = [];
  const blocked: ExportValidation['blocked'] = [];

  for (const item of items) {
    if (!item.videoId) {
      blocked.push({ videoId: '', title: '', reason: '条目缺少视频 ID' });
      continue;
    }
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
  if (kind === EXPORT_KIND.REWRITE) return createRewriteExport(ownerId, items);

  const { exportable, blocked } = await validateExport(ownerId, items, kind);
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
      kind,
      status: 'READY',
      filePath,
      fileName,
      itemCount: payloads.length,
      items: {
        create: exportable.map((item, i) => ({
          videoId: item.videoId!,
          revisionId: item.revisionId!,
          orderIndex: i + 1,
        })),
      },
    },
  });
  return { ok: true as const, exportId: record.id, fileName, filePath, itemCount: payloads.length, kind };
}

// ============================================================================
// 「信息流文案改写稿」导出（2026-09-20 §9）
// 独立类型，与 SCRIPT / LIBRARY 完全分开：不改动原有两种导出的任何行为。
// ============================================================================

/**
 * 改写稿导出校验：只认**已保存的修订**。
 * 归属链必须走通 variant.job.ownerId —— 只验「修订 ID 存在」等于把别人的稿件也放行（A19）。
 */
export async function validateRewriteExport(ownerId: string, items: ExportRequestItem[]): Promise<ExportValidation> {
  const exportable: ExportRequestItem[] = [];
  const blocked: ExportValidation['blocked'] = [];

  for (const item of items) {
    if (!item.rewriteRevisionId) {
      blocked.push({ videoId: '', title: '', reason: '条目缺少改写稿修订 ID' });
      continue;
    }
    const rev = await prisma.rewriteRevision.findFirst({
      where: { id: item.rewriteRevisionId, variant: { job: { ownerId } } },
      include: { variant: { include: { job: { select: { id: true } } } }, segments: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!rev) {
      blocked.push({ videoId: '', title: '', reason: '改写稿不存在或无权访问' });
      continue;
    }
    if (rev.segments.length === 0) {
      blocked.push({ videoId: '', title: '', reason: '该改写稿没有正文（未生成成功或已清空），不能导出' });
      continue;
    }
    exportable.push({ rewriteRevisionId: rev.id });
  }

  return { exportable, blocked };
}

function parseJsonObject(raw: string | null | undefined): Record<string, any> {
  try {
    const o = JSON.parse(raw || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/**
 * 生成改写稿导出文件。
 * 一个创作任务一个工作表，选中的多个版本排在**同一张表**里（「稿件版本」列因此才有意义）。
 */
async function createRewriteExport(ownerId: string, items: ExportRequestItem[]) {
  const { exportable, blocked } = await validateRewriteExport(ownerId, items);
  if (blocked.length > 0) return { ok: false as const, blocked };
  if (exportable.length === 0) {
    return { ok: false as const, blocked: [{ videoId: '', title: '', reason: '没有可导出的改写稿' }] };
  }

  const groups = new Map<string, ExportRewritePayload>();
  const usedRevisions: string[] = [];

  for (const item of exportable) {
    const rev = await prisma.rewriteRevision.findFirst({
      where: { id: item.rewriteRevisionId!, variant: { job: { ownerId } } },
      include: {
        variant: {
          include: {
            job: {
              include: {
                sourceVideo: { select: { title: true, sourceTitle: true } },
                ipProfile: { select: { title: true, versionNo: true } },
                selections: { orderBy: { createdAt: 'desc' }, take: 1 },
              },
            },
          },
        },
        segments: { orderBy: { orderIndex: 'asc' } },
      },
    });
    if (!rev) continue;
    usedRevisions.push(rev.id);

    const job = rev.variant.job;
    const snap = parseJsonObject(job.inputSnapshot);
    const src = job.sourceVideo;

    let g = groups.get(job.id);
    if (!g) {
      const refCount = Array.isArray(snap.refSegments) ? snap.refSegments.length : 0;
      g = {
        jobId: job.id,
        jobTitle: (src?.title ?? '').trim() || (src?.sourceTitle ?? '').trim() || '改写稿（来源视频已删除）',
        // 来源删除后仍能导出已生成的稿件，但抬头要说清来源已不可用（A22）
        sourceTitle: src
          ? (src.title ?? '').trim() || (src.sourceTitle ?? '').trim() || '未提供'
          : '（来源视频已删除，稿件本身仍保留）',
        sourceRevisionLabel: `v${snap.sourceRevisionVersionNo ?? '?'}（${refCount} 段）`,
        platformLabel: REWRITE_PLATFORM_LABEL(job.platform),
        ipProfileLabel: job.ipProfile ? `《${job.ipProfile.title}》 v${job.ipProfile.versionNo}` : '（资料包版本已不存在）',
        modelId: job.modelId,
        generatedAt: job.finishedAt ?? job.createdAt,
        selectionLabel: '本次导出未包含已选定稿件',
        variants: [],
      };
      groups.set(job.id, g);
    }

    // 选定标记：只看最新一次选定是否指向本条修订
    const sel = job.selections[0];
    if (sel && sel.revisionId === rev.id) {
      g.selectionLabel = `已选定：第 ${rev.variant.variantNo} 版（修订 ${rev.revisionNo}）`;
    }

    g.variants.push({
      variantNo: rev.variant.variantNo,
      revisionNo: rev.revisionNo,
      createdBy: rev.createdBy,
      diffSummary: rev.variant.diffSummary,
      charCount: rev.charCount,
      estimatedDurationMs: rev.estimatedDurationMs,
      segments: rev.segments.map((s) => ({ orderIndex: s.orderIndex, tag: s.tag, copyText: s.copyText })),
    });
  }

  const payloads = [...groups.values()];
  if (payloads.length === 0) {
    return { ok: false as const, blocked: [{ videoId: '', title: '', reason: '没有可导出的改写稿' }] };
  }

  const { filePath, fileName } = await buildRewriteWorkbook(payloads, cfg.exportDir);
  const record = await prisma.exportRecord.create({
    data: {
      ownerId,
      kind: EXPORT_KIND.REWRITE,
      status: 'READY',
      filePath,
      fileName,
      itemCount: usedRevisions.length,
      items: {
        create: usedRevisions.map((rid, i) => ({ rewriteRevisionId: rid, orderIndex: i + 1 })),
      },
    },
  });
  return {
    ok: true as const,
    exportId: record.id,
    fileName,
    filePath,
    itemCount: usedRevisions.length,
    kind: EXPORT_KIND.REWRITE,
  };
}
