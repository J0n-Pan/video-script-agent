// 个性化文案生成服务（2026-09-20 需求迭代 §4 / §5 / §8 / §9）。
//
// 职责边界：
// - 只消费**已保存**的分析结果，不重复跑 ASR / 抽帧 / 画面理解（A01）；
// - 生成过程不碰参考稿：新稿存独立实体，不覆盖 ScriptRevision / Segment；
// - 结构契约由 validateDrafts 裁决，不合法的整稿丢弃并留问题项，不修补；
// - 用量记录挂 RewriteJob（ownerType=REWRITE_JOB，capability=REWRITE），
//   不能记成一次新的语音或视觉解析。

import { prisma } from '../db';
import { cfg } from '../config';
import { TAG_ORDER } from '../constants';
import { getAdapters } from '../ai';
import type { RewriteInput, RewriteRefSegment } from '../ai/types';
import { buildRewriteRules, buildRewriteUserMessage, REWRITE_PLATFORM_LABEL, isPlatform } from './rules';
import {
  validateDrafts,
  findDuplicateDrafts,
  checkLengthBalance,
  checkBannedWordHits,
  checkTranscriptConsistency,
  concatSegments,
  estimateDurationMs,
  normalizeForCompare,
  type RewriteProblem,
} from './validate';
import { getActiveProfile, renderProfileText, PROFILE_KIND, type IpProfileStructured } from './profile';
import { readBannedPack, renderBannedText, scanBannedWords, type BannedWordEntry } from './banned';

export type BuildInputResult = {
  input: RewriteInput;
  refs: RewriteRefSegment[];
  sourceRevisionId: string;
  /** 参考版本的版本号（导出抬头要用「参考版本 vN」，只给 ID 编导看不懂） */
  sourceRevisionVersionNo: number;
  ipProfileId: string;
  ipProfileVersionNo: number;
  /** 生效的违禁词包（没配置时为 null）；命中检查与界面提示都靠它 */
  bannedPackId: string | null;
  bannedPackVersionNo: number | null;
  bannedPackTitle: string;
  /** 本次生成要检查的违禁词条目（从生效版本解析；没配置为空数组） */
  bannedEntries: BannedWordEntry[];
  /** 参考版本「整段文案 vs 分段」是否一致；不一致时界面要提示（§5.3） */
  transcriptConsistent: boolean;
  transcriptNotice: string;
  sourceInsightText: string;
};

export type BuildInputOptions = {
  ownerId: string;
  sourceVideoId: string;
  /** 指定参考版本；不传则用当前版本 */
  sourceRevisionId?: string | null;
  platform?: string;
  variantCount?: number;
  ipProfileRevisionId?: string | null;
};

/** 视频分析摘要：只取对创作有参考价值的字段，缺失就如实说明缺失 */
function renderInsight(sourceInsight: string): string {
  let o: any = null;
  try {
    o = JSON.parse(sourceInsight || '{}');
  } catch {
    o = null;
  }
  if (!o || typeof o !== 'object' || Object.keys(o).length === 0) return '';
  const lines: string[] = [];
  const aud = o.audience ?? {};
  if (aud.coreGender || aud.coreAge) lines.push(`核心受众：${[aud.coreAge, aud.coreGender].filter(Boolean).join(' / ')}`);
  if (Array.isArray(o.creativeTags) && o.creativeTags.length) {
    lines.push(
      '创意标签：' +
        o.creativeTags
          .slice(0, 12)
          .map((t: any) => (typeof t === 'string' ? t : `${t.label ?? t.key ?? ''}:${t.value ?? ''}`))
          .join('；'),
    );
  }
  if (Array.isArray(o.shotTitles) && o.shotTitles.length) lines.push(`原片分镜/高光：${o.shotTitles.slice(0, 8).join(' → ')}`);
  if (o.missingReason) lines.push(`缺失说明：${o.missingReason}`);
  return lines.join('\n');
}

/** 取当前生效的违禁词条目（命中检查用；没配置返回空数组，检查自动跳过） */
async function activeBannedEntries(ownerId: string): Promise<BannedWordEntry[]> {
  const p = await getActiveProfile(ownerId, PROFILE_KIND.BANNED);
  return p ? readBannedPack(p.profileJson).entries : [];
}

/**
 * 组装一次生成所需的全部输入。
 * 关键点：把「参考版本快照 + 视频分析 + 资料包版本 + 规则 + 数量」一并取出来，
 * 因为 sourceInsight 不随脚本版本保存，仅引用版本 ID 无法重现当时输入（§8）。
 */
export async function buildRewriteInput(opts: BuildInputOptions): Promise<BuildInputResult> {
  const video = await prisma.video.findFirst({
    where: { id: opts.sourceVideoId, ownerId: opts.ownerId, deletedAt: null },
    include: { classification: true },
  });
  if (!video) throw new Error('参考视频不存在或无权访问');

  const revision = opts.sourceRevisionId
    ? await prisma.scriptRevision.findFirst({
        where: { id: opts.sourceRevisionId, videoId: video.id },
        include: { segments: { orderBy: { orderIndex: 'asc' } } },
      })
    : await prisma.scriptRevision.findFirst({
        where: { videoId: video.id, isCurrent: true },
        include: { segments: { orderBy: { orderIndex: 'asc' } } },
      });
  if (!revision) throw new Error('参考视频没有可用的保存版本，无法生成');
  if (revision.segments.length === 0) throw new Error('参考版本没有可用分段，无法生成');

  const usable = revision.segments.filter((s) => (s.copyText ?? '').trim().length > 0);
  if (usable.length === 0) throw new Error('参考版本没有有效正文（所有分段文案为空），请先修正识别结果再生成');
  if (usable.length !== revision.segments.length) {
    // 不静默跳过：缺正文的段会让结构对不齐，必须让编导先修正
    throw new Error(
      `参考版本有 ${revision.segments.length - usable.length} 段没有正文，结构会对不齐。请先修正这些段落再生成。`,
    );
  }

  const refs: RewriteRefSegment[] = revision.segments.map((s) => ({
    id: s.id,
    orderIndex: s.orderIndex,
    tag: s.tag,
    copyText: s.copyText,
  }));

  const profile = opts.ipProfileRevisionId
    ? await prisma.ipProfileRevision.findFirst({ where: { id: opts.ipProfileRevisionId, ownerId: opts.ownerId } })
    : await getActiveProfile(opts.ownerId);
  if (!profile) throw new Error('还没有 IP 资料包，无法生成（事实只能来自资料包，不允许编造）');

  let structured: IpProfileStructured;
  try {
    structured = JSON.parse(profile.profileJson || '{}');
  } catch {
    structured = { sections: {} as any, facts: [] };
  }
  if (!Array.isArray(structured.facts)) structured = { sections: (structured as any).sections ?? {}, facts: [] };

  const platform = opts.platform && isPlatform(opts.platform) ? opts.platform : cfg.rewrite.platform;
  const variantCount = Math.max(1, Math.min(opts.variantCount ?? cfg.rewrite.variantCount, 10));

  const consistency = checkTranscriptConsistency(revision.transcriptText ?? '', refs);
  const sourceInsightText = renderInsight(video.sourceInsight);

  // 违禁词包：始终取当前生效版本（不像 IP 资料包那样允许任务级指定版本 ——
  // 「此刻不许出现的词」本来就该按最新口径算）。
  const bannedPack = await getActiveProfile(opts.ownerId, PROFILE_KIND.BANNED);
  const bannedPackData = bannedPack ? readBannedPack(bannedPack.profileJson) : null;
  const bannedEntries = bannedPackData?.entries ?? [];
  const bannedWordsText =
    bannedPack && bannedPackData ? renderBannedText(bannedPackData, bannedPack.title, bannedPack.versionNo) : '';

  const rules = buildRewriteRules();
  const input: RewriteInput = {
    platform,
    platformLabel: REWRITE_PLATFORM_LABEL(platform),
    variantCount,
    refSegments: refs,
    ipProfileText: renderProfileText(structured, profile.title, profile.versionNo),
    ipProfileVersion: profile.versionNo,
    bannedWordsText,
    bannedPackVersion: bannedPack?.versionNo ?? null,
    videoInsightText: sourceInsightText,
    formLabel: video.classification?.categoryLabel ?? '未识别',
    durationMs: video.durationMs ?? null,
    rules,
  };
  // 保证提示词与传给适配器的规则完全同源
  input.rules = buildRewriteRules();

  return {
    input,
    refs,
    sourceRevisionId: revision.id,
    sourceRevisionVersionNo: revision.versionNo,
    ipProfileId: profile.id,
    ipProfileVersionNo: profile.versionNo,
    bannedPackId: bannedPack?.id ?? null,
    bannedPackVersionNo: bannedPack?.versionNo ?? null,
    bannedPackTitle: bannedPack?.title ?? '',
    bannedEntries,
    transcriptConsistent: consistency.consistent,
    transcriptNotice: consistency.message,
    sourceInsightText,
  };
}

export type RewriteSegmentView = {
  orderIndex: number;
  sourceSegmentId: string | null;
  tag: string;
  copyText: string;
  factRefs: string[];
};

export type RewriteVariantView = {
  /**
   * 候选稿（RewriteVariant）自身的主键。
   *
   * **必须返回**：保存编辑的接口是 `/api/rewrite-variants/<variantId>/revisions`，
   * 服务端按 variantId 查候选稿。2026-09-21 的 bug 就是这里漏了 id，
   * 前端只好拿 revisionId 当路径参数 → 服务端查不到候选稿 → 保存永远失败、
   * 且因「有未保存改动」而连锁导致「选定本版」被禁用。
   */
  id: string;
  variantNo: number;
  diffSummary: string;
  blockedReason: string;
  revisionId?: string;
  revisionNo?: number;
  /** 该版本累计修订数（AI + 人工），用于界面显示「已改 N 次」 */
  revisionCount?: number;
  charCount: number;
  estimatedDurationMs: number;
  problemFlags: string[];
  segments: RewriteSegmentView[];
};

export type GenerateRewriteResult = {
  jobId?: string;
  model: string;
  usageMissing: boolean;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  estimatedCost: number | null;
  variants: RewriteVariantView[];
  problems: RewriteProblem[];
  transcriptNotice: string;
  /** 干跑模式不落库，直接把结果返回给调用方（横向实测 / 测试用） */
  dryRun: boolean;
};

export type GenerateRewriteOptions = BuildInputOptions & {
  /** 覆盖模型（横向实测用）；不传用 REWRITE_MODEL */
  model?: string;
  /** 幂等键：同一次点击重复请求返回同一任务 */
  clientKey?: string | null;
  /** 只生成不落库 */
  dryRun?: boolean;
};

function estimateCost(model: string, inputTokens?: number, outputTokens?: number): number | null {
  const p = cfg.pricing.rewriteModels[model];
  if (!p || inputTokens == null || outputTokens == null) return null;
  return (inputTokens / 1e6) * p.inputPerMillion + (outputTokens / 1e6) * p.outputPerMillion;
}

/**
 * 执行一次生成。严格结构校验后的稿件才会入库。
 * 需要说明的是：**语义层面**（第一人称、事实引用是否恰当、有没有隐性新增引流）
 * 只能靠编导复核，结构计数通过不等于语义合格（§5.4）。
 */
export async function generateRewrite(opts: GenerateRewriteOptions): Promise<GenerateRewriteResult> {
  const built = await buildRewriteInput(opts);
  const adapters = getAdapters();
  const model = opts.model ?? adapters.rewrite.modelId;

  // 幂等：同 owner + clientKey 已有任务则直接回放，不重复计费
  if (!opts.dryRun && opts.clientKey) {
    const exists = await prisma.rewriteJob.findFirst({
      where: { ownerId: opts.ownerId, clientKey: opts.clientKey },
      include: { variants: { include: { revisions: { include: { segments: { orderBy: { orderIndex: 'asc' } } } } } } },
    });
    if (exists) {
      return {
        jobId: exists.id,
        model: exists.modelId,
        usageMissing: false,
        estimatedCost: null,
        dryRun: false,
        transcriptNotice: built.transcriptNotice,
        problems: [{ code: 'REWRITE_IDEMPOTENT_REPLAY', message: '同一次请求已存在生成任务，直接返回原任务', severity: 'info' }],
        variants: exists.variants.map((v) => {
          const rev = v.revisions[0];
          return {
            id: v.id,
            variantNo: v.variantNo,
            diffSummary: v.diffSummary,
            blockedReason: v.currentRevisionId ? '' : '未生成',
            revisionId: rev?.id,
            revisionNo: rev?.revisionNo,
            charCount: rev?.charCount ?? 0,
            estimatedDurationMs: rev?.estimatedDurationMs ?? 0,
            problemFlags: JSON.parse(rev?.problemFlags || '[]'),
            segments: (rev?.segments ?? []).map((s) => ({
              orderIndex: s.orderIndex,
              sourceSegmentId: s.sourceSegmentId,
              tag: s.tag,
              copyText: s.copyText,
              factRefs: JSON.parse(s.factRefs || '[]'),
            })),
          };
        }),
      };
    }
  }

  // 干跑也调用同一适配器，只是不落库
  if (opts.dryRun) {
    const out = await adapters.rewrite.rewrite({ ...built.input, model });
    const v = validateDrafts(built.refs, out.drafts, built.input.variantCount);
    const problems = [
      ...out.issues,
      ...v.problems,
      ...findDuplicateDrafts(v.drafts),
      ...checkLengthBalance(built.refs, v.drafts),
      ...checkBannedWordHits(v.drafts, built.bannedEntries),
    ];
    return {
      model,
      usageMissing: out.usage.usageMissing === true,
      inputTokens: out.usage.inputTokens,
      outputTokens: out.usage.outputTokens,
      thinkingTokens: out.usage.thinkingTokens,
      estimatedCost: estimateCost(model, out.usage.inputTokens, out.usage.outputTokens),
      variants: v.drafts.map((d) => ({
        // 干跑（横向实测 / 测试）不落库，因此没有候选稿 id；空串表示不可保存
        id: '',
        variantNo: d.variantNo,
        diffSummary: d.diffSummary,
        blockedReason: d.blockedReason,
        charCount: d.charCount,
        estimatedDurationMs: d.estimatedDurationMs,
        problemFlags: d.problemFlags,
        segments: d.segments,
      })),
      problems,
      transcriptNotice: built.transcriptNotice,
      dryRun: true,
    };
  }

  const snapshot = {
    takenAt: new Date().toISOString(),
    platform: built.input.platform,
    variantCount: built.input.variantCount,
    sourceRevisionId: built.sourceRevisionId,
    sourceRevisionVersionNo: built.sourceRevisionVersionNo,
    refSegments: built.refs,
    sourceInsight: built.sourceInsightText,
    formLabel: built.input.formLabel,
    durationMs: built.input.durationMs,
    ipProfileId: built.ipProfileId,
    ipProfileVersionNo: built.ipProfileVersionNo,
    /**
     * 违禁词包**连渲染后的全文一起入快照**（而不是只存版本 ID 让重新生成时回读）。
     *
     * 理由有两条：① 违禁词是"此刻口径"，回读会拿到后来导入的新词表，
     * 那就不是对同一份输入的重新生成（A11）；② 命中检查要用的条目也在快照里，
     * 界面与重新生成都不必再查库。IP 资料包走版本 ID 是因为它体量大得多（上万字）。
     */
    bannedWordsText: built.input.bannedWordsText,
    bannedPackId: built.bannedPackId,
    bannedPackVersionNo: built.bannedPackVersionNo,
    bannedPackTitle: built.bannedPackTitle,
    // 参考版本「整段文案 vs 分段」当时是否一致：任务详情要能原样复现这个提示（§5.3）
    transcriptConsistent: built.transcriptConsistent,
    transcriptNotice: built.transcriptNotice,
    // 规则与提示词全文入快照：日后改了提示词也能复现当时的输入
    rules: built.input.rules,
    promptVersion: cfg.rewrite.promptVersion,
    ruleVersion: cfg.rewrite.ruleVersion,
  };

  const job = await prisma.rewriteJob.create({
    data: {
      ownerId: opts.ownerId,
      sourceVideoId: opts.sourceVideoId,
      sourceRevisionId: built.sourceRevisionId,
      platform: built.input.platform,
      variantCount: built.input.variantCount,
      ipProfileRevisionId: built.ipProfileId,
      modelId: model,
      promptVersion: cfg.rewrite.promptVersion,
      ruleVersion: cfg.rewrite.ruleVersion,
      inputSnapshot: JSON.stringify(snapshot),
      status: 'RUNNING',
      stage: 'REWRITE',
      clientKey: opts.clientKey ?? null,
      startedAt: new Date(),
    },
  });

  const callNo =
    (await prisma.modelUsage.count({ where: { rewriteJobId: job.id } })) + 1;
  const startedAt = new Date();
  let out;
  try {
    out = await adapters.rewrite.rewrite({ ...built.input, model });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.modelUsage.create({
      data: {
        ownerType: 'REWRITE_JOB',
        rewriteJobId: job.id,
        callNo,
        capability: 'REWRITE',
        modelId: model,
        status: 'FAILED',
        retryIndex: 0,
        startedAt,
        finishedAt: new Date(),
        errorMessage: msg.slice(0, 900),
        usageMissing: true,
      },
    });
    await prisma.rewriteJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', errorCode: 'REWRITE_CALL_FAILED', errorMessage: msg.slice(0, 900), finishedAt: new Date() },
    });
    throw e;
  }

  const rawUsageMissing = out.usage.usageMissing === true;
  const cost = estimateCost(model, out.usage.inputTokens, out.usage.outputTokens);
  await prisma.modelUsage.create({
    data: {
      ownerType: 'REWRITE_JOB',
      rewriteJobId: job.id,
      callNo,
      capability: 'REWRITE',
      modelId: model,
      status: 'SUCCEEDED',
      inputTokens: out.usage.inputTokens ?? null,
      outputTokens: out.usage.outputTokens ?? null,
      thinkingTokens: out.usage.thinkingTokens ?? null,
      estimatedCost: cost,
      usageMissing: rawUsageMissing,
      vendorRequestId: out.usage.vendorRequestId ?? null,
      priceVersion: cfg.pricing.priceVersion,
      startedAt,
      finishedAt: new Date(),
    },
  });

  const v = validateDrafts(built.refs, out.drafts, built.input.variantCount);
  const problems: RewriteProblem[] = [
    ...out.issues,
    ...v.problems,
    ...findDuplicateDrafts(v.drafts),
    ...checkLengthBalance(built.refs, v.drafts),
    ...checkBannedWordHits(v.drafts, built.bannedEntries),
  ];

  const variants: RewriteVariantView[] = [];
  for (const d of v.drafts) {
    if (d.blockedReason) {
      const created = await prisma.rewriteVariant.create({
        data: { jobId: job.id, variantNo: d.variantNo, diffSummary: d.blockedReason },
      });
      variants.push({
        id: created.id,
        variantNo: d.variantNo,
        diffSummary: d.diffSummary,
        blockedReason: d.blockedReason,
        charCount: 0,
        estimatedDurationMs: 0,
        problemFlags: ['REWRITE_BLOCKED'],
        segments: [],
      });
      continue;
    }
    const variant = await prisma.rewriteVariant.create({
      data: { jobId: job.id, variantNo: d.variantNo, diffSummary: d.diffSummary },
    });
    const rev = await prisma.rewriteRevision.create({
      data: {
        variantId: variant.id,
        revisionNo: 1,
        createdBy: 'AI',
        transcriptText: d.transcriptText,
        charCount: d.charCount,
        estimatedDurationMs: d.estimatedDurationMs,
        problemFlags: JSON.stringify(d.problemFlags),
        segments: {
          create: d.segments.map((s) => ({
            orderIndex: s.orderIndex,
            sourceSegmentId: s.sourceSegmentId,
            tag: s.tag,
            copyText: s.copyText,
            factRefs: JSON.stringify(s.factRefs),
          })),
        },
      },
    });
    await prisma.rewriteVariant.update({ where: { id: variant.id }, data: { currentRevisionId: rev.id } });
    variants.push({
      id: variant.id,
      variantNo: d.variantNo,
      diffSummary: d.diffSummary,
      blockedReason: '',
      revisionId: rev.id,
      revisionNo: rev.revisionNo,
      charCount: d.charCount,
      estimatedDurationMs: d.estimatedDurationMs,
      problemFlags: d.problemFlags,
      segments: d.segments,
    });
  }

  const usableVariants = variants.filter((x) => !x.blockedReason);
  const hasError = problems.some((p) => p.severity === 'error');
  await prisma.rewriteJob.update({
    where: { id: job.id },
    data: {
      status: usableVariants.length === 0 ? 'FAILED' : hasError || usableVariants.length < built.input.variantCount ? 'PARTIAL' : 'SUCCEEDED',
      stage: null,
      errorCode: usableVariants.length === 0 ? 'REWRITE_NO_USABLE_VARIANT' : null,
      errorMessage: hasError ? problems.filter((p) => p.severity === 'error').map((p) => p.message).join('；').slice(0, 900) : null,
      finishedAt: new Date(),
    },
  });

  // 参考版本「整段与分段不一致」的提示记进任务快照侧的问题项，不自动改源数据（§5.3）
  if (!built.transcriptConsistent) {
    problems.push({ code: 'TRANSCRIPT_MISMATCH', message: built.transcriptNotice, severity: 'warn' });
  }

  return {
    jobId: job.id,
    model,
    usageMissing: rawUsageMissing,
    inputTokens: out.usage.inputTokens,
    outputTokens: out.usage.outputTokens,
    thinkingTokens: out.usage.thinkingTokens,
    estimatedCost: cost,
    variants,
    problems,
    transcriptNotice: built.transcriptNotice,
    dryRun: false,
  };
}

/** 任务详情（含版本与修订），用于接口与页面 */
export async function getRewriteJob(ownerId: string, jobId: string) {
  return prisma.rewriteJob.findFirst({
    where: { id: jobId, ownerId },
    include: {
      variants: {
        orderBy: { variantNo: 'asc' },
        include: { revisions: { orderBy: { revisionNo: 'desc' }, include: { segments: { orderBy: { orderIndex: 'asc' } } } } },
      },
      selections: { orderBy: { createdAt: 'desc' } },
      ipProfile: { select: { id: true, versionNo: true, title: true } },
      sourceVideo: { select: { id: true, title: true, sourceTitle: true, durationMs: true } },
    },
  });
}

// ============================================================================
// 生成任务的后续操作：重新生成 / 编辑保存 / 选稿 / 列表
// 对应需求文档 §9 的接口建议；约束见 §5.1（严格结构）、A10（乐观锁）、A11（快照不可回改）、A12（未保存不得用于视频）。
// ============================================================================

function safeArr(raw: string | null | undefined): string[] {
  try {
    const o = JSON.parse(raw || '[]');
    return Array.isArray(o) ? o.map(String) : [];
  } catch {
    return [];
  }
}

function parseSnapshot(raw: string): Record<string, any> {
  try {
    const o = JSON.parse(raw || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/**
 * 由任务快照 + 任务锁定的资料包版本重建提示词输入。
 *
 * 为什么不重新读参考稿：A11 要求「原参考稿或资料包后续变更，不修改已有生成任务的输入快照」。
 * 资料包版本只追加不覆盖（profile.ts），所以按版本 ID 读回的内容与当时一致；
 * 参考段则直接取快照里的副本，**不回读 ScriptRevision** —— 编导后来改了原稿也不能影响已生成任务。
 */
async function rebuildInputFromSnapshot(
  job: { platform: string; ipProfileRevisionId: string | null; inputSnapshot: string },
  targetCount: number,
): Promise<RewriteInput> {
  const snap = parseSnapshot(job.inputSnapshot);
  const refs: RewriteRefSegment[] = Array.isArray(snap.refSegments) ? snap.refSegments : [];
  if (refs.length === 0) throw new Error('任务缺少输入快照（参考段为空），无法重新生成');

  const profile = job.ipProfileRevisionId
    ? await prisma.ipProfileRevision.findUnique({ where: { id: job.ipProfileRevisionId } })
    : null;
  if (!profile) throw new Error('任务锁定的资料包版本已不存在，无法重新生成（事实只能来自资料包，不允许编造）');

  let structured: IpProfileStructured;
  try {
    structured = JSON.parse(profile.profileJson || '{}');
  } catch {
    structured = { sections: {} as any, facts: [] };
  }
  if (!Array.isArray(structured.facts)) structured = { sections: (structured as any).sections ?? {}, facts: [] };

  return {
    platform: job.platform,
    platformLabel: REWRITE_PLATFORM_LABEL(job.platform),
    variantCount: targetCount,
    refSegments: refs,
    ipProfileText: renderProfileText(structured, profile.title, profile.versionNo),
    ipProfileVersion: profile.versionNo,
    videoInsightText: String(snap.sourceInsight ?? ''),
    formLabel: String(snap.formLabel ?? '未识别'),
    durationMs: snap.durationMs ?? null,
    // 用当时快照里的规则全文；老任务没有该字段时回落到当前规则
    rules: typeof snap.rules === 'string' ? snap.rules : buildRewriteRules(),
    // 违禁词：老任务快照里没有该字段时按"没有禁用表达"处理，不拿今天的词表去追溯昨天的稿
    bannedWordsText: typeof snap.bannedWordsText === 'string' ? snap.bannedWordsText : '',
    bannedPackVersion: typeof snap.bannedPackVersionNo === 'number' ? snap.bannedPackVersionNo : null,
  };
}

/** 读某任务的各版本「当前生效修订」视图（界面与接口共用，避免两处组装逻辑漂移） */
export async function viewVariantsOfJob(jobId: string): Promise<RewriteVariantView[]> {
  const variants = await prisma.rewriteVariant.findMany({
    where: { jobId },
    orderBy: { variantNo: 'asc' },
    include: {
      revisions: { orderBy: { revisionNo: 'desc' }, include: { segments: { orderBy: { orderIndex: 'asc' } } } },
    },
  });
  return variants.map((v) => {
    const cur = v.revisions.find((r) => r.id === v.currentRevisionId) ?? v.revisions[0];
    return {
      id: v.id,
      variantNo: v.variantNo,
      diffSummary: v.diffSummary,
      blockedReason: cur ? '' : '未生成',
      revisionId: cur?.id,
      revisionNo: cur?.revisionNo,
      revisionCount: v.revisions.length,
      charCount: cur?.charCount ?? 0,
      estimatedDurationMs: cur?.estimatedDurationMs ?? 0,
      problemFlags: cur ? safeArr(cur.problemFlags) : ['REWRITE_BLOCKED'],
      segments: (cur?.segments ?? []).map((s) => ({
        orderIndex: s.orderIndex,
        sourceSegmentId: s.sourceSegmentId,
        tag: s.tag,
        copyText: s.copyText,
        factRefs: safeArr(s.factRefs),
      })),
    };
  });
}

export type RegenerateRewriteOptions = {
  ownerId: string;
  jobId: string;
  /** 只重新生成这些版本号；不传 = 全部版本 */
  variantNos?: number[];
  /** 覆盖模型；默认沿用任务当时的模型，保证同一任务的稿件风格可比 */
  model?: string;
};

/**
 * 主动重新生成（§9）。
 * 语义：**保留旧稿** —— 对目标版本追加一条新修订并置为当前生效，历史修订仍在库中可追溯。
 * 不新增版本号（版本数的语义是「一次生成产出几篇」，不该被重新生成撑大）。
 */
export async function regenerateRewrite(
  opts: RegenerateRewriteOptions,
): Promise<GenerateRewriteResult & { regeneratedVariantNos: number[] }> {
  const job = await prisma.rewriteJob.findFirst({
    where: { id: opts.jobId, ownerId: opts.ownerId },
    include: { variants: { orderBy: { variantNo: 'asc' } } },
  });
  if (!job) throw new Error('创作任务不存在或无权访问');
  if (job.variants.length === 0) throw new Error('该任务没有可重新生成的版本');

  const wanted = (opts.variantNos ?? []).filter((n) => Number.isFinite(n));
  const targets = wanted.length ? job.variants.filter((v) => wanted.includes(v.variantNo)) : job.variants;
  if (targets.length === 0) throw new Error('指定的版本号都不属于该任务');

  const input = await rebuildInputFromSnapshot(job, targets.length);
  const adapters = getAdapters();
  const model = opts.model ?? (job.modelId || adapters.rewrite.modelId);

  const callNo = (await prisma.modelUsage.count({ where: { rewriteJobId: job.id } })) + 1;
  const startedAt = new Date();
  let out;
  try {
    out = await adapters.rewrite.rewrite({ ...input, model });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.modelUsage.create({
      data: {
        ownerType: 'REWRITE_JOB',
        rewriteJobId: job.id,
        callNo,
        capability: 'REWRITE',
        modelId: model,
        status: 'FAILED',
        retryIndex: 0,
        startedAt,
        finishedAt: new Date(),
        errorMessage: msg.slice(0, 900),
        usageMissing: true,
      },
    });
    await prisma.rewriteJob.update({
      where: { id: job.id },
      data: { status: 'PARTIAL', errorCode: 'REWRITE_REGENERATE_FAILED', errorMessage: msg.slice(0, 900) },
    });
    throw e;
  }

  const cost = estimateCost(model, out.usage.inputTokens, out.usage.outputTokens);
  await prisma.modelUsage.create({
    data: {
      ownerType: 'REWRITE_JOB',
      rewriteJobId: job.id,
      callNo,
      capability: 'REWRITE',
      modelId: model,
      status: 'SUCCEEDED',
      inputTokens: out.usage.inputTokens ?? null,
      outputTokens: out.usage.outputTokens ?? null,
      thinkingTokens: out.usage.thinkingTokens ?? null,
      estimatedCost: cost,
      usageMissing: out.usage.usageMissing === true,
      vendorRequestId: out.usage.vendorRequestId ?? null,
      priceVersion: cfg.pricing.priceVersion,
      startedAt,
      finishedAt: new Date(),
    },
  });

  const v = validateDrafts(input.refSegments, out.drafts, targets.length);
  const problems: RewriteProblem[] = [
    ...out.issues,
    ...v.problems,
    ...findDuplicateDrafts(v.drafts),
    ...checkLengthBalance(input.refSegments, v.drafts),
    // 重新生成按**当前生效**的违禁词表检查（"此刻不许出现的词"就该按最新口径算）
    ...checkBannedWordHits(v.drafts, await activeBannedEntries(opts.ownerId)),
  ];

  // 模型只保证「生成 N 篇」，不保证返回值里的 variantNo 与库内编号一致 —— 用序号映射，不信任它写的编号
  const fresh = v.drafts.filter((d) => !d.blockedReason).sort((a, b) => a.variantNo - b.variantNo);
  const regeneratedVariantNos: number[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const draft = fresh[i];
    if (!draft) {
      problems.push({
        code: 'REWRITE_REGENERATE_MISSING',
        message: `第 ${target.variantNo} 版未能重新生成（模型返回的可用稿不足），已保留原稿`,
        severity: 'warn',
        variantNo: target.variantNo,
      });
      continue;
    }
    const max = await prisma.rewriteRevision.aggregate({
      where: { variantId: target.id },
      _max: { revisionNo: true },
    });
    const rev = await prisma.rewriteRevision.create({
      data: {
        variantId: target.id,
        revisionNo: (max._max.revisionNo ?? 0) + 1,
        createdBy: 'AI',
        transcriptText: draft.transcriptText,
        charCount: draft.charCount,
        estimatedDurationMs: draft.estimatedDurationMs,
        problemFlags: JSON.stringify(draft.problemFlags),
        segments: {
          create: draft.segments.map((s) => ({
            orderIndex: s.orderIndex,
            sourceSegmentId: s.sourceSegmentId,
            tag: s.tag,
            copyText: s.copyText,
            factRefs: JSON.stringify(s.factRefs),
          })),
        },
      },
    });
    await prisma.rewriteVariant.update({
      where: { id: target.id },
      data: { currentRevisionId: rev.id, diffSummary: draft.diffSummary },
    });
    regeneratedVariantNos.push(target.variantNo);
  }

  await prisma.editorFeedback.create({
    data: {
      ownerId: opts.ownerId,
      rewriteJobId: job.id,
      kind: 'REGENERATE',
      payload: JSON.stringify({ variantNos: regeneratedVariantNos, model }),
    },
  });

  await prisma.rewriteJob.update({
    where: { id: job.id },
    data: {
      status: 'SUCCEEDED',
      stage: null,
      errorCode: null,
      errorMessage: null,
      finishedAt: new Date(),
    },
  });

  return {
    jobId: job.id,
    model,
    usageMissing: out.usage.usageMissing === true,
    inputTokens: out.usage.inputTokens,
    outputTokens: out.usage.outputTokens,
    thinkingTokens: out.usage.thinkingTokens,
    estimatedCost: cost,
    variants: await viewVariantsOfJob(job.id),
    problems,
    transcriptNotice: '',
    dryRun: false,
    regeneratedVariantNos,
  };
}

export type SaveRevisionSegmentInput = {
  orderIndex: number;
  tag: string;
  copyText: string;
};

export type SaveVariantRevisionOptions = {
  ownerId: string;
  variantId: string;
  /** 基准修订：界面打开时的当前生效修订，用于检测并发冲突 */
  baseRevisionId: string;
  segments: SaveRevisionSegmentInput[];
};

export type SaveVariantRevisionResult =
  | { ok: true; revisionId: string; revisionNo: number; charCount: number; estimatedDurationMs: number; changedSegments: number[] }
  | { ok: false; conflict: true; currentRevisionId: string | null; message: string }
  | { ok: false; conflict: false; message: string };

/**
 * 编导编辑后的显式保存（§9 + A10）。
 *
 * 允许改：段内表达。
 * 不允许改：段数、顺序、标签、参考段对应关系 —— 这些都是「严格结构」的组成部分，
 * 改了就不是同一篇结构，会破坏 A03。前端可以防，但后端必须自己再判一次。
 *
 * 乐观锁：基准修订不是当前生效修订就拒绝，**不覆盖**别人的修改。
 */
export async function saveVariantRevision(opts: SaveVariantRevisionOptions): Promise<SaveVariantRevisionResult> {
  const variant = await prisma.rewriteVariant.findFirst({
    where: { id: opts.variantId, job: { ownerId: opts.ownerId } },
  });
  if (!variant) return { ok: false, conflict: false, message: '版本不存在或无权访问' };

  if (variant.currentRevisionId !== opts.baseRevisionId) {
    return {
      ok: false,
      conflict: true,
      currentRevisionId: variant.currentRevisionId,
      message: '该版本已被其它会话修改，请刷新后再保存（未保存内容不会被覆盖）',
    };
  }

  const base = await prisma.rewriteRevision.findFirst({
    where: { id: opts.baseRevisionId, variantId: variant.id },
    include: { segments: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!base) return { ok: false, conflict: false, message: '基准修订不存在' };

  const incoming = Array.isArray(opts.segments) ? opts.segments : [];
  if (incoming.length !== base.segments.length) {
    return {
      ok: false,
      conflict: false,
      message: `段数必须与参考稿一致（应为 ${base.segments.length} 段，收到 ${incoming.length} 段）——不能增删段落`,
    };
  }

  const sorted = incoming.slice().sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
  const out: Array<{ orderIndex: number; sourceSegmentId: string | null; tag: string; copyText: string; factRefs: string[] }> = [];
  const changedSegments: number[] = [];

  for (let i = 0; i < base.segments.length; i += 1) {
    const ref = base.segments[i];
    const seg = sorted[i];
    if (Number(seg?.orderIndex) !== ref.orderIndex) {
      return { ok: false, conflict: false, message: `第 ${i + 1} 段顺序与参考稿不符（应为 ${ref.orderIndex}）——不能调整段落顺序` };
    }
    const tag = String(seg?.tag ?? '').trim();
    if (tag !== ref.tag) {
      return { ok: false, conflict: false, message: `第 ${ref.orderIndex} 段标签不能修改（参考为「${ref.tag}」）` };
    }
    const copyText = String(seg?.copyText ?? '').trim();
    if (!copyText) return { ok: false, conflict: false, message: `第 ${ref.orderIndex} 段正文不能为空` };
    if (normalizeForCompare(copyText) !== normalizeForCompare(ref.copyText)) changedSegments.push(ref.orderIndex);
    out.push({
      orderIndex: ref.orderIndex,
      sourceSegmentId: ref.sourceSegmentId,
      tag,
      copyText,
      factRefs: safeArr(ref.factRefs),
    });
  }

  if (changedSegments.length === 0) {
    return { ok: false, conflict: false, message: '内容没有变化，无需保存（未创建新修订）' };
  }

  const transcriptText = concatSegments(out);
  const charCount = transcriptText.replace(/\s+/g, '').length;

  /**
   * 命中标记必须按**新正文**重算，不能从基准修订继承。
   * 编导这次改动的很可能就是那个违禁词；继承会让"已经改好"的稿子仍然挂着命中标记 ——
   * 假警报会让人从此不再相信这个标记。
   */
  const bannedEntries = await activeBannedEntries(opts.ownerId);
  const stillHits = bannedEntries.length > 0 && out.some((s) => scanBannedWords(s.copyText, bannedEntries).length > 0);
  const flags = Array.from(
    new Set([
      ...safeArr(base.problemFlags).filter((f) => f !== 'BANNED_WORD_HIT'),
      'HUMAN_EDITED',
      ...(stillHits ? ['BANNED_WORD_HIT'] : []),
    ]),
  );

  const rev = await prisma.rewriteRevision.create({
    data: {
      variantId: variant.id,
      revisionNo: base.revisionNo + 1,
      createdBy: 'HUMAN',
      createdById: opts.ownerId,
      transcriptText,
      charCount,
      estimatedDurationMs: estimateDurationMs(charCount),
      problemFlags: JSON.stringify(flags),
      segments: {
        create: out.map((s) => ({
          orderIndex: s.orderIndex,
          sourceSegmentId: s.sourceSegmentId,
          tag: s.tag,
          copyText: s.copyText,
          factRefs: JSON.stringify(s.factRefs),
        })),
      },
    },
  });
  await prisma.rewriteVariant.update({ where: { id: variant.id }, data: { currentRevisionId: rev.id } });

  await prisma.editorFeedback.create({
    data: {
      ownerId: opts.ownerId,
      rewriteJobId: variant.jobId,
      rewriteRevisionId: rev.id,
      kind: 'EDIT',
      payload: JSON.stringify({ variantNo: variant.variantNo, baseRevisionNo: base.revisionNo, changedSegments }),
    },
  });

  return {
    ok: true,
    revisionId: rev.id,
    revisionNo: rev.revisionNo,
    charCount,
    estimatedDurationMs: rev.estimatedDurationMs,
    changedSegments,
  };
}

/** 选定一个已保存修订（§9 + A12：未选定不能提交视频）；提交文本由分段拼接，不含标签等非口播内容（A14） */
export async function selectRewriteRevision(opts: { ownerId: string; jobId: string; revisionId: string }) {
  const job = await prisma.rewriteJob.findFirst({ where: { id: opts.jobId, ownerId: opts.ownerId } });
  if (!job) throw new Error('创作任务不存在或无权访问');

  const rev = await prisma.rewriteRevision.findFirst({
    where: { id: opts.revisionId, variant: { jobId: job.id } },
    include: { variant: true, segments: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!rev) throw new Error('修订不存在或不属于该任务');
  if (rev.variant.currentRevisionId !== rev.id) {
    throw new Error('只能选定该版本当前生效的修订；请先保存编辑再选定');
  }
  if (rev.segments.length === 0) throw new Error('该修订没有正文，不能选定');

  const sel = await prisma.rewriteSelection.create({
    data: { jobId: job.id, variantId: rev.variantId, revisionId: rev.id, selectedById: opts.ownerId },
  });
  await prisma.editorFeedback.create({
    data: {
      ownerId: opts.ownerId,
      rewriteJobId: job.id,
      rewriteRevisionId: rev.id,
      kind: 'SELECT',
      payload: JSON.stringify({ variantNo: rev.variant.variantNo, revisionNo: rev.revisionNo }),
    },
  });

  return {
    id: sel.id,
    jobId: job.id,
    variantId: rev.variantId,
    variantNo: rev.variant.variantNo,
    revisionId: rev.id,
    revisionNo: rev.revisionNo,
    /** 提交给数字人平台的文本：各段正文按序拼接（A14） */
    textSnapshot: concatSegments(rev.segments),
    createdAt: sel.createdAt,
  };
}

/** 某任务当前选定的稿件（最新一次选定） */
export async function getCurrentSelection(ownerId: string, jobId: string) {
  const sel = await prisma.rewriteSelection.findFirst({
    where: { jobId, job: { ownerId } },
    orderBy: { createdAt: 'desc' },
    include: { revision: { include: { segments: { orderBy: { orderIndex: 'asc' } } } } },
  });
  if (!sel) return null;
  return {
    id: sel.id,
    variantId: sel.variantId,
    revisionId: sel.revisionId,
    createdAt: sel.createdAt,
    textSnapshot: concatSegments(sel.revision.segments),
  };
}

/** 某条视频下的创作任务列表（视频详情页用） */
/**
 * 任务列表（生成页用）。
 *
 * `stalled` 的意义：改写生成在 HTTP 请求内同步完成，若请求被中途打断（关标签页、杀进程），
 * 任务会永久停在 `RUNNING`（没有视频解析那样的断点恢复）。界面据此如实提示「可能已中断」，
 * 而不是干挂一个 `RUNNING` 让编导以为还在跑。判定阈值取模型超时 + 宽限，宁可晚一点报也不误报。
 */
export async function listRewriteJobs(ownerId: string, sourceVideoId: string) {
  const stallAfterMs = cfg.rewrite.timeoutMs + 2 * 60 * 1000;
  const jobs = await prisma.rewriteJob.findMany({
    where: { ownerId, sourceVideoId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      variants: {
        orderBy: { variantNo: 'asc' },
        include: {
          revisions: { orderBy: { revisionNo: 'desc' }, include: { segments: { orderBy: { orderIndex: 'asc' } } } },
        },
      },
      selections: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  return jobs.map((j) => {
    const sel = j.selections[0];
    return {
      id: j.id,
      status: j.status,
      stalled:
        j.status === 'RUNNING' &&
        Date.now() - (j.startedAt ?? j.createdAt).getTime() > stallAfterMs,
      platform: j.platform,
      variantCount: j.variantCount,
      modelId: j.modelId,
      ipProfileRevisionId: j.ipProfileRevisionId,
      errorCode: j.errorCode,
      errorMessage: j.errorMessage,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      variants: j.variants.map((v) => {
        const cur = v.revisions.find((r) => r.id === v.currentRevisionId) ?? v.revisions[0];
        return {
          variantNo: v.variantNo,
          revisionId: cur?.id,
          revisionNo: cur?.revisionNo,
          revisionCount: v.revisions.length,
          charCount: cur?.charCount ?? 0,
          selected: sel?.variantId === v.id && sel?.revisionId === cur?.id,
        };
      }),
    };
  });
}
