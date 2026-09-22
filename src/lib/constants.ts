// 领域常量：状态字典、缺失值字典、固定九列（PRD 5.3 / 5.5 / 6.2）

/**
 * 工作台的对外名称（页头 / 登录页 / 浏览器标签 / 导出文件的 Excel「作者」属性）。
 *
 * 为什么收成常量：2026-09-22 改名时发现这个名字原本散在 6 个文件里（页头、登录页、
 * 标签页 + 3 个导出的 wb.creator），改一次要 grep 一遍还容易漏。
 * 以后改名只动这一处。
 */
export const APP_NAME = '信息流编导工作台';

/** 处理状态字典（PRD 6.2） */
export const VIDEO_STATUS = {
  UPLOADING: 'UPLOADING',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  UNSUPPORTED: 'UNSUPPORTED',
  CANCELLED: 'CANCELLED',
} as const;
export type VideoStatus = (typeof VIDEO_STATUS)[keyof typeof VIDEO_STATUS];

export const VIDEO_STATUS_LABEL: Record<string, string> = {
  UPLOADING: '上传中',
  QUEUED: '排队中',
  PROCESSING: '处理中',
  COMPLETED: '已完成',
  PARTIAL: '部分完成',
  FAILED: '失败',
  UNSUPPORTED: '暂不支持',
  CANCELLED: '已取消',
};

/** 复核状态独立于处理状态；处理成功不等于人工认可 */
export const REVIEW_STATUS = {
  NOT_REVIEWED: 'NOT_REVIEWED',
  REVIEWED: 'REVIEWED',
} as const;
export const REVIEW_STATUS_LABEL: Record<string, string> = {
  NOT_REVIEWED: '未复核',
  REVIEWED: '已复核',
};

/** 处理阶段（不展示无依据的百分比与预计时间） */
export const STAGE_LABEL: Record<string, string> = {
  FETCH: '获取视频',
  CACHE: '缓存并校验媒体',
  VALIDATE: '校验媒体可读性',
  CLASSIFY: '判断视频形式',
  ASR: '识别语音',
  VISION: '提取画面',
  ORGANIZE: '整理脚本',
  SAVE: '保存脚本版本',
  EXPORT: '生成 Excel',
};

/** 缺失信息必须区分（PRD 5.5）：显示值 → 使用条件 */
export const MISSING = {
  NONE: '无', // 已确认对应内容不存在
  NOT_PROVIDED: '未提供', // 用户及来源均未提供
  UNCLEAR_PREFIX: '听不清', // 存在语音但无法辨认具体文字，附时间
  UNRECOGNIZABLE: '无法辨认', // 画面存在但看不清细节
  PENDING_REVIEW: '待复核', // 内容存在、归属或形式不能可靠判断
  UNPARSED: '未解析', // 混剪停止或某项未执行
  SAME_AS_ABOVE: '同上', // 妆造/场景无变化（首段必须完整）
  BADGE: '有缺失',
} as const;

export function unclearAt(startMs: number, endMs: number): string {
  return `${MISSING.UNCLEAR_PREFIX}（${formatClock(startMs)}–${formatClock(endMs)}）`;
}

/**
 * 脚本标签（2026-09-16 需求方确认：删除「场景」）：
 * 每段转写文案只能有一个标签，不允许重复标注；无法归入前五类的一律归「其他」。
 * 「场景」不再作为标签——模型若仍输出场景，按需求方口径归入「痛点」（见 normalizeTag）。
 */
export const TAG = {
  PERSONA: '人设',
  PAIN: '痛点',
  SOLUTION: '干货（解决方案）',
  MARKETING: '营销内容（产品介绍）',
  BENEFIT: '福利',
  OTHER: '其他',
} as const;
export type TagValue = (typeof TAG)[keyof typeof TAG];

/** 已废弃标签：历史数据与旧提示词残留，读到时必须映射，不能让整段丢失 */
export const LEGACY_TAG_SCENE = '场景';

/** 标签列顺序固定，不能改变 */
export const TAG_ORDER: TagValue[] = [
  TAG.PERSONA,
  TAG.PAIN,
  TAG.SOLUTION,
  TAG.MARKETING,
  TAG.BENEFIT,
  TAG.OTHER,
];

export const TAG_COLUMNS = TAG_ORDER.map((t) => ({ key: t, header: t }));

/**
 * 「视频分析」栏（2026-09-16 由「基本信息」改名）：同一条视频只出现一次，整表只有一行数据。
 * 顺序固定：原视频标题 → 人群分析 → 分镜/高光 → 创意标签 → 妆造/画面场景/情绪 → 形式 → 视频链接。
 *
 * 「原视频标题」（2026-09-16 新增，排在最上方）：本地导入填原文件的文件名，
 * 链接导入填链接对应网页的标题；与「任务信息 → 标题」分开，不随人工改标题而变。
 */
export const BASIC_INFO_GROUP_LABEL = '视频分析';

export const BASIC_INFO_COLUMNS = [
  { key: 'sourceTitle', header: '原视频标题' },
  { key: 'gender', header: '性别特征' },
  { key: 'age', header: '年龄特征' },
  { key: 'shotTitle', header: '分镜/高光 title' },
  { key: 'creativeTags', header: '创意标签' },
  { key: 'makeup', header: '妆造' },
  { key: 'scene', header: '画面场景' },
  { key: 'emotion', header: '情绪' },
  { key: 'form', header: '形式' },
  { key: 'sourceLink', header: '视频链接' },
] as const;

/** 导出表完整列：视频分析 10 列 + 脚本文案 1 列 + 标签 6 列 = 17 列 */
export const TRANSCRIPT_COLUMN = { key: 'transcript', header: '脚本文案', group: 'transcript' as const };

/** 「脚本文案」栏：音频转写模型输出的一整段原文，可人工编辑；与分段无关，工作台与导出同源 */
export const TRANSCRIPT_GROUP_LABEL = '脚本文案';

export const EXPORT_COLUMNS = [
  ...BASIC_INFO_COLUMNS.map((c) => ({ key: c.key, header: c.header, group: 'basic' as const })),
  TRANSCRIPT_COLUMN,
  ...TAG_COLUMNS.map((c) => ({ key: c.key, header: c.header, group: 'tag' as const })),
];

/** 标签列在导出表中的起始下标（0 基）：视频分析 10 列 + 脚本文案 1 列之后 */
export const TAG_COLUMN_OFFSET = BASIC_INFO_COLUMNS.length + 1;

/**
 * 导出类型（2026-09-16 需求方确认）：
 * - SCRIPT「导出信息流脚本」：按时间轴依次列出每段切分文案与标签（3 列，一视频一表）；
 * - LIBRARY「导出信息流素材库」：按标签把原文聚合到对应列（单行，17 列）。
 */
export const EXPORT_KIND = {
  SCRIPT: 'SCRIPT',
  LIBRARY: 'LIBRARY',
  /** 改写稿导出：独立类型，不覆盖原有两种（需求文档 §9） */
  REWRITE: 'REWRITE',
} as const;
export type ExportKind = (typeof EXPORT_KIND)[keyof typeof EXPORT_KIND];

export const EXPORT_KIND_LABEL: Record<string, string> = {
  [EXPORT_KIND.SCRIPT]: '信息流脚本',
  [EXPORT_KIND.LIBRARY]: '信息流素材库',
  [EXPORT_KIND.REWRITE]: '信息流文案改写稿',
};

/** 「信息流脚本」表的列名（2026-09-16 需求方确认：第一列表头就是「序号 / 时间」） */
export const SCRIPT_COLUMNS = ['序号 / 时间', '标签', '文案'] as const;

/**
 * 改写稿导出表的列名（2026-09-20）。
 * 「预计口播时长」明确标「估算」：改写稿没有真实时间码，不能让编导误当成参考片的时间码。
 */
export const REWRITE_COLUMNS = ['稿件版本', '序号', '标签', '正文', '预计口播时长（估算）'] as const;

/**
 * 妙思「创意标签」的展示顺序（2026-09-16 需求方确认）。
 *
 * 只展示这 10 项并按此顺序排列；其余字段（定向性别 / 平台活动 / 事件 / 地域 / 知识产权 /
 * 明星 / 促销 / 核心功能 / 痛点 / 卖点等）**仍照常采集并保存在原网页快照里**，
 * 只是不在工作台与导出中呈现。key 取妙思 label_info 的字段名，label 为展示名。
 * 填充逻辑（取值、拼接方式、多值用「、」连接）不变，只调整顺序与展示范围。
 */
export const MUSE_CREATIVE_TAG_ORDER: Array<{ key: string; label: string }> = [
  { key: 'apply_age', label: '定向年龄' },
  { key: 'crowd', label: '人群' },
  { key: 'make_form', label: '制作形式' },
  { key: 'emotion', label: '情绪' },
  { key: 'bg_style', label: '背景风格' },
  { key: 'scene_bg', label: '场景背景' },
  { key: 'narrative', label: '叙事' },
  { key: 'open_hook', label: '开场钩子' },
  { key: 'end_hook', label: '结尾钩子' },
  { key: 'cta', label: '行动引导' },
];

/** 按固定顺序取出要展示的创意标签：缺失的字段直接跳过，不做补位、不写占位词 */
export function orderCreativeTags(
  tags: Array<{ key: string; label: string; values: string[] }> | undefined | null,
): Array<{ key: string; label: string; values: string[] }> {
  if (!tags?.length) return [];
  const byKey = new Map(tags.map((t) => [t.key, t]));
  const out: Array<{ key: string; label: string; values: string[] }> = [];
  for (const spec of MUSE_CREATIVE_TAG_ORDER) {
    const hit = byKey.get(spec.key);
    if (hit?.values?.length) out.push({ key: spec.key, label: spec.label, values: hit.values });
  }
  return out;
}

/** 标签是否合法（大小写与空格容错，避免模型输出轻微差异导致整段丢失） */
export function normalizeTag(raw: unknown): TagValue {
  const s = String(raw ?? '').trim();
  if (!s) return TAG.OTHER;
  const direct = TAG_ORDER.find((t) => t === s);
  if (direct) return direct;
  // 已废弃的「场景」：按需求方口径归入「痛点」，不留空、不落到「其他」
  if (s.includes(LEGACY_TAG_SCENE)) return TAG.PAIN;
  if (s.includes('人设')) return TAG.PERSONA;
  if (s.includes('痛点')) return TAG.PAIN;
  if (s.includes('干货') || s.includes('解决')) return TAG.SOLUTION;
  if (s.includes('营销') || s.includes('产品')) return TAG.MARKETING;
  if (s.includes('福利')) return TAG.BENEFIT;
  if (/other/i.test(s)) return TAG.OTHER;
  return TAG.OTHER;
}

/**
 * 形式分类取值（2026-09-16 需求方收敛为 4 项）。
 *
 * 判定口径（见 classification.ts）：
 * - 混剪：判定逻辑不变（无连贯主体、多个独立素材拼接）
 * - AI数字人：AI 画面时长占比 ≥ 75%
 * - 真人：真人内容占比 ≥ 75%（即 AI 占比 ≤ 25%）
 * - 其他：上述都不满足的中间带，以及模型无法可靠估计占比的情况
 *
 * 原「有ai片段」「真人口播」「真人访谈」「其他及简短说明」「待复核」五个取值已取消，
 * 存量数据由 scripts/migrate-form-values.ts 统一回填。
 */
export const FORM = {
  MIXED_CUT: '混剪',
  AI_AVATAR: 'AI数字人',
  REAL_PERSON: '真人',
  OTHER: '其他',
} as const;

export const FORM_LABEL: Record<string, string> = {
  [FORM.MIXED_CUT]: '混剪',
  [FORM.AI_AVATAR]: 'AI数字人',
  [FORM.REAL_PERSON]: '真人',
  [FORM.OTHER]: '其他',
};

/** 形式可选值（人工纠正下拉框用；顺序即展示顺序） */
export const FORM_OPTIONS: string[] = [FORM.MIXED_CUT, FORM.AI_AVATAR, FORM.REAL_PERSON, FORM.OTHER];

/** 混剪统一提示文案（混剪不生成截图，未解析字段一律“未解析”，不得写成“无”） */
export const MIXED_CUT_MESSAGE = '暂不支持解析此视频';

/** 不可导出的记录类型（PRD 7.4） */
export const NON_EXPORTABLE_STATUSES: string[] = [
  VIDEO_STATUS.UPLOADING,
  VIDEO_STATUS.QUEUED,
  VIDEO_STATUS.PROCESSING,
  VIDEO_STATUS.CANCELLED,
];

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRange(startMs: number, endMs: number): string {
  return `${formatClock(startMs)}–${formatClock(endMs)}`;
}

/** 源链接可点击前先做协议白名单，避免把任意输入当作内部地址读取（PRD 11.2） */
export function safeLink(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}
