import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';

/**
 * 腾讯妙思原网页「基本信息」板块采集（2026-09-15 新逻辑）。
 *
 * 四类板块并不在页面 HTML 里，而来自详情接口：
 *   POST /intelligent/api/v1/inspiration/ranking_detail/get
 *   body { creative_id, creative_type, ranking_id, user_id, date_range, uid, account_id }
 *
 * 真实字段（实测，2026-09-15）：
 *   - 人群分析        label_info.core_gender / label_info.core_age
 *   - 视频分镜分析    video_script_summary[].phase_name（含 start_time/end_time/core_script 等 8 键）
 *   - 高光时序分析    click_time_series[].{ sec, values:{click,heart,share,follow} }（无标题字段）
 *   - 创意标签        label_info 其余键（emotion/bg_style/make_form/... 共 22 键）
 *
 * ## 为什么不自己发请求
 *
 * 妙思接口有 CSRF 校验：必须同时带上 `x-csrf-token`（取自 csrf-cookie）、
 * `x-trace-id`、`x-timestamp` 与由前端 SDK 计算的 `x-sign`。实测在页面上下文里
 * 用 fetch / XHR 自行发请求（即使补齐上述全部头）一律返回：
 *   {"code":221010,"message":"csrf check invalid"}
 * 因此本模块**不伪造请求**，改为「收割」页面自身已发出的接口响应：
 * 素材详情页渲染时会自行调用 ranking_detail/get，其响应就含全部板块内容。
 * 这样既不依赖签名算法（改版也不易失效），也不额外增加请求。
 *
 * 硬限制：板块只对灵感广场榜单内素材提供。若页面未返回板块内容，
 * 按需求「没有则标记为空」处理，并写明原因。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type MuseCreativeTag = { key: string; label: string; values: string[] };

export type MuseInsight = {
  /** 是否取到任意板块内容 */
  fetched: boolean;
  /** 人群分析：性别特征 */
  gender: string[];
  /** 人群分析：年龄特征 */
  age: string[];
  /** 视频分镜分析或高光时序分析的 title */
  shotTitles: string[];
  /** title 取自哪个板块（决定表头语义，便于追溯） */
  shotTitleSource: 'video_script_summary' | 'click_time_series' | 'none';
  /** 创意标签全量（已排除性别/年龄两个字段） */
  creativeTags: MuseCreativeTag[];
  /**
   * 原网页给出的素材时长（秒）。用于校验抓回来的视频是不是这条素材本身 ——
   * 详情页同时挂着相关推荐，只看地址证据有可能下到别的素材。
   */
  durationSec?: number;
  /** 面向编导的说明：取到写来源，取不到写原因 */
  note: string;
  creativeId?: string;
  collectedAt?: string;
};

/**
 * 页面接口响应的「收割器」：在页面导航前挂上，后续页面自己发出的
 * user/info 与 ranking_detail/get 响应会被动收集，供采集阶段读取。
 */
export type MuseHarvest = {
  /** 页面自身发出的 ranking_detail/get 响应 data（按内容完整度择优） */
  detail: any | null;
  /** 页面自身发出的 user/info 里的 account_id（仅用于日志/追溯） */
  accountId: string;
  /** 已解析到的 ranking_detail 响应条数 */
  detailCount: number;
  /** 观测到的 ranking_id 列表 */
  rankingIds: string[];
  /** 仍在校验/解析中的响应 */
  pending: Promise<void>[];
};

/** label_info 键 → 展示用中文名（本地映射，避免把英文键名暴露给编导） */
const LABEL_NAMES: Record<string, string> = {
  platform_activity: '平台活动',
  apply_gender: '定向性别',
  apply_age: '定向年龄',
  crowd: '人群',
  event: '事件',
  location: '地域',
  emotion: '情绪',
  end_hook: '结尾钩子',
  bg_style: '背景风格',
  make_form: '制作形式',
  open_hook: '开场钩子',
  scene_bg: '场景背景',
  intellectual_property: '知识产权',
  celebrity: '明星',
  narrative: '叙事',
  cta: '行动引导',
  promotion: '促销',
  key_function: '核心功能',
  sore_point: '痛点',
  selling: '卖点',
};

const EMPTY_INSIGHT: MuseInsight = {
  fetched: false,
  gender: [],
  age: [],
  shotTitles: [],
  shotTitleSource: 'none',
  creativeTags: [],
  note: '',
};

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

/** 从妙思链接里取 creative_id（形如 #/idea/detail/video/134580000001） */
export function creativeIdFromUrl(url: string): string | undefined {
  const m = /(?:video|detail|creative)[/=](\d{6,})/i.exec(url) ?? /(\d{9,})/.exec(url);
  return m?.[1];
}

function secToClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 板块内容完整度打分：页面一次加载可能发多条 ranking_detail，用分数择优 */
export function scoreDetail(d: any): number {
  if (!d) return -1;
  const li: Record<string, unknown> = d.label_info ?? {};
  let s = 0;
  if (strList(li.core_gender).length) s += 10;
  if (strList(li.core_age).length) s += 10;
  s += Math.min(6, Object.keys(li).length);
  s += Math.min(6, Array.isArray(d.video_script_summary) ? d.video_script_summary.length : 0);
  s += Math.min(3, Array.isArray(d.click_time_series) ? d.click_time_series.length : 0);
  if (Array.isArray(d.audience_taste) && d.audience_taste.length) s += 3;
  if (d.ranking_id) s += 2;
  return s;
}

/**
 * 挂上收割器（务必在 page.goto 之前调用，否则会错过详情页首屏的接口请求）。
 */
export function attachMuseHarvest(page: any): MuseHarvest {
  const h: MuseHarvest = { detail: null, accountId: '', detailCount: 0, rankingIds: [], pending: [] };
  page.on('response', (res: any) => {
    let url = '';
    try {
      url = res.url();
    } catch {
      return;
    }
    if (!url.includes('/intelligent/')) return;
    if (!/muse\/user\/info|ranking_detail\/get/.test(url)) return;
    const p = (async () => {
      try {
        const ct: string = res.headers?.()?.['content-type'] ?? '';
        if (!/json/i.test(ct)) return;
        const body = await res.json();
        if (/muse\/user\/info/.test(url)) {
          const id = String(body?.data?.account_id ?? '');
          if (id) h.accountId = id;
          return;
        }
        const data = body?.data;
        if (!data) return;
        h.detailCount += 1;
        const rid = String(data.ranking_id ?? '');
        if (rid && !h.rankingIds.includes(rid)) h.rankingIds.push(rid);
        if (!h.detail || scoreDetail(data) > scoreDetail(h.detail)) h.detail = data;
      } catch {
        /* 非 JSON 或响应体已被消费：忽略 */
      }
    })();
    h.pending.push(p);
  });
  return h;
}

/** 等待页面给出板块响应（一般详情页渲染完即有；无则在窗口期内轮询） */
async function harvestWait(h: MuseHarvest, timeoutMs: number): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  let sinceNew = 0;
  while (Date.now() < deadline) {
    await Promise.allSettled(h.pending.splice(0));
    if (h.detail) return h.detail;
    sinceNew += 400;
    // 已解析到 ranking_detail 响应但内容为空骨架时，不必等满窗口
    if (h.detailCount > 0 && sinceNew >= 1600) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await Promise.allSettled(h.pending.splice(0));
  return h.detail;
}

export function parseInsight(detail: any): MuseInsight {
  const d = detail ?? {};
  const li: Record<string, unknown> = d.label_info ?? {};
  // 「人群分析」板块在接口里就是 core_gender / core_age 两个字段，严格取这两个。
  // 不并入 apply_gender / apply_age —— 那是投放「定向」倾向（常为「无倾向」），
  // 属于创意标签侧的信息，混进来会让「年龄特征」出现 60+、中年、青壮年 这类不同口径的值。
  const gender = strList(li.core_gender);
  const age = strList(li.core_age);

  // 视频分镜分析优先；没有分镜时用高光时序的点击峰值时刻作为 title
  const phases: any[] = Array.isArray(d.video_script_summary) ? d.video_script_summary : [];
  let shotTitles: string[] = [];
  let shotTitleSource: MuseInsight['shotTitleSource'] = 'none';
  if (phases.length) {
    shotTitles = phases.map((p) => String(p?.phase_name ?? '').trim()).filter(Boolean);
    shotTitleSource = 'video_script_summary';
  } else {
    const series: any[] = Array.isArray(d.click_time_series) ? d.click_time_series : [];
    if (series.length) {
      shotTitles = series
        .map((x) => ({ sec: Number(x?.sec ?? 0), click: Number(x?.values?.click ?? 0) }))
        .sort((a, b) => b.click - a.click)
        .slice(0, 3)
        .sort((a, b) => a.sec - b.sec)
        .map((x) => `${secToClock(x.sec)}（点击峰值）`);
      shotTitleSource = 'click_time_series';
    }
  }

  const creativeTags: MuseCreativeTag[] = [];
  for (const [key, value] of Object.entries(li)) {
    if (key === 'core_gender' || key === 'core_age') continue;
    const values = strList(value);
    if (!values.length) continue;
    creativeTags.push({ key, label: LABEL_NAMES[key] ?? key, values });
  }

  const fetched = gender.length > 0 || age.length > 0 || shotTitles.length > 0 || creativeTags.length > 0;
  // 素材时长：详情响应里 video.duration / video_duration（秒），用于校验下载到的视频身份
  const rawDur = Number(d?.video?.duration ?? d?.video?.video_duration ?? d?.duration ?? 0);
  const durationSec = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : undefined;
  return {
    fetched,
    gender,
    age,
    shotTitles,
    shotTitleSource,
    creativeTags,
    durationSec,
    note: fetched ? '' : '原网页未提供该素材的人群分析 / 分镜（高光时序）/ 创意标签内容',
    collectedAt: new Date().toISOString(),
  };
}

export function emptyInsight(note: string, creativeId?: string): MuseInsight {
  return { ...EMPTY_INSIGHT, note, creativeId, collectedAt: new Date().toISOString() };
}

/**
 * 取回原网页板块（人群分析 / 视频分镜或高光时序 title / 创意标签），
 * 填充工作台的「视频分析」栏（2026-09-16 由「基本信息」改名）。
 *
 * 采集方式为收割页面自身请求的响应，因此必须在页面导航前用 attachMuseHarvest 挂好、
 * 并把 harvest 传进来（正式抓取链路与自检脚本都这么做）。未传时本函数会自行挂载并
 * 触发一次刷新，仅用于诊断脚本。
 *
 * 采集失败不抛错：返回空值 + 原因，保证主链路（取视频）不受影响。
 */
export async function fetchMuseInsight(opts: {
  page: any;
  url: string;
  /** 页面导航前挂好的收割器 */
  harvest?: MuseHarvest;
  onLog?: (msg: string) => void;
  /** 单次等待窗口 */
  timeoutMs?: number;
}): Promise<MuseInsight> {
  const { page, url } = opts;
  const log = opts.onLog ?? (() => {});
  const creativeId = creativeIdFromUrl(url);
  if (!creativeId) {
    return emptyInsight('该链接无法定位素材 id，未能读取人群/分镜/创意标签板块');
  }

  try {
    const selfAttached = !opts.harvest;
    const h = opts.harvest ?? attachMuseHarvest(page);
    let detail = await harvestWait(h, opts.timeoutMs ?? 8000);

    if (!detail && selfAttached) {
      // 诊断场景：收割器是事后挂的，页面首屏请求已错过，补刷一次触发
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      detail = await harvestWait(h, opts.timeoutMs ?? 15_000);
    }

    if (!detail) {
      return emptyInsight(
        '未能从妙思原网页读到人群分析 / 分镜（高光时序）/ 创意标签板块（页面未返回详情数据），相关字段按空值处理',
        creativeId,
      );
    }

    const insight = parseInsight(detail);
    insight.creativeId = creativeId;

    if (!insight.fetched) {
      insight.note =
        '该素材当前不在可读取的榜单范围内，原网页未返回人群分析 / 分镜（高光时序）/ 创意标签内容，相关字段按空值处理';
      log(
        `板块采集：无内容（creative_id=${creativeId}，${h.detailCount} 条详情响应均为空骨架` +
          `${h.rankingIds.length ? `，ranking_id=${h.rankingIds.join('/')}` : ''}）`,
      );
      return insight;
    }

    log(
      `板块采集：性别 ${insight.gender.join('/') || '空'}；年龄 ${insight.age.join('/') || '空'}；` +
        `分镜/高光 ${insight.shotTitles.length} 项（来源 ${insight.shotTitleSource}）；创意标签 ${insight.creativeTags.length} 项` +
        `${h.accountId ? `（account_id=${h.accountId}）` : ''}`,
    );
    return insight;
  } catch (e) {
    return emptyInsight(`读取人群/分镜/创意标签板块失败（${(e as Error).message}），相关字段按空值处理`, creativeId);
  }
}

/** 供诊断脚本落盘用 */
export function dumpInsight(dir: string, insight: MuseInsight): string {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `insight-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(f, JSON.stringify(insight, null, 2), 'utf8');
  return f;
}

export function insightCacheDir(): string {
  return path.join(cfg.tmpDir, 'muse-insight');
}
