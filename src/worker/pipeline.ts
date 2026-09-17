import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/db';
import { cfg } from '../lib/config';
import { getAdapters } from '../lib/ai';
import { recordUsage } from '../lib/ai/usage';
import { ORGANIZE_RULES } from '../lib/organize-rules';
import { classify, isMixedCut, unionMs } from '../lib/classification';
import { clampSegments, checkTranscriptFidelity, mergeProblems, partitionSegments, problemSummary, validateSegments } from '../lib/validate';
import { probeMedia, extractAudio, extractSampledFrames } from '../lib/ffmpeg';
import { getSourceAdapter } from '../lib/sources';
import { audioDirFor, framesDirFor } from '../lib/storage';
import { FORM, MISSING, MIXED_CUT_MESSAGE, TAG, unclearAt } from '../lib/constants';
import { setStage } from '../lib/queue';
import type { AudioUtterance, VisionFrameResult } from '../lib/ai/types';
import type { Problem } from '../lib/validate';

export type PipelineOutcome = {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'UNSUPPORTED';
  errorCode?: string;
  errorMessage?: string;
  revisionId?: string;
  problems: Problem[];
};

class DeterministicError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function runPipeline(params: {
  videoId: string;
  attemptId: string;
  retryIndex: number;
}): Promise<PipelineOutcome> {
  const { videoId, attemptId, retryIndex } = params;
  const video = await prisma.video.findUnique({ where: { id: videoId } });
  if (!video) throw new Error('视频记录不存在');

  // ---------- FETCH：来源适配器获取媒体 ----------
  await setStage(attemptId, 'FETCH');
  const adapter = getSourceAdapter(video.sourceType);
  const avail = await adapter.checkAvailability();
  if (!avail.ok) {
    return { status: 'FAILED', errorCode: avail.code, errorMessage: avail.message, problems: [] };
  }
  const staged = await prisma.mediaAsset.findFirst({ where: { videoId }, orderBy: { createdAt: 'desc' } });
  const fetched = await adapter.fetch({
    videoId,
    url: video.sourceUrl,
    stagedPath: staged?.status === 'PENDING' ? staged.cachePath : null,
    fileName: video.fileName,
  });
  if (!fetched.ok) {
    return { status: 'FAILED', errorCode: fetched.code, errorMessage: fetched.message, problems: [] };
  }

  // ---------- CACHE / VALIDATE：媒体可读性校验 ----------
  await setStage(attemptId, 'VALIDATE');
  let probe;
  try {
    probe = await probeMedia(fetched.localPath);
  } catch (e) {
    return {
      status: 'FAILED',
      errorCode: 'MEDIA_UNREADABLE',
      errorMessage: `本地文件损坏或当前格式不支持：${(e as Error).message}`,
      problems: [],
    };
  }
  if (probe.durationMs > cfg.limits.maxDurationMs) {
    return {
      status: 'FAILED',
      errorCode: 'DURATION_EXCEEDED',
      errorMessage: `视频时长 ${Math.round(probe.durationMs / 1000)}s 超过当前配置上限 ${Math.round(cfg.limits.maxDurationMs / 1000)}s`,
      problems: [],
    };
  }

  await prisma.mediaAsset.deleteMany({ where: { videoId } });
  await prisma.mediaAsset.create({
    data: {
      videoId,
      cachePath: fetched.localPath,
      fileName: fetched.fileName,
      sizeBytes: fs.statSync(fetched.localPath).size,
      durationMs: probe.durationMs,
      width: probe.width ?? null,
      height: probe.height ?? null,
      hasAudio: probe.hasAudio,
      status: 'READY',
    },
  });

  // 原视频标题：本地导入 = 原文件名；链接导入 = 网页标题。与可人工编辑的「标题」分开保存。
  const sourceTitle = fetched.sourceTitle ?? fetched.fileName ?? video.fileName ?? null;
  await prisma.video.update({
    where: { id: videoId },
    data: {
      durationMs: probe.durationMs,
      currentStage: 'CLASSIFY',
      status: 'PROCESSING',
      ...(sourceTitle ? { sourceTitle } : {}),
      // 原网页板块快照（人群分析 / 分镜或高光时序 title / 创意标签），落到「视频分析」栏；
      // 取不到时保存空值 + 原因，导出时按「没有则标记为空」处理
      ...(fetched.insight ? { sourceInsight: JSON.stringify(fetched.insight) } : {}),
      // 标题：人工填写优先 → 成功获取的原始标题 → 未提供（并如实标注来源）
      ...(video.titleSource !== 'MANUAL' && fetched.sourceTitle
        ? { title: video.title ?? fetched.sourceTitle, titleSource: 'FETCHED' }
        : {}),
    },
  });

  const adapters = getAdapters();
  const problems: Problem[] = [];

  // ---------- VISION：形式判断的取样必须覆盖时间轴 ----------
  await setStage(attemptId, 'CLASSIFY');
  const sampleDir = path.join(framesDirFor(videoId), 'sample');
  const frames = await extractSampledFrames(fetched.localPath, probe.durationMs, sampleDir, cfg.visionSampleCount);
  const visionStart = new Date();
  let visionOut;
  try {
    visionOut = await adapters.vision.analyze({
      durationMs: probe.durationMs,
      frames: frames.map((f) => ({ path: f.path, timeMs: f.timeMs })),
    });
    await recordUsage({
      attemptId,
      capability: 'VISION',
      modelId: adapters.vision.modelId,
      usage: visionOut.usage,
      status: 'SUCCEEDED',
      retryIndex,
      startedAt: visionStart,
      finishedAt: new Date(),
    });
  } catch (e) {
    await recordUsage({
      attemptId,
      capability: 'VISION',
      modelId: adapters.vision.modelId,
      usage: { usageMissing: true },
      status: 'FAILED',
      retryIndex,
      startedAt: visionStart,
      finishedAt: new Date(),
      errorMessage: (e as Error).message,
    });
    // 辅助描述失败时保留可用文案（这里语音尚未执行），按失败处理并允许重试
    return {
      status: 'FAILED',
      errorCode: 'VISION_FAILED',
      errorMessage: `画面理解失败：${(e as Error).message}`,
      problems: [],
    };
  }
  problems.push(...mergeProblems([], visionOut.issues));

  // ---------- CLASSIFY ----------
  const cls = classify({
    durationMs: probe.durationMs,
    vision: visionOut.formSuggestion,
    ratioUnreliable: frames.length < 3,
  });
  const manual = await isManuallyOverridden(videoId);
  const clsPayload = {
    attemptId,
    category: cls.category,
    categoryLabel: cls.categoryLabel,
    aiUnionMs: cls.aiUnionMs,
    aiRatio: cls.aiRatio,
    ratioEstimated: cls.ratioEstimated,
    evidence: cls.evidence,
    uncertain: cls.uncertain,
    modelVersion: adapters.vision.modelId,
  };
  await prisma.classification.upsert({
    where: { videoId },
    create: { videoId, ...clsPayload },
    // 人工覆盖优先：已人工覆盖时不回写自动判断
    update: manual ? {} : clsPayload,
  });
  const effectiveCategory = manual
    ? (await prisma.classification.findUnique({ where: { videoId } }))!.category
    : cls.category;
  const effectiveLabel = manual
    ? (await prisma.classification.findUnique({ where: { videoId } }))!.categoryLabel
    : cls.categoryLabel;

  // ---------- 混剪（新逻辑，2026-09-15）：照常识别与整理文案，仅妆造/画面场景/情绪留空 ----------
  const mixed = isMixedCut(effectiveCategory);
  if (mixed) {
    problems.push({
      code: 'MIXED_CUT_PARTIAL',
      message: '形式判定为混剪：文案照常分段打标签，妆造 / 画面场景 / 情绪三项不再标注（只在视频分析中体现一次）',
      severity: 'info',
    });
  }

  // ---------- ASR ----------
  await setStage(attemptId, 'ASR');
  let utterances: AudioUtterance[] = [];
  if (probe.hasAudio) {
    const audioPath = path.join(audioDirFor(videoId), 'audio.mp3');
    await extractAudio(fetched.localPath, audioPath);
    const asrStart = new Date();
    try {
      const asrOut = await adapters.audio.recognize({
        audioPath,
        durationMs: probe.durationMs,
        language: 'zh',
        hasAudio: true,
      });
      await recordUsage({
        attemptId,
        capability: 'ASR',
        modelId: adapters.audio.modelId,
        usage: asrOut.usage,
        status: 'SUCCEEDED',
        retryIndex,
        startedAt: asrStart,
        finishedAt: new Date(),
      });
      utterances = asrOut.utterances;
      problems.push(...mergeProblems([], asrOut.issues));
    } catch (e) {
      await recordUsage({
        attemptId,
        capability: 'ASR',
        modelId: adapters.audio.modelId,
        usage: { audioSeconds: probe.durationMs / 1000, usageMissing: true },
        status: 'FAILED',
        retryIndex,
        startedAt: asrStart,
        finishedAt: new Date(),
        errorMessage: (e as Error).message,
      });
      problems.push({
        code: 'ASR_FAILED',
        message: `音频识别失败：${(e as Error).message}。不生成猜测文案，保留画面与问题标记`,
        severity: 'error',
      });
    }
  } else {
    problems.push({ code: 'NO_AUDIO_TRACK', message: '无音轨：文案与旁白填“无”，不计为识别服务失败', severity: 'info' });
  }

  // ---------- ORGANIZE ----------
  await setStage(attemptId, 'ORGANIZE');
  const orgStart = new Date();
  let organized;
  try {
    organized = await adapters.organize.organize({
      durationMs: probe.durationMs,
      utterances,
      visionFrames: visionOut.frames,
      form: { category: effectiveCategory, categoryLabel: effectiveLabel, evidence: cls.evidence },
      rules: ORGANIZE_RULES,
    });
    await recordUsage({
      attemptId,
      capability: 'ORGANIZE',
      modelId: adapters.organize.modelId,
      usage: organized.usage,
      status: 'SUCCEEDED',
      retryIndex,
      startedAt: orgStart,
      finishedAt: new Date(),
    });
  } catch (e) {
    await recordUsage({
      attemptId,
      capability: 'ORGANIZE',
      modelId: adapters.organize.modelId,
      usage: { usageMissing: true },
      status: 'FAILED',
      retryIndex,
      startedAt: orgStart,
      finishedAt: new Date(),
      errorMessage: (e as Error).message,
    });
    problems.push({
      code: 'ORGANIZE_FAILED',
      message: `脚本整理失败：${(e as Error).message}`,
      severity: 'error',
    });
    // 整理失败但已有原始转写：可保留可用文案，按部分完成处理
    if (utterances.length === 0) {
      return {
        status: 'FAILED',
        errorCode: 'ORGANIZE_FAILED',
        errorMessage: `脚本整理失败且无可用文案：${(e as Error).message}`,
        problems,
      };
    }
    organized = {
      segments: utterances
        .filter((u) => u.text.trim() !== '')
        .map((u) => ({
          startMs: u.startMs,
          endMs: u.endMs,
          copyText: u.text,
          // 模型整理失败时保留可识别原文：标签统一归「其他」，不猜测归类
          tag: TAG.OTHER,
          voiceover: '',
          makeup: MISSING.PENDING_REVIEW,
          emotion: MISSING.PENDING_REVIEW,
          sourceUtteranceIds: [u.id],
        })),
      issues: [],
      usage: {},
    };
  }

  // ---------- 校验：漏段 / 重复 / 非允许改写 / 标签合法性 / 时间约束 ----------
  const clamped = clampSegments(organized.segments, probe.durationMs);
  // 划分兜底：按原始语音片段重建「不重不漏」的段落（一个片段只归属一段、时间由片段推导、
  // 重复段直接丢弃、文案一律取原文）。模型给出的重叠引用与改写在此被消除并留痕。
  const partition = partitionSegments(utterances, clamped);
  let segments = partition.segments;
  // 模型返回空段落数组时，不能让整条转写丢失：退化为「每个语块一段」，标签统一归「其他」不猜
  if (segments.length === 0 && utterances.length > 0) {
    segments = utterances.map((u) => ({
      startMs: u.startMs,
      endMs: u.endMs,
      copyText: u.unclear ? unclearAt(u.startMs, u.endMs) : u.text,
      tag: TAG.OTHER,
      voiceover: '',
      makeup: MISSING.PENDING_REVIEW,
      emotion: MISSING.PENDING_REVIEW,
      sourceUtteranceIds: [u.id],
    }));
    problems.push({
      code: 'ORGANIZE_EMPTY',
      message: '脚本整理未返回任何段落，已按原始语音片段逐块保留文案，标签统一归「其他」，请人工确认',
      severity: 'warn',
    });
  }
  // 混剪：妆造 / 画面场景 / 情绪三项留空，不做任何推断
  if (mixed) {
    for (const s of segments) {
      s.makeup = '';
      s.emotion = '';
    }
  }
  // 画面场景：不再逐段标注（2026-09-16 需求），整条视频只出现一次，
  // 取画面理解（视觉模型）对画面本身的描述，不经过文案整理模型。
  const sceneOverview = mixed
    ? ''
    : visionOut.frames.find((f) => f.scene && f.scene !== MISSING.SAME_AS_ABOVE)?.scene ?? MISSING.UNRECOGNIZABLE;
  problems.push(...partition.problems);
  problems.push(...checkTranscriptFidelity(utterances, segments));
  problems.push(...validateSegments(segments, probe.durationMs));
  problems.push(...mergeProblems([], organized.issues));

  // 脚本文案：音频转写模型给出的一整段原文（不切分、不改写），
  // 在工作台「脚本文案」栏展示并可在人工复核时编辑。
  const transcriptText = utterances.length
    ? utterances.map((u) => (u.unclear ? unclearAt(u.startMs, u.endMs) : u.text)).join('')
    : MISSING.NONE;

  // ---------- SAVE：生成版本（截图能力已全量下线，不再取帧、不写 Screenshot 表） ----------
  await setStage(attemptId, 'SAVE');
  const rev = await saveRevision({
    videoId,
    attemptId,
    segments,
    visionFrames: visionOut.frames,
    formLabel: effectiveLabel,
    sourceUrl: video.sourceUrl,
    durationMs: probe.durationMs,
    problems,
    isMixedCut: mixed,
    sceneOverview,
    transcriptText,
  });

  const hasError = problems.some((p) => p.severity === 'error');
  const status = hasError ? 'PARTIAL' : 'COMPLETED';
  const finalSourceTitle = fetched.sourceTitle ?? fetched.fileName ?? video.fileName ?? null;
  await prisma.video.update({
    where: { id: videoId },
    data: {
      status,
      currentStage: null,
      problemFlags: JSON.stringify(problemSummary(problems)),
      ...(finalSourceTitle ? { sourceTitle: finalSourceTitle } : {}),
      // 人工填写的标题优先，不被获取到的标题覆盖
      title: video.title && video.titleSource === 'MANUAL' ? video.title : video.title ?? fetched.sourceTitle ?? null,
      ...(video.titleSource === 'NONE' && fetched.sourceTitle ? { titleSource: 'FETCHED' } : {}),
    },
  });

  return { status: hasError ? 'PARTIAL' : 'SUCCEEDED', revisionId: rev.id, problems };
}

async function isManuallyOverridden(videoId: string) {
  const c = await prisma.classification.findUnique({ where: { videoId } });
  return c?.manualOverride === true;
}

async function saveRevision(params: {
  videoId: string;
  attemptId: string;
  segments: Array<{
    startMs: number;
    endMs: number;
    copyText: string;
    tag: string;
    voiceover: string;
    makeup: string;
    emotion: string;
    sourceUtteranceIds: string[];
    timeUncertain?: boolean;
  }>;
  visionFrames: VisionFrameResult[];
  formLabel: string;
  sourceUrl?: string | null;
  durationMs: number;
  problems: Problem[];
  /** 混剪：妆造/画面场景/情绪留空，不再标注 */
  isMixedCut?: boolean;
  /** 「视频分析」栏的画面场景：整条视频一次的概览；混剪为空 */
  sceneOverview?: string;
  /** 「脚本文案」栏：转写原文整段（不切分、不改写）；无语音时为「无」 */
  transcriptText?: string;
}) {
  const { videoId, attemptId, segments, visionFrames, durationMs, problems } = params;
  const last = await prisma.scriptRevision.findFirst({ where: { videoId }, orderBy: { versionNo: 'desc' } });
  const versionNo = (last?.versionNo ?? 0) + 1;

  return prisma.$transaction(async (tx) => {
    await tx.scriptRevision.updateMany({ where: { videoId, isCurrent: true }, data: { isCurrent: false } });
    const created = await tx.scriptRevision.create({
      data: {
        videoId,
        attemptId,
        versionNo,
        isCurrent: true,
        reviewStatus: 'NOT_REVIEWED',
        sceneOverview: params.sceneOverview ?? '',
        transcriptText: params.transcriptText ?? '',
        problems: JSON.stringify(
          problems
            .map((p) => ({
              code: p.code,
              message: p.message,
              segmentIndex: p.segmentIndex,
              startMs: p.startMs,
              endMs: p.endMs,
              severity: p.severity,
            }))
            .slice(0, 300),
        ),
        createdBy: 'AI',
      },
    });

    for (let i = 0; i < segments.length; i += 1) {
      const s = segments[i];
      await tx.segment.create({
        data: {
          revisionId: created.id,
          orderIndex: i + 1,
          startMs: s.startMs,
          endMs: s.endMs,
          copyText: s.copyText,
          tag: s.tag,
          voiceover: '',
          makeup: s.makeup,
          makeupFull: fullValue(s.makeup, visionFrames, 'makeup'),
          emotion: s.emotion,
          timeUncertain: Boolean(s.timeUncertain),
          problemFlags: JSON.stringify(
            s.sourceUtteranceIds.length === 0 && s.copyText === MISSING.NONE ? ['no_subject_speech'] : [],
          ),
        },
      });
    }

    return created;
  });
}

/** 妆造显示“同上”时，数据层必须能还原完整描述 */
function fullValue(display: string, frames: VisionFrameResult[], key: 'makeup') {
  if (display && display !== MISSING.SAME_AS_ABOVE) return display;
  const first = frames.find((f) => f[key] && f[key] !== MISSING.SAME_AS_ABOVE);
  return first ? first[key] : display;
}

export { DeterministicError };
