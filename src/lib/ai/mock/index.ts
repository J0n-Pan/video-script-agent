// Mock 适配器：确定性桩实现，用于在无模型凭证时跑通全链路、验收页面流程与 Excel 导出格式。
// 重要：Mock 不产生真实识别结果，所有版本都会带上 MOCK 提示问题项，避免被误当作已实现的识别能力。

import fs from 'node:fs';
import path from 'node:path';
import { MISSING, TAG, unclearAt } from '../../constants';
import type {
  AudioRecognitionAdapter,
  AudioRecognitionInput,
  AudioRecognitionOutput,
  AudioUtterance,
  OrganizeAdapter,
  OrganizeInput,
  OrganizeOutput,
  OrganizeSegmentInput,
  RewriteAdapter,
  RewriteDraft,
  RewriteInput,
  RewriteOutput,
  RewriteRefSegment,
  VisionAdapter,
  VisionFrameResult,
  VisionInput,
  VisionOutput,
} from '../types';

/**
 * 场景开关：用于验收形式判定的各分支行为（2026-09-16 收敛为 4 个形式取值后重排）。
 * 优先读取 data/mock-scenario.txt（便于在不重启解析进程的前提下切换分支），其次读 MOCK_SCENARIO 环境变量。
 * 仅 Mock 模式使用，不影响真实适配器。
 *
 * 各场景对应的形式结论：
 * - normal  0% AI      → 真人
 * - lightai AI 20%     → 真人（真人侧阈值边界，验证「含少量 AI 仍判真人」）
 * - halfai  AI 50%     → 其他（两侧阈值都不满足的中间带）
 * - aivideo AI 100%    → AI数字人
 * - pending 无法估计   → 其他（依据里注明未编造比例）
 * - mixed              → 混剪（判定逻辑不变）
 */
type Scenario = 'normal' | 'mixed' | 'aivideo' | 'lightai' | 'halfai' | 'pending' | 'noaudio';

function currentScenario(): Scenario {
  try {
    const file = path.resolve(process.cwd(), 'data', 'mock-scenario.txt');
    if (fs.existsSync(file)) {
      const v = fs.readFileSync(file, 'utf8').trim() as Scenario;
      if (v) return v;
    }
  } catch {
    // 读取失败时退回环境变量
  }
  return (process.env.MOCK_SCENARIO ?? 'normal') as Scenario;
}

/** 演示用底稿：仅为让流程可读，不是任何真实素材的识别结果 */
const SCRIPT_SENTENCES = [
  '大家好，我是教小学数学的李老师。',
  '很多家长问我，孩子背了公式还是不会做题，问题到底出在哪。',
  '其实不是记不住，是记完没有用起来。',
  '我在课上做过一个实验，同样的公式，一部分孩子只是抄写，另一部分孩子讲给我听。',
  '两周以后，讲给我听的那批孩子，做题正确率明显更高。',
  '这就是我今天想跟大家说的记忆方法：让孩子输出，而不是重复输入。',
  '第一步，学完当天，让孩子用自己的话复述一遍。',
  '第二步，隔一天，再让他讲给家长听，家长只负责提问。',
  '第三步，一周之后，把三个知识点连起来讲成一个小故事。',
  '这三步不需要额外买什么工具，每天十分钟就够。',
  '如果你也想让孩子试一试，可以在评论区留言。',
  '我会把这三步整理成一张表发给你。',
];

const MAKEUP_POOL = ['浅蓝色衬衫，黑色短发，无配饰，妆容自然', '浅蓝色衬衫，黑色短发，无配饰，妆容自然', '深灰色针织衫，长发扎起，戴细框眼镜'];
const SCENE_POOL = ['室内书房，白色书架背景，人物位于画面中央', '室内书房，白色书架背景，人物位于画面中央', '室内客厅，沙发与绿植背景，人物偏左'];

export class MockAudioAdapter implements AudioRecognitionAdapter {
  readonly modelId = 'mock-asr';
  async recognize(input: AudioRecognitionInput): Promise<AudioRecognitionOutput> {
    const duration = Math.max(1000, input.durationMs);
    if (currentScenario() === 'noaudio' || !input.hasAudio) {
      return {
        utterances: [],
        hasSpeech: false,
        issues: [
          {
            code: 'NO_SPEECH',
            message: '检测到无音轨或无有效语音，文案与旁白填“无”，不代表识别失败',
            severity: 'info',
          },
        ],
        usage: { audioSeconds: duration / 1000 },
      };
    }

    // 按语义段落切分时间轴，不机械地每句一行
    const paragraphCount = Math.max(4, Math.min(SCRIPT_SENTENCES.length, Math.ceil(duration / 12_000)));
    const per = duration / paragraphCount;
    const utterances: AudioUtterance[] = [];
    for (let i = 0; i < paragraphCount; i += 1) {
      const startMs = Math.round(i * per);
      const endMs = Math.round((i + 1) * per);
      // 保留语气词与重复，模拟「忠实原话」的输入形态
      let text = SCRIPT_SENTENCES[i % SCRIPT_SENTENCES.length];
      if (i === 1) text = `嗯，${text}`;
      if (i === 3) text = text.replace('一个实验', '一个实验，一个实验');
      const unclear = i === Math.floor(paragraphCount / 2);
      utterances.push({
        id: `u${i + 1}`,
        text: unclear ? '' : text,
        startMs,
        endMs,
        speakerId: i === paragraphCount - 1 ? 'SPK2' : 'SPK1',
        unclear,
      });
      if (i > 0 && i % 4 === 0) {
        // 主体之外的说话人 → 旁白
        utterances.push({
          id: `v${i + 1}`,
          text: '（这里插一句，很多家长忽略了这个环节）',
          startMs: startMs + 200,
          endMs: startMs + 2400,
          speakerId: 'SPK9',
        });
      }
    }

    return {
      utterances,
      hasSpeech: true,
      issues: [
        {
          code: 'MOCK_MODE',
          message: '当前为 Mock 音频适配器，转写文本为演示底稿，不是真实识别结果（配置 DASHSCOPE_API_KEY 并设 AI_MODE=dashscope 后走真实调用）',
          severity: 'warn',
        },
      ],
      usage: { audioSeconds: duration / 1000, vendorRequestId: `mock-asr-${Date.now()}` },
    };
  }
}

export class MockVisionAdapter implements VisionAdapter {
  readonly modelId = 'mock-vision';
  async analyze(input: VisionInput): Promise<VisionOutput> {
    const frames: VisionFrameResult[] = input.frames.map((f, i) => ({
      timeMs: f.timeMs,
      makeup: MAKEUP_POOL[Math.min(i, MAKEUP_POOL.length - 1)],
      scene: SCENE_POOL[Math.min(i, SCENE_POOL.length - 1)],
      emotion: i % 3 === 0 ? '语速平稳，表情放松' : i % 3 === 1 ? '语气强调，表情严肃' : '语速略快，面带微笑',
      isAiGenerated: false,
    }));

    const duration = Math.max(1000, input.durationMs);
    let formSuggestion: VisionOutput['formSuggestion'] = {
      mixedCut: false,
      aiIntervals: [],
      aiRatioEstimated: true,
      uncertain: false,
      evidence: 'Mock：取样帧覆盖时间轴，未识别到 AI 生成画面，按真人处理（演示值，非识别结论）',
    };

    if (currentScenario() === 'mixed') {
      formSuggestion = {
        mixedCut: true,
        mixedCutEvidence: 'Mock：画面中无连贯主体，多个独立素材拼接（演示值）',
        aiRatioEstimated: false,
        uncertain: false,
        evidence: 'Mock 混剪分支（用于验收 A19）',
      };
    } else if (currentScenario() === 'aivideo') {
      formSuggestion = {
        mixedCut: false,
        aiIntervals: [{ startMs: 0, endMs: duration }],
        aiRatioEstimated: true,
        uncertain: false,
        evidence: 'Mock：AI 画面区间并集占满全片（用于验收 A20 的 100% 分支）',
      };
      frames.forEach((f) => {
        f.isAiGenerated = true;
      });
    } else if (currentScenario() === 'lightai') {
      const cut = Math.round(duration * 0.2);
      formSuggestion = {
        mixedCut: false,
        aiIntervals: [{ startMs: 0, endMs: cut }],
        aiRatioEstimated: true,
        uncertain: false,
        evidence: `Mock：AI 区间约 20%，真人内容约 80%（达到真人侧阈值，应判「真人」）`,
      };
    } else if (currentScenario() === 'halfai') {
      const cut = Math.round(duration * 0.5);
      formSuggestion = {
        mixedCut: false,
        aiIntervals: [{ startMs: 0, endMs: cut }],
        aiRatioEstimated: true,
        uncertain: false,
        evidence: `Mock：AI 区间约 50%，两侧阈值都不满足（应判「其他」）`,
      };
    } else if (currentScenario() === 'pending') {
      formSuggestion = {
        mixedCut: false,
        aiRatioEstimated: false,
        uncertain: true,
        evidence: 'Mock：区间无法可靠估计，不编造比例，形式落「其他」（原「待复核」分支）',
      };
      frames.forEach((f) => {
        f.uncertain = true;
      });
    }

    return {
      frames,
      formSuggestion,
      issues: [
        {
          code: 'MOCK_MODE',
          message: '当前为 Mock 画面适配器，妆造/场景/情绪为演示值，不是真实画面理解结果',
          severity: 'warn',
        },
      ],
      usage: { inputTokens: 5000, outputTokens: 1000, vendorRequestId: `mock-vl-${Date.now()}` },
    };
  }
}

/** Mock 用的标签演示规则：按关键词粗略归类，真实归类由模型完成 */
function guessTag(text: string): string {
  const s = text ?? '';
  if (/我是|做了|从业|专注/.test(s)) return TAG.PERSONA;
  // 使用场景类内容按需求方口径归入「痛点」（「场景」标签已删除）
  if (/是不是|烦恼|困扰|总是|难|问题|早上|下班|在家|出门|上班|周末/.test(s)) return TAG.PAIN;
  if (/方法|步骤|关键|原理|教你|记住/.test(s)) return TAG.SOLUTION;
  if (/成分|材质|效果|参数|配方|专利|资质|正品/.test(s)) return TAG.MARKETING;
  if (/优惠|券|打折|领|送|立省|补贴|包邮/.test(s)) return TAG.BENEFIT;
  return TAG.OTHER;
}

export class MockOrganizeAdapter implements OrganizeAdapter {
  readonly modelId = 'mock-organize';
  async organize(input: OrganizeInput): Promise<OrganizeOutput> {
    const { utterances, visionFrames, durationMs } = input;

    // 旁白与主体语音都参与分段与打标签（新逻辑不再区分文案/旁白）
    const main = utterances.filter((u) => !u.unclear);
    const unclear = utterances.filter((u) => u.unclear);

    // 按语义段落聚合：以 4 段为目标，一段一行，不机械地每句一行
    const groupSize = Math.max(1, Math.ceil(main.length / Math.min(4, Math.max(1, main.length))));
    const segments: OrganizeSegmentInput[] = [];
    for (let i = 0; i < main.length; i += groupSize) {
      const group = main.slice(i, i + groupSize);
      if (group.length === 0) continue;
      const startMs = group[0].startMs;
      const endMs = group[group.length - 1].endMs;
      const copyText = group.map((g) => g.text).join('');
      const mid = (startMs + endMs) / 2;
      const vf = nearestFrame(visionFrames, mid);
      segments.push({
        startMs,
        endMs,
        copyText,
        tag: guessTag(copyText),
        voiceover: '',
        makeup: vf?.makeup ?? MISSING.UNRECOGNIZABLE,
        emotion: vf?.emotion ?? MISSING.PENDING_REVIEW,
        sourceUtteranceIds: group.map((g) => g.id),
      });
    }

    for (const u of unclear) {
      segments.push({
        startMs: u.startMs,
        endMs: u.endMs,
        copyText: unclearAt(u.startMs, u.endMs),
        tag: TAG.OTHER,
        voiceover: '',
        makeup: MISSING.PENDING_REVIEW,
        emotion: MISSING.PENDING_REVIEW,
        sourceUtteranceIds: [u.id],
        timeUncertain: true,
      });
    }

    segments.sort((a, b) => a.startMs - b.startMs);

    // 妆造无变化时可显示“同上”，但数据层保留可还原的完整值
    let lastMakeup = '';
    for (const s of segments) {
      if (s.makeup && s.makeup === lastMakeup) s.makeup = MISSING.SAME_AS_ABOVE;
      else lastMakeup = s.makeup;
    }

    if (segments.length === 0) {
      segments.push({
        startMs: 0,
        endMs: Math.min(durationMs, 6000),
        copyText: MISSING.NONE,
        tag: TAG.OTHER,
        voiceover: '',
        makeup: MISSING.UNRECOGNIZABLE,
        emotion: MISSING.UNRECOGNIZABLE,
        sourceUtteranceIds: [],
      });
    }

    return {
      segments,
      issues: [
        {
          code: 'MOCK_MODE',
          message: '当前为 Mock 整理适配器，段落组织为演示结果，原始转写未经过真实模型校验',
          severity: 'warn',
        },
      ],
      usage: { inputTokens: 3000, outputTokens: 1000, vendorRequestId: `mock-plus-${Date.now()}` },
    };
  }
}

function nearestFrame(frames: VisionFrameResult[], t: number): VisionFrameResult | undefined {
  let best: VisionFrameResult | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const f of frames) {
    const d = Math.abs(f.timeMs - t);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/**
 * 改写 Mock：严格按参考段结构产出多篇占位文案。
 * 用途是让「生成 → 比较 → 编辑 → 选稿 → 导出 → 数字人（Mock 适配器）」全链路可验收；
 * 文案本身没有业务价值，每稿都带 MOCK_REWRITE 问题项，避免被误当作真实生成结果。
 */
export class MockRewriteAdapter implements RewriteAdapter {
  readonly modelId = 'mock-rewrite';

  async rewrite(input: RewriteInput): Promise<RewriteOutput> {
    const count = Math.max(1, Math.min(input.variantCount, 10));
    const styles = ['稳健叙述', '先给结论再解释', '用提问开场', '以案例切入', '强调对比'];
    /**
     * 测试钩子（MOCK_BANNED_HIT=1，默认关闭）：让第 1 版第 1 段故意写进一个**真实配置的**禁用词，
     * 用来验收「生成后扫描命中 → BANNED_WORD_HIT 问题项」这条链路。
     *
     * 取词是从 `input.bannedWordsText` 里读的（而不是写死一个词），
     * 这样测的是"配置的违禁词表确实进了提示词、也确实被扫到"，而不是自说自话。
     */
    const injectWord = process.env.MOCK_BANNED_HIT === '1' ? firstBannedWord(input.bannedWordsText) : '';
    const drafts: RewriteDraft[] = [];
    for (let v = 1; v <= count; v += 1) {
      drafts.push({
        variantNo: v,
        diffSummary: `MOCK 第 ${v} 版：以「${styles[(v - 1) % styles.length]}」的方式重述同一结构`,
        segments: input.refSegments.map((ref, i) => ({
          orderIndex: ref.orderIndex,
          sourceSegmentId: ref.id,
          tag: ref.tag,
          copyText: injectWord && v === 1 && i === 0 ? `${mockRewriteText(ref, v)}${injectWord}` : mockRewriteText(ref, v),
          factRefs: [],
        })),
      });
    }
    return {
      drafts,
      issues: [
        {
          code: 'MOCK_REWRITE',
          message: '改写走 Mock 桩实现：文案为占位内容，不是真实生成结果，不可用于投放。',
          severity: 'warn' as const,
        },
      ],
      usage: {},
    };
  }
}

/** 确定性占位文案：保留参考段的字数规模，同时保证不同版本正文不同（否则会被判为无效重复） */
function mockRewriteText(ref: RewriteRefSegment, v: number): string {
  const base = (ref.copyText ?? '').replace(/\s+/g, ' ').trim();
  const head = `【MOCK 第${v}版·${ref.tag}】`;
  const tail = `（占位改写，参考段共 ${base.length} 字）`;
  return base ? head + base + tail : head + '参考段无原文，按结构占位' + tail;
}

/** 从渲染好的违禁词文本里取第一个词条（形如 `- 最好`）；取不到返回空串 */
function firstBannedWord(bannedWordsText: string): string {
  const m = /^[-•]\s*(.+)$/m.exec(bannedWordsText ?? '');
  return m ? m[1].trim() : '';
}
