// 三类能力的稳定内部输入输出结构（PRD 10.6 实现约定）
// 供应商原始格式、上传、轮询、错误码由各自适配器处理；业务层不依赖供应商返回结构。

export type Usage = {
  audioSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  vendorRequestId?: string;
  /** 供应商未返回用量时置 true → 记录为「费用待核对」，不能当免费 */
  usageMissing?: boolean;
};

export type CapabilityIssue = {
  code: string;
  message: string;
  startMs?: number;
  endMs?: number;
  severity: 'info' | 'warn' | 'error';
};

/** 音频识别（qwen3-asr-flash-filetrans）：原文片段 + 起止毫秒 + 可用说话人 + 问题 + 用量 */
export type AudioUtterance = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  /** 供应商可用说话人标识；不自动等同主体或旁白（PRD 10.6） */
  speakerId?: string;
  unclear?: boolean;
};

export type AudioRecognitionInput = {
  audioPath: string;
  durationMs: number;
  language: 'zh' | 'zh-cmn';
  hasAudio: boolean;
};

export type AudioRecognitionOutput = {
  utterances: AudioUtterance[];
  hasSpeech: boolean;
  issues: CapabilityIssue[];
  usage: Usage;
};

/** 画面理解（qwen3-vl-plus）：带时间的描述 + 分类建议 + 依据 + 用量 */
export type VisionFrameInput = {
  path: string;
  timeMs: number;
};

export type VisionFrameResult = {
  timeMs: number;
  makeup: string;
  scene: string;
  emotion: string;
  /** 该取样帧所属画面是否为 AI 生成画面；无法判断时不填，由 uncertain 标记 */
  isAiGenerated?: boolean;
  uncertain?: boolean;
  notes?: string;
};

export type VisionInput = {
  durationMs: number;
  frames: VisionFrameInput[];
};

export type AiInterval = { startMs: number; endMs: number };

export type VisionOutput = {
  frames: VisionFrameResult[];
  /** 形式建议（含混剪判定与 AI 区间依据） */
  formSuggestion: {
    mixedCut?: boolean;
    mixedCutEvidence?: string;
    aiIntervals?: AiInterval[];
    aiRatioEstimated?: boolean;
    uncertain?: boolean;
    evidence?: string;
  };
  issues: CapabilityIssue[];
  usage: Usage;
};

/** 脚本整理（qwen3.8-flash 非思考模式）：分段 + 唯一标签 + 原样文本 */
export type OrganizeSegmentInput = {
  startMs: number;
  endMs: number;
  /** 该段转写原文，一字不改（旁白已并入，不再区分文案/旁白） */
  copyText: string;
  /** 唯一标签：人设 / 痛点 / 干货（解决方案）/ 营销内容（产品介绍）/ 福利 / 其他 */
  tag: string;
  /** 已废弃：旁白并入标签列后不再单独输出，保留字段兼容历史版本 */
  voiceover: string;
  makeup: string;
  emotion: string;
  /** 引用的原始语音片段 ID，用于漏段/重复/改写校验（PRD 10.5） */
  sourceUtteranceIds: string[];
  /** 旁白字段引用的原始语音片段 ID（历史字段，新版本不再使用） */
  sourceVoiceoverIds?: string[];
  timeUncertain?: boolean;
};

export type OrganizeInput = {
  durationMs: number;
  utterances: AudioUtterance[];
  visionFrames: VisionFrameResult[];
  form: { category: string; categoryLabel: string; evidence: string };
  rules: string;
};

export type OrganizeOutput = {
  segments: OrganizeSegmentInput[];
  issues: CapabilityIssue[];
  usage: Usage;
};

export interface AudioRecognitionAdapter {
  readonly modelId: string;
  recognize(input: AudioRecognitionInput): Promise<AudioRecognitionOutput>;
}

export interface VisionAdapter {
  readonly modelId: string;
  analyze(input: VisionInput): Promise<VisionOutput>;
}

export interface OrganizeAdapter {
  readonly modelId: string;
  organize(input: OrganizeInput): Promise<OrganizeOutput>;
}

// ---------------------------------------------------------------------------
// 个性化文案改写（2026-09-20 需求迭代）：结构严格一对一的改写稿生成
// ---------------------------------------------------------------------------

/** 参考段：来自选定保存版本，按 orderIndex 升序，是本次生成的**结构基准** */
export type RewriteRefSegment = {
  id: string;
  orderIndex: number;
  tag: string;
  copyText: string;
};

/** IP 资料包的一条可引用事实：id 供 RewriteSegment.factRefs 追溯 */
export type IpFact = {
  id: string;
  /** 所属板块：personal 人设 / credentials 资质 / method 方法 / cases 案例 / audience 受众 / offer 课程权益 */
  section: string;
  text: string;
};

export type RewriteInput = {
  platform: string;
  platformLabel: string;
  variantCount: number;
  refSegments: RewriteRefSegment[];
  /** 结构化资料包渲染成的文本（含 fact id），模型只能引用其中事实 */
  ipProfileText: string;
  ipProfileVersion: number;
  /**
   * 违禁词资料包渲染成的文本（「改写稿绝对不能出现」的词/表达）。
   * 空字符串 = 没有配置或该版本为空，此时提示词里整块不出现。
   */
  bannedWordsText: string;
  /** 生效的违禁词包版本号；无包时为 null（只用于界面显示与追溯） */
  bannedPackVersion: number | null;
  /** 参考视频的分析摘要（人群/创意标签等），可空字符串 */
  videoInsightText: string;
  formLabel: string;
  durationMs: number | null;
  /** 严格结构规则全文（程序与提示词同源，见 lib/rewrite/rules.ts） */
  rules: string;
  /**
   * 本次调用使用的模型；不传则用 REWRITE_MODEL。
   * 存在的意义是横向实测：同一个适配器要能跑不同模型，比较才成立。
   */
  model?: string;
};

export type RewriteDraftSegment = {
  orderIndex: number;
  /** 一对一对应的参考段 id；必须与参考段一一对应 */
  sourceSegmentId: string | null;
  tag: string;
  copyText: string;
  /** 引用的资料事实 id 列表（可空）；有助追溯但不等于断言真实 */
  factRefs: string[];
};

export type RewriteDraft = {
  variantNo: number;
  /** 一行差异说明：本稿与其他版本的表达差异 */
  diffSummary: string;
  segments: RewriteDraftSegment[];
  /** 模型明确拒绝生成时的原因（素材不足 / 结构不适配），此时 segments 为空 */
  blockedReason?: string;
};

export type RewriteOutput = {
  drafts: RewriteDraft[];
  issues: CapabilityIssue[];
  usage: Usage;
};

export interface RewriteAdapter {
  readonly modelId: string;
  rewrite(input: RewriteInput): Promise<RewriteOutput>;
}

export type AiAdapters = {
  mode: 'mock' | 'dashscope';
  audio: AudioRecognitionAdapter;
  vision: VisionAdapter;
  organize: OrganizeAdapter;
  rewrite: RewriteAdapter;
};
