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
   * 鲲之益数字人（2026-09-20 需求迭代 §7）。
   *
   * 官方 API 尚未确认，首版走 Playwright 网页适配器；会话**独立于妙思**（单独的 storageState 文件），
   * 因为这是不同站点、不同账号，混用一个会话文件会让两边的登录态互相覆盖。
   * adapter 可切 mock：真实账号尚未联调时，验收脚本与页面流程仍可完整跑通。
   */
  avatar: {
    adapter: (process.env.AVATAR_ADAPTER ?? 'mock') as 'mock' | 'playwright',
    baseUrl: process.env.AVATAR_BASE_URL ?? 'https://aigc.huweilai.cn',
    createPath: process.env.AVATAR_CREATE_PATH ?? '/dashboard/to-create-video',
    worksPath: process.env.AVATAR_WORKS_PATH ?? '/digital-human/digital-video',
    storageState: path.resolve(projectRoot, process.env.AVATAR_STORAGE_STATE ?? './data/avatar-session/state.json'),
    /** 抓取用无头模式；排查页面问题时可设为 false 用有头模式观察 */
    headless: (process.env.AVATAR_HEADLESS ?? 'true') !== 'false',
    navTimeoutMs: num(process.env.AVATAR_NAV_TIMEOUT_MS, 45_000),
    actionTimeoutMs: num(process.env.AVATAR_ACTION_TIMEOUT_MS, 60_000),
    /**
     * 默认形象与音色（§1.1）。**必须唯一匹配**：找不到、重名或资产被移除时明确报错，
     * 绝不静默换成别的形象或声音（A13）。
     */
    avatarName: process.env.AVATAR_NAME ?? '李威老师_场景1_书房坐姿',
    voiceName: process.env.AVATAR_VOICE ?? '李威老师',
    language: process.env.AVATAR_LANGUAGE ?? '中文',
    speed: num(process.env.AVATAR_SPEED, 1.0),
    volume: num(process.env.AVATAR_VOLUME, 1.0),
    subtitle: (process.env.AVATAR_SUBTITLE ?? 'false') === 'true',
    bgm: (process.env.AVATAR_BGM ?? 'false') === 'true',
    /**
     * 「成片保存至」的目标文件夹（2026-09-20 探针补录）。
     * 创建页右上角有个**必填**的文件夹下拉（placeholder「请输入名称搜索」），不选它「生成视频」一直是禁用的 ——
     * 实测截图确认：形象/音色/文本/作品名都填好后，按钮仍 disabled，唯一空着的是这一项。
     * 因此它是提交前的必填步骤，且必须显式配置，不能猜一个文件夹（会把成片存到别人目录里）。
     */
    saveFolder: process.env.AVATAR_SAVE_FOLDER ?? '李威数字人',
    /** 轮询平台任务状态 */
    pollIntervalMs: num(process.env.AVATAR_POLL_INTERVAL_MS, 15_000),
    pollTimeoutMs: num(process.env.AVATAR_POLL_TIMEOUT_MS, 30 * 60 * 1000),
    /**
     * 提交方式（2026-09-22 新增）：
     *   · `auto`   —— 全自动：适配器自己选形象/音色/参数/文件夹并点「生成视频」。
     *   · `assist` —— 人工接手：只预填**作品名与文案**，然后停在创建页，
     *                 由编导自己挑形象和各项参数、自己点「生成视频」。
     *
     * 为什么给 assist 留一条路（2026-09-21 真实联调结论）：
     * 自动提交最脆的几段恰好都在「替平台做参数校验」上 —— 形象/音色必须**唯一匹配**（A13）、
     * 参数滑杆、`成片保存至` 必填文件夹、提交按钮可用性判断。这些选择器平台一改版就崩，
     * 而且崩了以后报出来的是「请检查配置参数」这种没人能诊断的泛化错误。
     * 交给平台自己的 UI 去校验，比我们猜它的规则可靠。选参数的人肉成本换稳定性。
     *
     * 默认仍是 `auto`：**不改这条配置，行为与 2026-09-21 之前完全一致**。
     */
    submitMode: (process.env.AVATAR_SUBMIT_MODE ?? 'auto') as 'auto' | 'assist',
    /** assist 模式下等编导操作的上限；超时后按「回查作品列表」判定是否真的提交过 */
    assistTimeoutMs: num(process.env.AVATAR_ASSIST_TIMEOUT_MS, 30 * 60 * 1000),
    /**
     * 平台单次文本上限：**尚未核实**，先给保守值。
     * 超限时提示编导处理，不自动拆成多个任务、也不删减文案（§7.3）。
     */
    maxTextChars: num(process.env.AVATAR_MAX_TEXT_CHARS, 5000),
    /** 只接受这些域名的成品链接，避免把任意输入当服务器路径读取 */
    allowedHosts: list(process.env.AVATAR_ALLOWED_HOSTS, ['aigc.huweilai.cn']),
    /**
     * **成品的本地保存路径**（§7.5：不只依赖第三方下载链接）。
     *
     * 这就是「以后要改成别的保存路径，只改这一处」的接口点 ——
     * 落在 `AVATAR_VIDEO_DIR` 上，代码里统一由 `resolveAssetPath()`（src/lib/avatar/storage.ts）消费，
     * 不要在别处再拼一次路径。
     */
    videoDir: path.resolve(projectRoot, process.env.AVATAR_VIDEO_DIR ?? './data/avatars'),
  },
  /**
   * 个性化文案改写（2026-09-20 需求迭代）。
   * 与视频分析解耦：换创作模型不影响 ASR / 视觉 / 整理，也不需要换 API Key。
   */
  rewrite: {
    /** 创作模型：默认继承现有整理模型；REWRITE_MODEL 可独立指定 */
    model: process.env.REWRITE_MODEL ?? process.env.ORGANIZE_MODEL ?? 'qwen3.8-flash',
    /** 每次生成的版本数（设计默认 3，后端可配置，不新增必填表单） */
    variantCount: num(process.env.REWRITE_VARIANT_COUNT, 3),
    /** 默认平台；仅影响措辞与既有行动引导的表达，不改变结构 */
    platform: process.env.REWRITE_PLATFORM ?? 'WECHAT_CHANNELS',
    /**
     * 提示词与规则版本：会写进任务快照，保证日后改了提示词也能分辨旧任务用了哪一版。
     * v2（2026-09-20）：实测后加固 —— 明确禁止段内新增引流引导、明确每段字数应贴近参考段。
     * v3（2026-09-20）：资料包新增「事实边界与禁止表述」「待统一字段与缺失资料」两块并作为硬约束渲染在前，
     *   规则里加上「不得自行采信冲突字段」；配合导入用户提供的《李威 IP 形象与文案改写资料初版 v0.1》。
     * v4（2026-09-22）：新增违禁词资料包（禁用表达），渲染在参考段**之前**作为红线；
     *   规则里加上「不得用同音字/拆字/谐音变相写出禁用表达」；生成后由程序扫描命中并打 BANNED_WORD_HIT。
     */
    promptVersion: 'rewrite-v4',
    ruleVersion: 'rewrite-v4',
    /** 一次生成要写多篇长文，给足超时，但有限等待，不无限等 */
    timeoutMs: num(process.env.REWRITE_TIMEOUT_MS, 600_000),
    /** 中文大约 1 字 ≈ 1.5~2 token；3 篇 × 约 1500 字需要较宽的输出预算 */
    maxOutputTokens: num(process.env.REWRITE_MAX_OUTPUT_TOKENS, 16_000),
    temperature: num(process.env.REWRITE_TEMPERATURE, 0.85),
    /** 多版本要有表达差异，但不得靠改结构制造差异 */
    topP: num(process.env.REWRITE_TOP_P, 0.9),
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
    /**
     * 创作（改写）模型单价，元/百万 tokens，华北2（北京），核对日 2026-09-20。
     * 按模型名索引：换 REWRITE_MODEL 后费用估算不漂。多档模型只取本场景实际落入的第一档
     * （改写单次输入约 5k tokens，远低于 128k 档）。
     * qwen3.8-* 系列若未显式 enable_thinking=false 会走思考模式，输出 tokens 数量级上升。
     */
    rewriteModels: {
      'qwen3.8-flash': { inputPerMillion: 0.8, outputPerMillion: 2.7 },
      'qwen3.7-flash': { inputPerMillion: 0.6, outputPerMillion: 2.4 },
      'qwen3.7-plus': { inputPerMillion: 2, outputPerMillion: 8 },
      'qwen3.8-max': { inputPerMillion: 12, outputPerMillion: 36 },
      'qwen-plus': { inputPerMillion: 0.8, outputPerMillion: 2 },
      'qwen3-max': { inputPerMillion: 2.5, outputPerMillion: 10 },
    } as Record<string, { inputPerMillion: number; outputPerMillion: number }>,
  },
} as const;

export function ensureDirs() {
  for (const d of [cfg.mediaDir, cfg.exportDir, cfg.tmpDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
