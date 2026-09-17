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

export type AiAdapters = {
  mode: 'mock' | 'dashscope';
  audio: AudioRecognitionAdapter;
  vision: VisionAdapter;
  organize: OrganizeAdapter;
};
