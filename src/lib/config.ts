import path from 'node:path';
import fs from 'node:fs';
import { loadDotEnv } from './load-env';

// 必须在读取任何 process.env 之前执行：Next.js 会自动加载 .env，独立进程不会。
loadDotEnv();

function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

const projectRoot = process.cwd();

/** 首版支持的容器/音频格式（可配置限制的具体数值待技术验证后公布，PRD 3.4） */
const ALLOWED_EXTENSIONS: string[] = [
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
  '.avi',
  '.flv',
  '.wmv',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
];

/**
 * 百炼服务地址按区域区分（PRD 10.5）：中国站与新加坡站域名不同，密钥不通用。
 * 密钥所属区域必须与业务空间区域一致，否则会返回 InvalidApiKey / 模型不存在。
 */
const DASHSCOPE_HOSTS: Record<string, string> = {
  beijing: 'https://dashscope.aliyuncs.com',
  singapore: 'https://dashscope-intl.aliyuncs.com',
};

/** 实时语音识别的 WebSocket 地址，与 HTTP 域名同区域 */
const DASHSCOPE_WS_HOSTS: Record<string, string> = {
  beijing: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  singapore: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference',
};

function dashscopeHost(region: string): string {
  return DASHSCOPE_HOSTS[region] ?? DASHSCOPE_HOSTS.beijing;
}

function dashscopeWsHost(region: string): string {
  return DASHSCOPE_WS_HOSTS[region] ?? DASHSCOPE_WS_HOSTS.beijing;
}

const DASHSCOPE_REGION = process.env.DASHSCOPE_REGION ?? 'beijing';

function list(v: string | undefined, dflt: string[]): string[] {
  if (!v) return dflt;
  const items = v.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : dflt;
}

/** 媒体与数据目录可配置（PRD 10.3） */
export const cfg = {
  aiMode: (process.env.AI_MODE ?? 'mock') as 'mock' | 'dashscope',
  dashscope: {
    apiKey: process.env.DASHSCOPE_API_KEY ?? '',
    region: DASHSCOPE_REGION,
    host: dashscopeHost(DASHSCOPE_REGION),
    wsHost: dashscopeWsHost(DASHSCOPE_REGION),
    /**
     * 音频识别通道（PRD 10.5 的三模型之一，因本机无公网地址而调整）：
     *  realtime  = paraformer-realtime-v2，WebSocket 直推本地音频，返回句级时间戳（默认）
     *  filetrans = qwen3-asr-flash-filetrans，异步任务，要求 file_urls 为公网可访问地址
     */
    asrTransport: (process.env.ASR_TRANSPORT ?? 'realtime') as 'realtime' | 'filetrans',
    asrModel: process.env.ASR_MODEL ?? 'paraformer-realtime-v2',
    visionModel: process.env.VISION_MODEL ?? 'qwen3-vl-plus',
    organizeModel: process.env.ORGANIZE_MODEL ?? 'qwen3.8-flash',
    /** 实时识别的推流倍速：1=按真实速率。实测 1x 与 4x 时间戳结果一致，默认 4x 缩短耗时 */
    asrPushSpeed: num(process.env.ASR_PUSH_SPEED, 4),
    /** 句切分静音阈值（毫秒）：越小越容易切碎，越大越容易合并长句 */
    asrMaxSentenceSilence: num(process.env.ASR_MAX_SENTENCE_SILENCE, 800),
    asrLanguageHints: list(process.env.ASR_LANGUAGE_HINTS, ['zh', 'en']),
    /** 说话人分离：开启后返回 speakerId，不自动等同主体或旁白（PRD 10.6） */
    asrDiarization: (process.env.ASR_DIARIZATION ?? 'false') === 'true',
  },
  mediaDir: path.resolve(projectRoot, process.env.MEDIA_DIR ?? './data/media'),
  exportDir: path.resolve(projectRoot, './data/exports'),
  tmpDir: path.resolve(projectRoot, './data/tmp'),
  sessionSecret: process.env.SESSION_SECRET ?? 'change-me-local-only',
  port: num(process.env.PORT, 3939),
  /**
   * 形式判定阈值（2026-09-16 需求方口径）：
   * - AI 画面时长占比 ≥ aiVideoRatioThreshold → 「AI数字人」
   * - 真人内容占比 ≥ realPersonRatioThreshold（即 AI 占比 ≤ 1 - 该值）→ 「真人」
   * - 夹在两者之间的中间带 → 「其他」
   */
  aiVideoRatioThreshold: num(process.env.AI_VIDEO_RATIO_THRESHOLD, 0.75),
  realPersonRatioThreshold: num(process.env.REAL_PERSON_RATIO_THRESHOLD, 0.75),
  sceneChangeThreshold: num(process.env.SCENE_CHANGE_THRESHOLD, 0.35),
  visionSampleCount: num(process.env.VISION_SAMPLE_COUNT, 9),
  maxAttemptRetry: num(process.env.MAX_ATTEMPT_RETRY, 2),
  retryIntervalMs: num(process.env.RETRY_INTERVAL_MS, 3000),
  stageTimeoutMs: num(process.env.STAGE_TIMEOUT_MS, 600_000),
  /**
   * 腾讯妙思（PRD 10.4）。真实抓取依赖 playwright + 一次人工扫码登录：
   * 会话文件存在即视为已登录，抓取时用无头浏览器复用该会话。
   */
  muse: {
    fetchEnabled: (process.env.MUSE_FETCH_ENABLED ?? 'false') === 'true',
    storageState: path.resolve(projectRoot, process.env.MUSE_STORAGE_STATE ?? './data/muse-session/state.json'),
    loginUrl: process.env.MUSE_LOGIN_URL ?? 'https://admuse.qq.com/',
    /** 抓取用无头模式；排查页面问题时可设为 false 用有头模式观察 */
    headless: (process.env.MUSE_HEADLESS ?? 'true') !== 'false',
    /** 打开素材页后等待媒体地址出现的最长时间 */
    waitMs: num(process.env.MUSE_WAIT_MS, 20_000),
    navTimeoutMs: num(process.env.MUSE_NAV_TIMEOUT_MS, 45_000),
    /** 只接受这些域名的素材链接，避免把任意输入当服务器路径读取（PRD 11.2） */
    allowedHosts: list(process.env.MUSE_ALLOWED_HOSTS, ['admuse.qq.com', 'ad.qq.com']),
  },
  /** 可配置限制由研发校验后公布（PRD 3.4）；此处给出首版保守默认值 */
  limits: {
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    maxDurationMs: 30 * 60 * 1000,
    maxBatchRows: 200,
    allowedExtensions: ALLOWED_EXTENSIONS,
  },
  /**
   * 报价（PRD 11.4）。价格核对日 2026-09-15，华北2（北京）档位，来源为阿里云百炼模型页。
   * 仅脚本整理档位随 ORGANIZE_MODEL=qwen3.8-flash 调整（0.8/2.7），视觉与音频未变。
   * 仅为估算口径，实际以阿里云账单为准；价格变动时只需改这里并更新 priceVersion，
   * 历史记录的单价版本已随 ModelUsage.priceVersion 落库，不会被新价格覆盖。
   */
  pricing: {
    priceVersion: '2026-09-15',
    /** paraformer-realtime-v2：0.00024 元/秒（= 0.864 元/小时） */
    asrPerSecond: 0.00024,
    /**
     * qwen3-vl-plus 按「单次请求输入 tokens」分档计价，输入越长单价越高。
     * 不分档会低估长输入（9 张采样图可能超过 32k）的费用。
     */
    visionTiers: [
      { maxInputTokens: 32_000, inputPerMillion: 1, outputPerMillion: 10 },
      { maxInputTokens: 128_000, inputPerMillion: 1.5, outputPerMillion: 15 },
      { maxInputTokens: 256_000, inputPerMillion: 3, outputPerMillion: 30 },
    ],
    /**
     * qwen3.8-flash：0.8 元/百万 输入，2.7 元/百万 输出（华北2 北京，1M 上下文不额外分档）。
     * 缓存命中输入 0.1 元/百万，本项目每次请求的转写内容不同，暂不适用。
     */
    organizeInputPerMillion: 0.8,
    organizeOutputPerMillion: 2.7,
  },
} as const;

export function ensureDirs() {
  for (const d of [cfg.mediaDir, cfg.exportDir, cfg.tmpDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
