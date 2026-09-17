import { cfg } from './config';
import { FORM, FORM_LABEL } from './constants';
import type { VisionOutput } from './ai/types';

export type ClassificationResult = {
  category: string;
  categoryLabel: string;
  aiUnionMs: number;
  aiRatio: number;
  ratioEstimated: boolean;
  uncertain: boolean;
  evidence: string;
};

/**
 * 取模型的依据说明，缺失时用兜底文案。
 * 用 `||` 而非 `??`：模型可能返回空字符串，`??` 只在 null/undefined 时回退，
 * 会让界面上的「依据」变成空白，看不出形式是怎么判出来的。
 */
function evidenceOr(modelEvidence: string | undefined | null, fallback: string): string {
  const v = (modelEvidence ?? '').trim();
  return v || fallback;
}

/** 区间并集：重叠区间不重复累加（PRD 4.2） */
export function unionMs(intervals: Array<{ startMs: number; endMs: number }>, durationMs: number): number {
  const iv = intervals
    .map((i) => ({ s: Math.max(0, Math.min(i.startMs, durationMs)), e: Math.max(0, Math.min(i.endMs, durationMs)) }))
    .filter((i) => i.e > i.s)
    .sort((a, b) => a.s - b.s);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const i of iv) {
    if (curStart < 0) {
      curStart = i.s;
      curEnd = i.e;
    } else if (i.s <= curEnd) {
      curEnd = Math.max(curEnd, i.e);
    } else {
      total += curEnd - curStart;
      curStart = i.s;
      curEnd = i.e;
    }
  }
  if (curStart >= 0) total += curEnd - curStart;
  return total;
}

/**
 * 形式判断（2026-09-16 需求方口径，取值收敛为 4 项）。
 *
 * 优先顺序：
 *  1. 混剪 —— 判定逻辑不变；同一主体的跳切或机位变化不能仅凭切镜次数判为混剪。
 *  2. AI 画面时长占比 ≥ 75% → 「AI数字人」。
 *  3. 真人内容占比 ≥ 75%（即 AI 占比 ≤ 25%）→ 「真人」。
 *  4. 其余（25%~75% 的中间带、模型无法可靠估计）→ 「其他」。
 *
 * 原「有ai片段」「真人口播」「真人访谈」「待复核」四个取值已取消，一并归入「其他」，
 * 原「待复核」语义改为：形式落「其他」，但依据里写明是模型无法可靠估计，
 * 让编导仍能识别出需要复看的那几条。
 */
export function classify(input: {
  durationMs: number;
  vision: VisionOutput['formSuggestion'];
  /** 无法可靠估计 AI 区间时置 true，不编造精确百分比 */
  ratioUnreliable?: boolean;
}): ClassificationResult {
  const duration = Math.max(1, input.durationMs);
  const v = input.vision;

  if (v.mixedCut === true) {
    return {
      category: FORM.MIXED_CUT,
      categoryLabel: FORM_LABEL[FORM.MIXED_CUT],
      aiUnionMs: 0,
      aiRatio: 0,
      ratioEstimated: false,
      uncertain: false,
      evidence: evidenceOr(v.mixedCutEvidence, '无连贯主体，由多个独立素材拼接'),
    };
  }

  const aiUnion = unionMs(v.aiIntervals ?? [], duration);
  const ratio = aiUnion / duration;
  const estimated = v.aiRatioEstimated !== false && !input.ratioUnreliable;
  const reliable = estimated && v.uncertain !== true;

  // 模型无法给出可靠估计：不编造比例，形式落「其他」并在依据里说明原因。
  if (!reliable) {
    return {
      category: FORM.OTHER,
      categoryLabel: FORM_LABEL[FORM.OTHER],
      aiUnionMs: aiUnion,
      aiRatio: ratio,
      ratioEstimated: false,
      uncertain: true,
      evidence: evidenceOr(v.evidence, '模型无法可靠估计 AI 画面区间，已按「其他」处理，不编造精确比例'),
    };
  }

  const pct = (ratio * 100).toFixed(1);

  if (ratio >= cfg.aiVideoRatioThreshold) {
    return {
      category: FORM.AI_AVATAR,
      categoryLabel: FORM_LABEL[FORM.AI_AVATAR],
      aiUnionMs: aiUnion,
      aiRatio: ratio,
      ratioEstimated: true,
      uncertain: false,
      evidence: evidenceOr(
        v.evidence,
        `AI 画面区间并集占比 ${pct}%，达到阈值 ${cfg.aiVideoRatioThreshold * 100}%`,
      ),
    };
  }

  const realRatio = 1 - ratio;
  if (realRatio >= cfg.realPersonRatioThreshold) {
    return {
      category: FORM.REAL_PERSON,
      categoryLabel: FORM_LABEL[FORM.REAL_PERSON],
      aiUnionMs: aiUnion,
      aiRatio: ratio,
      ratioEstimated: true,
      uncertain: false,
      evidence: evidenceOr(
        v.evidence,
        `真人内容占比 ${(realRatio * 100).toFixed(1)}%，达到阈值 ${cfg.realPersonRatioThreshold * 100}%` +
          (ratio > 0 ? `（AI 画面占比 ${pct}%，低于 AI 侧阈值）` : '（未识别到 AI 画面）'),
      ),
    };
  }

  return {
    category: FORM.OTHER,
    categoryLabel: FORM_LABEL[FORM.OTHER],
    aiUnionMs: aiUnion,
    aiRatio: ratio,
    ratioEstimated: true,
    uncertain: false,
    evidence: evidenceOr(
      v.evidence,
      `AI 画面占比 ${pct}%，既未达 AI 侧阈值 ${cfg.aiVideoRatioThreshold * 100}%，` +
        `也未达真人侧阈值 ${cfg.realPersonRatioThreshold * 100}%，按「其他」处理`,
    ),
  };
}

/** 混剪是否停止完整解析 */
export function isMixedCut(category: string) {
  return category === FORM.MIXED_CUT;
}
