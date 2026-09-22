// 改写稿的结构契约校验（2026-09-20 需求迭代 §5.4）。
//
// 这里的每一个检查都是**结构计数类**的，可以自动断言，所以必须有：
// 「结构计数通过 ≠ 语义合格」——语义层面（第一人称、事实引用、隐性新增引流）不在本文件，
// 由编导复核承担；本文件只保证不把明显破坏严格结构的稿子写进库。

import { TAG_ORDER } from '../constants';
import { scanBannedWords, type BannedWordEntry } from './banned';
import type { RewriteDraft, RewriteDraftSegment, RewriteRefSegment } from '../ai/types';

export type RewriteProblem = {
  code: string;
  message: string;
  severity: 'info' | 'warn' | 'error';
  variantNo?: number;
  orderIndex?: number;
};

export type ValidatedSegment = {
  orderIndex: number;
  sourceSegmentId: string | null;
  tag: string;
  copyText: string;
  factRefs: string[];
};

export type ValidatedDraft = {
  variantNo: number;
  diffSummary: string;
  segments: ValidatedSegment[];
  /** 正文快照：各段按 orderIndex 拼接 */
  transcriptText: string;
  charCount: number;
  estimatedDurationMs: number;
  /** 模型明确说明无法生成时的原因；非空时该稿不接受入库 */
  blockedReason: string;
  problemFlags: string[];
};

/** 中文口播语速估算（字/秒）：用于「预计口播时长」，界面须标明是估算值 */
export const SPEECH_CHARS_PER_SECOND = 4.8;

/** 估算口播时长（毫秒）。明确是估算，成品实际时长以取回的媒体为准。 */
export function estimateDurationMs(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.round((charCount / SPEECH_CHARS_PER_SECOND) * 1000);
}

/** 比较用归一化：去掉空白与常见标点，避免「补标点」被误判成不一致 */
export function normalizeForCompare(text: string): string {
  return (text ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。、！？；：""''“”‘’（）()《》〈〉【】…—－\-·,.!?;:"'`~]/g, '');
}

/** 各段文案按 orderIndex 拼接 = 整段正文（这条同时证明不重不漏） */
export function concatSegments(segments: Array<{ orderIndex: number; copyText: string }>): string {
  return segments
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((s) => s.copyText)
    .join('');
}

/**
 * 整段文案与分段是否一致（§5.3）。
 * 有实质差异时界面提示「整段文案与分段不一致，本次使用分段版本」，
 * 该提示**不能自动修改源数据**。
 */
export function checkTranscriptConsistency(transcriptText: string, segments: Array<{ orderIndex: number; copyText: string }>): {
  consistent: boolean;
  message: string;
} {
  const a = normalizeForCompare(transcriptText ?? '');
  const b = normalizeForCompare(concatSegments(segments));
  if (!a && !b) return { consistent: true, message: '' };
  if (a === b) return { consistent: true, message: '' };
  return { consistent: false, message: '整段文案与分段不一致，本次使用分段版本' };
}

function isTag(v: string): boolean {
  return (TAG_ORDER as readonly string[]).includes(v);
}

/**
 * 标签归一化：只抹平**全角/半角括号与空白**的书写差异，不做任何同义替换。
 *
 * 为什么需要：实测中 qwen3.7-flash 把「干货（解决方案）」写成「干货（解决方案)」（结尾半角括号），
 * 段数、顺序、来源段都对，只差一个括号形态。这是模型输出的字符形态漂移，不是结构违规；
 * 若按「标签不一致」把整稿丢弃，编导会白丢一个可用版本，而对业务毫无意义。
 * 归一化后一致就按参考段的**规范标签**入库，并留一条 info 问题项，做到修正但不静默。
 */
function normTag(v: string): string {
  return String(v ?? '')
    .replace(/\s+/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')');
}

/**
 * 校验模型返回的候选稿。返回「可入库的稿 + 问题清单」。
 * 规则：结构不合法的**整稿丢弃**（不修补），因为严格结构是需求红线，
 * 静默修补会让编导看到与参考结构不符的稿件却以为是模型按结构生成的。
 */
export function validateDrafts(
  refs: RewriteRefSegment[],
  drafts: RewriteDraft[],
  expectedCount: number,
): { drafts: ValidatedDraft[]; problems: RewriteProblem[] } {
  const problems: RewriteProblem[] = [];
  const accepted: ValidatedDraft[] = [];
  const refIds = refs.map((r) => r.id);
  const seenVariantNos = new Set<number>();

  if (!Array.isArray(drafts) || drafts.length === 0) {
    problems.push({ code: 'REWRITE_NO_DRAFT', message: '模型未返回任何候选稿', severity: 'error' });
    return { drafts: [], problems };
  }
  if (drafts.length !== expectedCount) {
    problems.push({
      code: 'REWRITE_VARIANT_COUNT_MISMATCH',
      message: `要求生成 ${expectedCount} 篇，实际返回 ${drafts.length} 篇`,
      severity: 'warn',
    });
  }

  for (const d of drafts) {
    const variantNo = Number(d?.variantNo);
    const flags: string[] = [];
    const fail = (code: string, message: string) => {
      problems.push({ code, message, severity: 'error', variantNo });
      flags.push(code);
    };

    if (!Number.isFinite(variantNo) || variantNo <= 0) {
      problems.push({ code: 'REWRITE_BAD_VARIANT_NO', message: `版本序号非法：${d?.variantNo}`, severity: 'error' });
      continue;
    }
    if (seenVariantNos.has(variantNo)) {
      problems.push({ code: 'REWRITE_DUPLICATE_VARIANT_NO', message: `版本序号重复：${variantNo}`, severity: 'error' });
      continue;
    }
    seenVariantNos.add(variantNo);

    const blockedReason = typeof d?.blockedReason === 'string' ? d.blockedReason.trim() : '';
    if (blockedReason) {
      problems.push({
        code: 'REWRITE_BLOCKED',
        message: `第 ${variantNo} 篇未生成：${blockedReason}`,
        severity: 'warn',
        variantNo,
      });
      accepted.push({
        variantNo,
        diffSummary: String(d.diffSummary ?? ''),
        segments: [],
        transcriptText: '',
        charCount: 0,
        estimatedDurationMs: 0,
        blockedReason,
        problemFlags: ['REWRITE_BLOCKED'],
      });
      continue;
    }

    const segs: RewriteDraftSegment[] = Array.isArray(d?.segments) ? d.segments : [];
    if (segs.length !== refs.length) {
      fail(
        'REWRITE_SEGMENT_COUNT_MISMATCH',
        `第 ${variantNo} 篇段数为 ${segs.length}，参考段数为 ${refs.length}（严格结构要求一一对应）`,
      );
      continue;
    }

    const sorted = segs.slice().sort((a, b) => Number(a.orderIndex) - Number(b.orderIndex));
    const usedIds: string[] = [];
    const out: ValidatedSegment[] = [];
    let ok = true;

    for (let i = 0; i < refs.length; i += 1) {
      const ref = refs[i];
      const seg = sorted[i];
      const orderIndex = Number(seg?.orderIndex);
      if (orderIndex !== ref.orderIndex) {
        fail('REWRITE_ORDER_MISMATCH', `第 ${variantNo} 篇第 ${i + 1} 段顺序不符：期望 ${ref.orderIndex}，实际 ${seg?.orderIndex}`);
        ok = false;
        break;
      }
      const sid = seg?.sourceSegmentId == null ? null : String(seg.sourceSegmentId);
      if (!sid || !refIds.includes(sid)) {
        fail('REWRITE_SOURCE_REF_INVALID', `第 ${variantNo} 篇第 ${orderIndex} 段引用了不存在的参考段 id：${sid ?? '(空)'}`);
        ok = false;
        break;
      }
      if (usedIds.includes(sid)) {
        fail('REWRITE_SOURCE_REF_DUPLICATE', `第 ${variantNo} 篇重复引用同一参考段：${sid}`);
        ok = false;
        break;
      }
      usedIds.push(sid);
      if (sid !== ref.id) {
        fail('REWRITE_SOURCE_REF_MISMATCH', `第 ${variantNo} 篇第 ${orderIndex} 段应对应参考段 ${ref.id}，实际 ${sid}`);
        ok = false;
        break;
      }

      let tag = String(seg?.tag ?? '').trim();
      if (!isTag(tag)) {
        const matched = (TAG_ORDER as readonly string[]).find((t) => normTag(t) === normTag(tag));
        if (!matched) {
          fail(
            'REWRITE_TAG_INVALID',
            `第 ${variantNo} 篇第 ${orderIndex} 段标签非法：${tag || '(空)'}；只能取 ${TAG_ORDER.join(' / ')}`,
          );
          ok = false;
          break;
        }
        flags.push('REWRITE_TAG_NORMALIZED');
        problems.push({
          code: 'REWRITE_TAG_NORMALIZED',
          message: `第 ${variantNo} 篇第 ${orderIndex} 段标签「${tag}」按参考段规范化为「${matched}」（仅全/半角括号差异）`,
          severity: 'info',
          variantNo,
          orderIndex,
        });
        tag = matched;
      }
      if (tag !== ref.tag) {
        // 标签是结构的一部分：改了就是改了结构（A03 要求标签一致）
        fail('REWRITE_TAG_MISMATCH', `第 ${variantNo} 篇第 ${orderIndex} 段标签与参考段不一致：参考 ${ref.tag}，实际 ${tag}`);
        ok = false;
        break;
      }

      const copyText = String(seg?.copyText ?? '').trim();
      if (!copyText) {
        fail('REWRITE_EMPTY_TEXT', `第 ${variantNo} 篇第 ${orderIndex} 段正文为空`);
        ok = false;
        break;
      }

      out.push({
        orderIndex,
        sourceSegmentId: sid,
        tag,
        copyText,
        factRefs: Array.isArray(seg?.factRefs) ? seg.factRefs.map(String).filter(Boolean) : [],
      });
    }

    if (!ok) continue;

    const transcriptText = concatSegments(out);
    const charCount = transcriptText.replace(/\s+/g, '').length;
    accepted.push({
      variantNo,
      diffSummary: String(d?.diffSummary ?? '').trim(),
      segments: out,
      transcriptText,
      charCount,
      estimatedDurationMs: estimateDurationMs(charCount),
      blockedReason: '',
      problemFlags: flags,
    });
  }

  accepted.sort((a, b) => a.variantNo - b.variantNo);
  return { drafts: accepted, problems };
}

/**
 * 每段长度与参考段的偏离检查（**只提示，不拒绝**）。
 *
 * 为什么需要：生成稿要直接交给数字人口播，某一段明显超长或过短会让成片节奏跑偏。
 * 实测中 flash 系列会把 483 字的参考稿写成 700~940 字，整体膨胀到 1.5~2 倍；
 * 结构计数完全合法，光看「段数对、标签对」发现不了。用 warn 指出具体是哪一段，
 * 让编导复核，而不是整稿静默通过、也不是直接判废。
 */
export function checkLengthBalance(refs: RewriteRefSegment[], drafts: ValidatedDraft[]): RewriteProblem[] {
  const problems: RewriteProblem[] = [];
  const refChars = new Map(refs.map((r) => [r.id, (r.copyText ?? '').replace(/\s+/g, '').length]));

  for (const d of drafts) {
    if (d.blockedReason) continue;
    for (const s of d.segments) {
      const base = s.sourceSegmentId ? refChars.get(s.sourceSegmentId) ?? 0 : 0;
      // 参考段本身极短（口号、音标串、单词朗读）时比例没有意义，不做判断
      if (base < 8) continue;
      const cur = s.copyText.replace(/\s+/g, '').length;
      const ratio = cur / base;
      if (ratio > 1.8 || ratio < 0.5) {
        problems.push({
          code: 'REWRITE_SEGMENT_LENGTH_OFF',
          message: `第 ${d.variantNo} 篇第 ${s.orderIndex} 段 ${cur} 字，参考段 ${base} 字（${ratio.toFixed(2)} 倍），请复核是否偏离该段原作用`,
          severity: 'warn',
          variantNo: d.variantNo,
          orderIndex: s.orderIndex,
        });
      }
    }
  }
  return problems;
}

/**
 * 违禁词命中检查（**只提示，不拒绝**，2026-09-22 第七轮需求）。
 *
 * 为什么必须有这一道：提示词里写了「绝对不能出现」，但提示词不是保证
 * （本项目已有先例：profile.ts 的 stripPromptEcho 就是为"模型不照做"加的兜底）。
 * 违禁词属于合规红线，光靠模型自觉不行，必须由程序在落库前扫一遍。
 *
 * 为什么只 warn 不 error：违禁词一定有误报 ——
 * 禁的是「最好」，文案里出现「最好的自己」算命中，但未必都要改。
 * 整稿丢弃的代价（编导白丢一个可用版本 + 重新生成再花一次钱）远大于漏报一条提示，
 * 所以这里只标记具体是哪一段、命中了哪些词，由编导判断。
 */
export function checkBannedWordHits(
  drafts: ValidatedDraft[],
  entries: BannedWordEntry[],
): RewriteProblem[] {
  if (entries.length === 0) return [];
  const problems: RewriteProblem[] = [];

  for (const d of drafts) {
    if (d.blockedReason) continue;
    for (const s of d.segments) {
      const hits = scanBannedWords(s.copyText, entries);
      if (hits.length === 0) continue;
      // 同一个词在某段里出现多次只报一次；不同词都列出来，便于编导一次改完
      const words = Array.from(new Set(hits.map((h) => h.word)));
      problems.push({
        code: 'BANNED_WORD_HIT',
        message:
          `第 ${d.variantNo} 篇第 ${s.orderIndex} 段出现禁用表达：${words.join('、')}` +
          `（共 ${hits.length} 处）。请改写该段；若确认是误报可以不改，但该标记不会自动消失。`,
        severity: 'warn',
        variantNo: d.variantNo,
        orderIndex: s.orderIndex,
      });
      if (!d.problemFlags.includes('BANNED_WORD_HIT')) d.problemFlags.push('BANNED_WORD_HIT');
    }
  }
  return problems;
}

/**
 * 生成版本的去重检查（A07）：多版本必须靠表达差异，不得靠改结构。
 * 两稿的段数/标签序列完全相同才算「结构一致」；正文逐字相同则视为无效重复。
 */
export function findDuplicateDrafts(drafts: ValidatedDraft[]): RewriteProblem[] {
  const problems: RewriteProblem[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    for (let j = i + 1; j < drafts.length; j += 1) {
      const a = drafts[i];
      const b = drafts[j];
      if (a.blockedReason || b.blockedReason) continue;
      if (normalizeForCompare(a.transcriptText) === normalizeForCompare(b.transcriptText)) {
        problems.push({
          code: 'REWRITE_DUPLICATE_CONTENT',
          message: `第 ${a.variantNo} 篇与第 ${b.variantNo} 篇正文完全相同，不构成有效多版本`,
          severity: 'warn',
          variantNo: a.variantNo,
        });
      }
    }
  }
  return problems;
}
