import { MISSING, TAG, TAG_ORDER, unclearAt, type TagValue } from './constants';
import type { AudioUtterance, CapabilityIssue, OrganizeSegmentInput } from './ai/types';

export type Problem = {
  code: string;
  message: string;
  segmentIndex?: number;
  startMs?: number;
  endMs?: number;
  severity: 'info' | 'warn' | 'error';
};

/** 去掉标点与空白后比较，用于「只允许标点补充和语义分段」的改写判定 */
export function normalizeForCompare(s: string): string {
  return (s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？、；：""''（）《》【】…—～,.!?;:"'()<>\[\]\-]/g, '')
    .trim();
}

export type VerbatimResult = { segments: OrganizeSegmentInput[]; problems: Problem[] };

/**
 * 以原始语音片段为准，重建「不重不漏」的段落划分（2026-09-16 重写）。
 *
 * ## 为什么必须由程序保证
 *
 * 实测（2026-09-16）整理模型会给出相互重叠的引用：一条 70 秒素材里第 1 段引用了
 * 横跨 0–60 秒的整块片段，第 2~5 段又重复引用它。旧实现遇到「引用的片段已被前段占用」
 * 时会**原样保留模型自己写的文案**，于是结果是「第一段一大段文字、后面几段与它大量重合」，
 * 并且额外产出若干 REWRITTEN（改写）错误。需求方红线是「每段内容不应重复」，
 * 这不能靠提示词约束，必须由程序兜底。
 *
 * ## 规则
 *
 * 1. **一个片段只归属一段**：按段落顺序「先引用先归属」，重复引用只记问题不重复归属；
 * 2. **不丢内容**：模型没引用到的片段，按时间就近归入覆盖它的段落；
 * 3. **时间不再信模型**：段落起止由所归属片段的真实时间推导（实测模型给的时间
 *    与实际引用的片段范围能差到 15 秒以上）；
 * 4. **重复段直接丢弃**：一段若没有任何独立片段，说明其内容已全部属于其他段，
 *    整段丢弃并留痕，绝不留重复文案；
 * 5. 文案仍由原始转写逐字拼接，模型的改写一律丢弃（原文保真红线）。
 */
export function partitionSegments(
  utterances: AudioUtterance[],
  segments: OrganizeSegmentInput[],
): VerbatimResult {
  const problems: Problem[] = [];
  // 无语音（单段「无」）或模型没给出任何段落：不做划分，交由调用方按原样处理
  if (utterances.length === 0 || segments.length === 0) return { segments, problems };

  const byId = new Map(utterances.map((u) => [u.id, u]));
  const owner = new Map<string, number>();

  // 1) 先引用先归属
  segments.forEach((s, idx) => {
    const seen = new Set<string>();
    const valid = s.sourceUtteranceIds.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return byId.has(id);
    });
    const unknown = s.sourceUtteranceIds.filter((id) => !byId.has(id)).length;
    if (unknown > 0) {
      problems.push({
        code: 'UNKNOWN_UTTERANCE_REF',
        message: `第 ${idx + 1} 段引用了 ${unknown} 个不存在的原始语音片段 id，已忽略这些引用`,
        segmentIndex: idx,
        startMs: s.startMs,
        endMs: s.endMs,
        severity: 'warn',
      });
    }
    let alreadyOwned = 0;
    for (const id of valid) {
      if (owner.has(id)) {
        alreadyOwned += 1;
        continue;
      }
      owner.set(id, idx);
    }
    if (alreadyOwned > 0) {
      problems.push({
        code: 'DUPLICATE_UTTERANCE',
        message: `第 ${idx + 1} 段重复引用了已归属其他段的 ${alreadyOwned} 个原始语音片段，已按首次归属处理（不重复出现）`,
        segmentIndex: idx,
        startMs: s.startMs,
        endMs: s.endMs,
        severity: 'warn',
      });
    }
  });

  // 2) 未被任何段落引用的片段：按时间就近归入，保证不漏内容
  const orphans = utterances.filter((u) => !owner.has(u.id));
  for (const u of orphans) {
    const mid = (u.startMs + u.endMs) / 2;
    let target = segments.findIndex((s) => s.startMs <= mid && mid <= s.endMs);
    if (target < 0) {
      segments.forEach((s, i) => {
        if (s.startMs <= u.startMs) target = i;
      });
    }
    if (target < 0) target = 0;
    owner.set(u.id, target);
  }
  if (orphans.length > 0) {
    problems.push({
      code: 'UTTERANCE_ASSIGNED',
      message: `有 ${orphans.length} 个原始语音片段未被任何段落引用，已按时间归入覆盖它的段落，避免漏内容`,
      severity: 'warn',
    });
  }

  // 3) 汇总：文案与时间都以所归属的片段为准
  const buckets: AudioUtterance[][] = segments.map(() => []);
  for (const u of utterances) buckets[owner.get(u.id)!].push(u);

  const out: OrganizeSegmentInput[] = [];
  segments.forEach((s, idx) => {
    const mine = buckets[idx].sort((a, b) => a.startMs - b.startMs);
    if (mine.length === 0) {
      problems.push({
        code: 'SEGMENT_DROPPED',
        message:
          `第 ${idx + 1} 段（${s.startMs}-${s.endMs}ms）没有任何独立的原始语音片段，` +
          '内容与前面的段落完全重复，已丢弃该段，避免同一段文案重复出现',
        segmentIndex: idx,
        startMs: s.startMs,
        endMs: s.endMs,
        severity: 'warn',
      });
      return;
    }
    const text = mine.map((u) => (u.unclear ? unclearAt(u.startMs, u.endMs) : u.text)).join('');
    if (normalizeForCompare(text) !== normalizeForCompare(s.copyText)) {
      problems.push({
        code: 'TEXT_REPAIRED',
        message: `第 ${idx + 1} 段文案与引用原文不一致（模型疑似改写/补写），已按原始转写原文回填，原文一字未改`,
        segmentIndex: idx,
        startMs: s.startMs,
        endMs: s.endMs,
        severity: 'warn',
      });
    }
    out.push({
      ...s,
      startMs: mine[0].startMs,
      endMs: mine[mine.length - 1].endMs,
      copyText: text,
      sourceUtteranceIds: mine.map((u) => u.id),
    });
  });

  // 段落顺序必须与原视频一致（划分后按推导出的真实时间重排，稳定排序保持同时间段的相对次序）
  out.sort((a, b) => a.startMs - b.startMs);
  return { segments: out, problems };
}

/**
 * 原文保真校验（PRD 10.5 / A35）：
 * 校验整理阶段的漏段、重复和非允许改写；不把说话人编号自动当主体身份。
 * 位于 enforceVerbatimTranscript 之后，作为兜底安全网（回填后理应无 REWRITTEN）。
 */
export function checkTranscriptFidelity(
  utterances: AudioUtterance[],
  segments: OrganizeSegmentInput[],
): Problem[] {
  const problems: Problem[] = [];
  const usable = utterances.filter((u) => !u.unclear && u.text.trim() !== '');
  const referenced = new Map<string, number>();
  const addRef = (id: string) => referenced.set(id, (referenced.get(id) ?? 0) + 1);
  for (const s of segments) {
    for (const id of s.sourceUtteranceIds) addRef(id);
    for (const id of s.sourceVoiceoverIds ?? []) addRef(id);
  }

  // 漏段
  for (const u of usable) {
    if (!referenced.has(u.id)) {
      problems.push({
        code: 'MISSING_UTTERANCE',
        message: `原始语音片段 ${u.id} 未被任何段落引用（疑似漏段），原文保留在原始转写中`,
        startMs: u.startMs,
        endMs: u.endMs,
        severity: 'error',
      });
    }
  }

  // 重复引用
  for (const [id, n] of referenced.entries()) {
    if (n > 1) {
      const u = utterances.find((x) => x.id === id);
      problems.push({
        code: 'DUPLICATE_UTTERANCE',
        message: `原始语音片段 ${id} 被引用 ${n} 次（疑似重复）`,
        startMs: u?.startMs,
        endMs: u?.endMs,
        severity: 'warn',
      });
    }
  }

  // 非允许改写：文案与引用原文比对（旁白已并入标签列，不再单独比对）
  segments.forEach((s, idx) => {
    if (!s.copyText.startsWith(MISSING.UNCLEAR_PREFIX)) {
      const src = utterances
        .filter((u) => s.sourceUtteranceIds.includes(u.id))
        .map((u) => u.text)
        .join('');
      if (src && normalizeForCompare(src) !== normalizeForCompare(s.copyText)) {
        problems.push({
          code: 'REWRITTEN',
          message: `第 ${idx + 1} 段文案与引用原文不一致（疑似改写/补写），已保留原始转写供人工核对`,
          segmentIndex: idx,
          startMs: s.startMs,
          endMs: s.endMs,
          severity: 'error',
        });
      }
    }

    // 标签：每段必须且只能有一个合法标签，缺失或越界按「其他」落库并留痕
    if (!TAG_ORDER.includes(s.tag as TagValue)) {
      problems.push({
        code: 'TAG_INVALID',
        message: `第 ${idx + 1} 段的标签「${s.tag || '空'}」不在六类之内，已归入「${TAG.OTHER}」，请人工确认（「场景」标签已删除，原场景类内容归入「${TAG.PAIN}」）`,
        segmentIndex: idx,
        startMs: s.startMs,
        endMs: s.endMs,
        severity: 'warn',
      });
    }
  });

  return problems;
}

/** 字段与时间校验：0 ≤ 开始 < 结束 ≤ 总时长；顺序保持原视频先后 */
export function validateSegments(segments: OrganizeSegmentInput[], durationMs: number): Problem[] {
  const problems: Problem[] = [];
  segments.forEach((s, i) => {
    if (s.startMs < 0) {
      problems.push({ code: 'TIME_NEGATIVE', message: `第 ${i + 1} 段开始时间为负值`, segmentIndex: i, severity: 'error' });
    }
    if (s.endMs <= s.startMs) {
      problems.push({
        code: 'TIME_ORDER',
        message: `第 ${i + 1} 段结束时间不大于开始时间，已标记时间待复核`,
        segmentIndex: i,
        severity: 'error',
      });
    }
    if (s.endMs > durationMs) {
      problems.push({
        code: 'TIME_EXCEED',
        message: `第 ${i + 1} 段结束时间超出视频总时长`,
        segmentIndex: i,
        severity: 'error',
      });
    }
    if (!s.copyText) {
      problems.push({
        code: 'EMPTY_CONTENT',
        message: `第 ${i + 1} 段文案为空，无法区分漏填与确认无内容`,
        segmentIndex: i,
        severity: 'warn',
      });
    }
    if (i > 0 && s.startMs < segments[i - 1].startMs) {
      problems.push({
        code: 'ORDER_BROKEN',
        message: `第 ${i + 1} 段开始时间早于上一段，段落顺序与原视频不一致`,
        segmentIndex: i,
        severity: 'warn',
      });
    }
  });
  return problems;
}

/** 修正越界时间，避免把无效数据写入版本 */
export function clampSegments(segments: OrganizeSegmentInput[], durationMs: number): OrganizeSegmentInput[] {
  return segments.map((s, i) => {
    const startMs = Math.max(0, Math.min(s.startMs, durationMs));
    let endMs = Math.max(0, Math.min(s.endMs, durationMs));
    if (endMs <= startMs) endMs = Math.min(durationMs, startMs + 1000);
    return { ...s, startMs, endMs, sourceUtteranceIds: s.sourceUtteranceIds, timeUncertain: s.timeUncertain || endMs <= startMs };
  });
}

export function mergeProblems(a: Problem[], b: CapabilityIssue[]): Problem[] {
  return [
    ...a,
    ...b.map((i) => ({
      code: i.code,
      message: i.message,
      startMs: i.startMs,
      endMs: i.endMs,
      severity: i.severity,
    })),
  ];
}

/** 问题标记只保存摘要，避免把模型原始返回整段写入业务库 */
export function problemSummary(problems: Problem[]) {
  const byCode = new Map<string, number>();
  for (const p of problems) byCode.set(p.code, (byCode.get(p.code) ?? 0) + 1);
  return Array.from(byCode.entries()).map(([code, count]) => ({ code, count }));
}
