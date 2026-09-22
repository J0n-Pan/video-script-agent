// 数字人（鲲之益）适配器契约（2026-09-20 需求迭代 §7）。
//
// 设计要点：
// 1. 业务层只认这几个动作：检查登录 / 定位资产 / 提交 / 查询 / 取回（+ 预检、人工接手）。
//    官方 API 是否存在尚未确认，所以「怎么实现」被隔离在适配器里 —— 将来换成官方 API
//    只要换一个 AvatarAdapter 实现，业务层与界面都不用动。
// 2. 适配器**不负责**落库、不负责命名文件、不负责幂等：那些是业务层的事。
//    适配器只做「与平台交互」这一件事。
// 3. 结果不明必须如实上报（uncertain），不能猜。猜错会导致重复提交、重复计费（A16）。

export type AvatarAsset = {
  /** 期望资产名（配置里的名字） */
  name: string;
  /** 页面上匹配到的数量；≠1 时视为不可用，绝不静默挑一个 */
  matched: number;
  /** 页面上实际看到的文本，便于排查 */
  raw: string;
};

export type AvatarSubmitInput = {
  /** 提交文本：选定修订的分段正文按序拼接，不含标签等非口播内容（A14） */
  text: string;
  /** 作品名：平台侧重名时的核对依据（§7.4） */
  businessName: string;
  avatarName: string;
  voiceName: string;
  language: string;
  speed: number;
  volume: number;
  subtitle: boolean;
  bgm: boolean;
  /**
   * 本次提交尝试的开始时间（毫秒）。
   *
   * 人工接手时用来划「时间线」：关窗之后如果按作品名查不到，但作品列表里有一条
   * **提交时间晚于本次尝试**的作品，那多半就是我们这条被改了名（2026-09-22 实测），
   * 这时不能判「确定没提交」。
   */
  attemptedAtMs?: number;
};

/**
 * 平台「我的作品」列表里的一行（只读快照）。
 *
 * 存在的意义：**平台作品 ID 不随改名变化**，而唯一作品名会。所以一旦编导在平台上改了作品名，
 * 按名字对账必然失效 —— 那时只能靠 ID 追踪，或者靠时间线判断「那条被改名的其实是我们」。
 */
export type AvatarWorkRow = {
  /** 平台自己的作品 ID（列表第 1 列，纯数字） */
  vendorJobId?: string;
  /** 平台上当前显示的作品名（平台会追加 `_<账号内序号>`，编导还可能整条改名） */
  name: string;
  /** 平台状态文案，如「创作中 / 创作完成 / 创作失败」 */
  status: string;
  /** 平台显示的提交时间原文，如 `2026-09-22 11:17` */
  submittedAt?: string;
  /** 提交时间解析成毫秒（按平台时区 +08:00）；解析不出来就 undefined */
  submittedAtMs?: number;
};

export type AvatarSubmitResult = {
  vendorJobId?: string;
  /**
   * 提交结果不明（页面超时、进程中断、提交后没拿到作品 ID）时为 true。
   * 业务层据此进入「结果待核对」，**不自动重新提交**。
   */
  uncertain?: boolean;
  message: string;
  /** 失败时的页面截图路径，便于人工判断真实状态 */
  screenshotPath?: string;
};

export type AvatarQueryStatus =
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'NOT_FOUND'
  | 'NEEDS_LOGIN'
  | 'NEEDS_REVIEW';

export type AvatarQueryResult = {
  status: AvatarQueryStatus;
  vendorJobId?: string;
  /** 平台提供的下载地址（可能过期）；成品仍会持久化到本地，不依赖它 */
  assetUrl?: string;
  /** 平台上的进度或状态文案 */
  progress?: string;
  message: string;
};

export type AvatarFetchResult = {
  /** 已下载到本机临时路径；业务层负责持久化与媒体校验 */
  tempPath?: string;
  sourceUrl?: string;
  message: string;
};

/**
 * 「填表到提交前」的预检结果（2026-09-20 新增）。
 *
 * 为什么单独开一个动作：真实提交会**消耗平台额度**，而页面选择器是否还与平台一致、
 * 必填项是否真的都填上了，这些恰恰是联调阶段最需要反复验证的东西。
 * 预检把 1~5 步全做一遍（填文本 / 选形象 / 选音色 / 设参数 / 填作品名），
 * 读一下提交按钮是否可用，然后**不点提交**就退出 —— 零额度成本。
 */
export type AvatarPreflightStep = {
  name: string;
  ok: boolean;
  detail: string;
};

export type AvatarPreflightResult = {
  ok: boolean;
  steps: AvatarPreflightStep[];
  /** 提交按钮是否可用；false 说明还有必填项没填完（此时绝不能点提交） */
  submitEnabled: boolean;
  message: string;
  screenshotPath?: string;
};

export interface AvatarAdapter {
  readonly mode: 'mock' | 'playwright';
  /** 会话是否可用（未登录要明确报「待登录」，不去猜） */
  checkLogin(): Promise<{ ok: boolean; message: string }>;
  /** 定位默认形象与音色：必须**唯一匹配**，否则报错（A13） */
  resolveAssets(): Promise<{ avatar: AvatarAsset; voice: AvatarAsset; message: string }>;
  /** 提交一次生成任务 */
  submit(input: AvatarSubmitInput): Promise<AvatarSubmitResult>;
  /** 查询任务状态（按作品 ID 或唯一作品名） */
  query(ref: { vendorJobId?: string | null; businessName: string }): Promise<AvatarQueryResult>;
  /** 取回成品到本机临时文件 */
  fetchVideo(ref: { vendorJobId?: string | null; businessName: string }): Promise<AvatarFetchResult>;
  /** 只填表不提交的预检（不消耗平台额度）；不支持该动作的适配器可不实现 */
  preflight?(input: AvatarSubmitInput): Promise<AvatarPreflightResult>;
  /**
   * 「人工接手」提交（2026-09-22 新增，`AVATAR_SUBMIT_MODE=assist` 时使用）。
   *
   * 与 `submit()` 的区别：只预填**作品名与文案**，形象/音色/参数/文件夹**一概不碰**，
   * 停在创建页由编导自己选、自己点「生成视频」。所以它天然不需要处理 A13 唯一匹配、
   * 参数滑杆、必填文件夹这些脆弱环节。
   *
   * 判定提交与否**只认一个判据**：作品列表里有没有出现我们的唯一作品名。
   * 没出现就说明确实没提交（而不是「结果不明」）—— 这是人工接手相对自动提交更稳的地方，
   * 因为不再需要去猜一次点击到底成没成。不支持该动作的适配器可不实现。
   */
  assistSubmit?(input: AvatarSubmitInput): Promise<AvatarAssistResult>;
  /**
   * 只读平台「我的作品」列表（最近的在前）。
   *
   * 用途有两个，都是 2026-09-22 的「改名把对账搞崩」事故逼出来的：
   *   1. 关窗后按作品名查不到时，靠它按时间线判断「是否是自己的作品被改名了」；
   *   2. 给编导一个「绑定平台作品」的入口 —— 把已被改名的作品按 ID 接回任务。
   * 不支持该动作的适配器可不实现。
   */
  listWorks?(limit?: number): Promise<AvatarWorkRow[]>;
}

/**
 * 人工接手的结论。
 *
 * 刻意**没有** `uncertain` 之外的模糊态：
 *   · `submitted` —— 作品列表里查到了自己的唯一作品名，确定已提交；
 *   · `cancelled` —— 窗口被关掉 / 等待超时，且作品列表里**查不到**自己的作品名，且**没有**
 *     「本次尝试之后新建的作品」—— 两个判据都指向「确实没提交过」才敢下这个结论；
 *   · `uncertain` —— 会话失效查不了列表，**或者**查得到列表但发现了时间线可疑的新作品
 *     （多半是我们的作品被改名了），这时不敢下任何结论。
 * 业务层据此决定「进入平台生成中」还是「把任务退回可重来的状态」。
 *
 * ⚠️ `cancelled` 会让业务层**清空 submittedAt 并允许重新提交**，方向很危险：
 * 一旦把「已提交成功、只是被改名」误判成 cancelled，就会丢掉一条真出片的任务，
 * 甚至让编导再提一遍重复计费。所以判据必须保守（2026-09-22 事故）。
 */
export type AvatarAssistResult = {
  kind: 'submitted' | 'cancelled' | 'uncertain';
  vendorJobId?: string;
  /** cancelled 的原因（人工关闭窗口 / 等待超时），便于界面把话说清楚 */
  reason?: string;
  message: string;
  screenshotPath?: string;
};

/** 适配器内部统一抛这个错误，业务层据此区分「平台侧失败」与「我方代码问题」 */
export class AvatarError extends Error {
  code: string;
  uncertain: boolean;
  constructor(code: string, message: string, opts: { uncertain?: boolean } = {}) {
    super(message);
    this.name = 'AvatarError';
    this.code = code;
    this.uncertain = opts.uncertain === true;
  }
}

export const AVATAR_STATUS_LABEL: Record<string, string> = {
  QUEUED: '排队中',
  NEEDS_LOGIN: '待登录',
  SUBMITTING: '正在提交',
  VENDOR_RUNNING: '平台生成中',
  NEEDS_REVIEW: '结果待核对',
  /**
   * 人工接手时编导没提交就关掉了窗口 / 等待超时（且已确认平台侧没有作品）。
   * 单独立一个状态而不是复用「失败」：**这不是失败**，是「这次没做」，
   * 显示成失败会让编导以为平台出问题了，反而去平台上找一个不存在的作品。
   */
  ASSIST_CANCELLED: '人工接手已取消',
  FETCHING: '正在获取视频',
  SUCCEEDED: '已完成',
  FAILED: '失败',
};
