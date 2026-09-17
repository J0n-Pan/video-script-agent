import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cfg } from '../config';
import { fileSize } from '../storage';

/**
 * 腾讯妙思抓取的浏览器层（PRD 10.4）。
 *
 * 登录脚本、诊断脚本、正式适配器共用这里的登录态判定与媒体地址识别，
 * 避免出现「登录脚本认为已登录、抓取脚本认为未登录」这类不一致。
 *
 * playwright 是可选依赖：一律用动态 import，缺失时网页与解析进程照常启动，
 * 只是妙思抓取不可用（降级为保留链接 + 本地补传），不伪装成获取成功。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 媒体响应的判定：扩展名、内容类型、以及常见 CDN 的视频路径特征 */
const MEDIA_EXT_RE = /\.(mp4|m4v|mov|webm|mkv)(?:$|[?#])/i;
const HLS_EXT_RE = /\.m3u8(?:$|[?#])/i;
/**
 * 只把明确的视频/M3U8 内容类型当作媒体。
 * 故意不含 binary/octet-stream —— 妙思不少图片与附件也用该类型返回，
 * 一旦纳入会把图片当视频下载，属于「静默取错文件」，比取不到更糟。
 */
const STRONG_MEDIA_MIME_RE = /^(video\/|application\/(x-mpegurl|vnd\.apple\.mpegurl))/i;

/**
 * 登录墙文案：出现这些说明当前是未登录状态。
 *
 * 踩过的坑：只收「扫码登录 / 立即登录」这批词时，妙思的**登录弹窗**（文案为
 * 「微信扫一扫 / 免注册自动登录 / 登录即代表同意」）完全匹配不到，会被判为「已登录」，
 * 于是继续在页面上挑媒体地址，最终把登录弹窗的装饰视频
 * （`.../media/common/login-dialog-deco-video-*.mp4`，约 9 秒 / 300KB）当成素材下载成功。
 * 因此这里必须覆盖弹窗自己的文案。
 *
 * 刻意不收「关联投放账户 / 未关联投放账户」：已登录的详情页顶部就挂着这条未关联提示，
 * 收进来会把正常页面误判为登录墙。
 */
const LOGIN_WALL_RE =
  /扫码登录|微信扫一扫|微信扫码|请使用微信|免注册自动登录|登录即代表同意|登录后|请先登录|立即登录|授权登录|手机号登录|帐号登录|账号登录|登录\/注册|登录｜注册/;
/**
 * 已登录文案：只取「不登录就不会出现」的账号操作入口。
 * 刻意不收「内容资产」「个人中心」这类导航词——游客态也可能渲染，会误判为已登录。
 */
const LOGGED_IN_RE = /退出登录|退出帐号|退出账号|切换账号|账号管理/;

export type MediaCandidateKind = 'mp4' | 'hls' | 'unknown';

export type MediaCandidate = {
  url: string;
  kind: MediaCandidateKind;
  /** 来源：响应体/响应头/页面元素/接口 JSON，便于排查 */
  from: string;
  contentType?: string;
  /** 响应声明的字节数。没有它无法判断「大文件才是真素材」，故尽力采集 */
  contentLength?: number;
};

export function isMediaUrl(url: string, contentType?: string | null): boolean {
  if (!url) return false;
  if (url.startsWith('blob:') || url.startsWith('data:')) return false;
  if (!/^https?:/i.test(url)) return false;
  if (MEDIA_EXT_RE.test(url) || HLS_EXT_RE.test(url)) return true;
  if (contentType && STRONG_MEDIA_MIME_RE.test(contentType)) return true;
  // 妙思等 CDN 常用无扩展名的视频直链，靠路径特征兜底
  return /\/(video|videos|media|asset)\/.+\/(play|download|stream)/i.test(url);
}

export function classifyCandidate(url: string): MediaCandidateKind {
  if (HLS_EXT_RE.test(url)) return 'hls';
  if (MEDIA_EXT_RE.test(url)) return 'mp4';
  return 'unknown';
}

/**
 * 官网宣传/装饰素材的托管位置，不能当作编导要的素材。
 * 除官网资源域与 banner/avatar 等词外，还包含妙思站内公共目录 `media/common/`
 * （登录弹窗装饰片就在这里，实测被误当成过素材）。
 */
const SITE_ASSET_RE =
  /staticfile\.qq\.com\/creative-market|home-v2-cards|login-dialog|media\/common\/|\/(banner|promo|guide|splash|logo|avatar|loading)\b/i;

/** 站点装饰/宣传素材地址：任何情况下都不得作为素材下载 */
export function isSiteAssetUrl(url: string): boolean {
  return Boolean(url) && SITE_ASSET_RE.test(url);
}

/**
 * 采纳候选的最低分。低于此分说明证据不足（装饰/宣传素材会被 SITE_ASSET_RE 扣到负分，
 * 天然不可能通过）。实测榜单素材的素材本体走无扩展名签名直链，得分是
 * 「无扩展名 6 + video/mp4 8 + 体积≥2MB 30 = 44」，因此下限必须低于 44。
 */
export const MIN_MEDIA_SCORE = 20;

/**
 * 候选打分。妙思素材页上同时存在官网宣传小片、推荐位视频与真正的素材本体，
 * 只按「先出现算赢」会静默下错文件——这比取不到更糟，所以按证据排序并设下限。
 *
 * 证据强弱：容器类型 > 声明的视频类型 > 文件体积 > 素材页自身域名 > 路径含 id。
 * 官网宣传素材（体积小、托管在官网资源域、路径含 banner/avatar 等词）扣分。
 */
export function scoreCandidate(c: MediaCandidate): number {
  let s = 0;
  if (c.kind === 'mp4') s += 20;
  else if (c.kind === 'hls') s += 12;
  else s += 6; // 无扩展名直链：可能是真素材，但没有容器证据
  if (c.contentType && /^video\//i.test(c.contentType)) s += 8;
  if (typeof c.contentLength === 'number') {
    if (c.contentLength >= 2_000_000) s += 30;
    else if (c.contentLength >= 400_000) s += 15;
    else if (c.contentLength < 150_000) s -= 25;
  }
  if (SITE_ASSET_RE.test(c.url)) s -= 40;
  // 主播放器里的那个就是页面正在展示的素材本体，优先级最高
  if (c.from === MAIN_PLAYER) s += 60;
  else if (c.from === '页面 video 元素') s += 4;
  if (/\/[0-9a-f]{16,}(\/|$)/i.test(c.url) || /[?&](id|materialId|creativeId|itemId)=/i.test(c.url)) s += 10;
  return s;
}

/**
 * 取分最高的候选；全部候选都没能拿到正分时返回 null。
 * 返回 null 会走「页面下载入口」兜底，而不是硬下一个小体积宣传片。
 */
export function pickBestCandidate(list: MediaCandidate[]): MediaCandidate | null {
  const seen = new Set<string>();
  const uniq = list.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  let best: MediaCandidate | null = null;
  let bestScore = 0;
  for (const c of uniq) {
    const s = scoreCandidate(c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

/** 候选来源标记：页面主播放器（详情页正在展示的素材本体） */
export const MAIN_PLAYER = '页面主播放器';

/**
 * 找页面主播放器里的视频地址。
 *
 * 必要性：妙思素材详情页会在同一页加载「相关推荐」，且推荐位用的是**同一个播放器组件**，
 * 尺寸也几乎相同 —— 实测详情页 5 个 video 元素面积比仅 1.18，按面积或按出现顺序都会挑错，
 * 静默下成另一个视频。实测可用的判据有两条，按可靠性排序：
 *
 *   1. **正在播放**：详情页会自动播放素材本体，推荐位处于暂停态（实测唯一 playing 的就是本体）；
 *   2. **位置最靠上**：自动播放被浏览器拦截时的退路，本体位于页面内容流最前。
 *
 * 两者实测同时指向同一个元素，互为校验。
 */
export async function findMainVideoUrl(page: any, minArea = 80_000): Promise<string | undefined> {
  try {
    return await page.evaluate(
      (min: number, siteAsset: string) => {
        const assetRe = new RegExp(siteAsset, 'i');
        const cands: Array<{ src: string; area: number; top: number; playing: boolean }> = [];
        document.querySelectorAll('video').forEach((el) => {
          const v = el as HTMLVideoElement;
          const r = v.getBoundingClientRect();
          const area = r.width * r.height;
          if (area < min) return;
          const src = v.currentSrc || v.src;
          if (!src) return;
          // 站点装饰/宣传素材（登录弹窗装饰片等）即使面积最大、正在播放，也不是素材本体
          if (assetRe.test(src)) return;
          cands.push({ src, area, top: r.top, playing: !v.paused });
        });
        if (!cands.length) return undefined;
        const playing = cands.filter((c) => c.playing);
        if (playing.length) return playing.sort((a, b) => b.area - a.area)[0].src;
        return cands.sort((a, b) => a.top - b.top || b.area - a.area)[0].src;
      },
      minArea,
      SITE_ASSET_RE.source,
    );
  } catch {
    return undefined;
  }
}

/**
 * `<video>` 元素的 src 是否可取用。
 *
 * 这里**不能**复用 isMediaUrl：妙思的视频走 `wxsnsencsvp.wxs.qq.com/.../snssvpdownload/...`
 * 这类**无扩展名**的签名直链，按文件名规则会被全部判掉。而 video 元素的 src 本身就是媒体，
 * 只需排除 blob:/data:（本地句柄，下不了）即可。
 */
export function isPlayableSrc(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('blob:') || url.startsWith('data:')) return false;
  if (!/^https?:/i.test(url)) return false;
  // 排除把图片误当视频的情况（部分播放器用 video 标签做封面兜底）
  return !/\.(jpe?g|png|gif|webp|svg|bmp)(?:$|[?#])/i.test(url);
}

/** 从任意 JSON 里递归捞出像视频地址的字符串（接口返回结构不稳定，不做结构性假设） */
export function collectMediaUrlsFromJson(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 60) return out;
  if (typeof value === 'string') {
    if (isMediaUrl(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectMediaUrlsFromJson(v, out, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectMediaUrlsFromJson(v, out, depth + 1);
    }
  }
  return out;
}

export function looksLikeLoginWall(text: string): boolean {
  const t = (text ?? '').slice(0, 4000);
  if (LOGGED_IN_RE.test(t)) return false;
  return LOGIN_WALL_RE.test(t);
}

export function looksLoggedIn(text: string): boolean {
  return LOGGED_IN_RE.test((text ?? '').slice(0, 8000));
}

/**
 * 等待单页应用渲染完成再读页面文字。
 *
 * 必要性：妙思是 hash 路由 SPA，`domcontentloaded` 时 body 尚无内容，
 * `document.body.innerText` 会返回空串 —— 此时判登录态必然误判为「未出现登录引导」。
 */
export async function waitForAppReady(page: any, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready: boolean = await page.evaluate(() => {
        const t = (document.body?.innerText ?? '').trim();
        if (t.length > 20) return true;
        if (/首页|灵感|资产|登录\/注册/.test(t)) return true;
        return Boolean(document.querySelector('video, nav'));
      });
      if (ready) return;
    } catch {
      /* 页面可能正在导航，忽略后重试 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** 会话文件信息（不打印 cookie 值，PRD 11.2） */
export function sessionInfo() {
  const p = cfg.muse.storageState;
  if (!fs.existsSync(p)) return { exists: false as const, path: p, mtime: null as Date | null, cookies: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cookies: number = Array.isArray(raw?.cookies) ? raw.cookies.length : 0;
    return { exists: true as const, path: p, mtime: fs.statSync(p).mtime, cookies };
  } catch {
    return { exists: true as const, path: p, mtime: fs.statSync(p).mtime, cookies: -1 };
  }
}

export async function loadPlaywright(): Promise<any | null> {
  try {
    return await import(/* webpackIgnore: true */ 'playwright' as string);
  } catch {
    return null;
  }
}

export type MuseBrowser = {
  browser: any;
  context: any;
  close: () => Promise<void>;
};

/**
 * 打开一个带登录态的浏览器上下文。
 * 有头模式用于人工扫码登录；无头模式用于解析进程里的自动抓取。
 */
export async function openMuseBrowser(opts: { headless: boolean; storageState?: string | null }): Promise<MuseBrowser> {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('未安装 playwright 运行时，无法打开妙思会话');

  const statePath = opts.storageState === null ? null : (opts.storageState ?? cfg.muse.storageState);
  const browser = await pw.chromium.launch({
    headless: opts.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    storageState: statePath && fs.existsSync(statePath) ? statePath : undefined,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  });
  return {
    browser,
    context,
    close: async () => {
      try {
        await context.close();
      } catch {
        /* 忽略 */
      }
      try {
        await browser.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/** 保存登录态；父目录不存在时自动创建 */
export async function saveStorageState(context: any, dest = cfg.muse.storageState): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await context.storageState({ path: dest });
}

/**
 * 带 cookie 与 referer 下载媒体文件，边下边写盘（避免大文件整块进内存）。
 * cookie 从浏览器上下文取，因此下载走的是同一登录态。
 */
export async function downloadWithContext(
  context: any,
  url: string,
  dest: string,
  referer?: string,
): Promise<{ bytes: number; contentType: string | null }> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const cookies = await context.cookies(url).catch(() => [] as any[]);
  const cookieHeader = (cookies as any[]).map((c) => `${c.name}=${c.value}`).join('; ');
  const res = await fetch(url, {
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(referer ? { referer } : {}),
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      accept: '*/*',
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
  }
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest));
  return { bytes: fileSize(dest), contentType: res.headers.get('content-type') };
}

/**
 * HLS 拼接兜底：妙思若返回 m3u8，用内置 ffmpeg 直接拉流合并为 mp4。
 * 需要把登录 cookie 透传给 ffmpeg，否则切片请求会被拒。
 */
export async function downloadHlsWithFfmpeg(
  ffmpegPath: string,
  m3u8Url: string,
  dest: string,
  cookieHeader: string,
  referer?: string,
): Promise<void> {
  const { execFile } = await import('node:child_process');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const headers = [
    'Origin: https://admuse.qq.com',
    referer ? `Referer: ${referer}` : '',
    cookieHeader ? `Cookie: ${cookieHeader}` : '',
  ]
    .filter(Boolean)
    .join('\r\n');
  await new Promise<void>((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-y',
        '-loglevel', 'error',
        '-headers', headers + '\r\n',
        '-i', m3u8Url,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        dest,
      ],
      { maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).slice(0, 400)));
        else resolve();
      },
    );
  });
  if (fileSize(dest) <= 0) throw new Error('HLS 合并结果为空');
}

/**
 * 等待媒体地址出现。
 *
 * 不采用「第一个出现即返回」——妙思素材页会先加载官网宣传小片，
 * 抢跑会静默下错文件。这里改为收集到足够强的证据才提前返回：
 *   · 分数达到 50（容器 + 声明视频类型 + 体积够大）立即返回；
 *   · 否则继续收集，直到静默一段时间（不再有新候选）或到达超时。
 */
export async function waitForMedia(
  page: any,
  captured: MediaCandidate[],
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<MediaCandidate | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const step = opts.intervalMs ?? 500;
  let lastNewAt = Date.now();
  let seenCount = captured.length;

  while (Date.now() < deadline) {
    // 第一优先：页面主播放器。详情页同时挂着相关推荐，只有主播放器才是素材本体
    const mainUrl = await findMainVideoUrl(page);
    if (mainUrl && !isSiteAssetUrl(mainUrl)) {
      let hit = captured.find((c) => c.url === mainUrl);
      if (!hit) {
        hit = { url: mainUrl, kind: classifyCandidate(mainUrl), from: MAIN_PLAYER };
        captured.push(hit);
      }
      // 主播放器也要过分数下限：站点装饰素材加了 MAIN_PLAYER 分也可能「看起来合格」，
      // 唯一可靠的做法是分数与黑名单双门禁，任一不过就不采纳
      if (scoreCandidate(hit) >= MIN_MEDIA_SCORE) return hit;
    }

    const best = pickBestCandidate(captured);
    if (best && scoreCandidate(best) >= MIN_MEDIA_SCORE) return best;

    // 页面元素里的地址也要轮询：部分素材是 SSR 直出、不产生媒体请求
    try {
      const domUrls: string[] = await page.evaluate(() => {
        const out: string[] = [];
        document.querySelectorAll('video, video source').forEach((el) => {
          const src = (el as HTMLVideoElement).currentSrc || (el as HTMLVideoElement).src || (el as HTMLSourceElement).src;
          if (src) out.push(src);
        });
        return out;
      });
      for (const u of domUrls) {
        if (isPlayableSrc(u) && !captured.some((c) => c.url === u)) {
          captured.push({ url: u, kind: classifyCandidate(u), from: '页面 video 元素' });
        }
      }
    } catch {
      /* 页面可能正在导航，忽略后继续轮询 */
    }

    if (captured.length !== seenCount) {
      seenCount = captured.length;
      lastNewAt = Date.now();
    }

    const current = pickBestCandidate(captured);
    // 已有正分候选且网络静默 4 秒，认为素材地址已收集完整
    if (current && Date.now() - lastNewAt >= 4000) return current;

    await new Promise((r) => setTimeout(r, step));
  }
  return pickBestCandidate(captured);
}

/** 轻推播放：部分素材的地址只在触发播放后才产生请求 */
export async function nudgePlay(page: any): Promise<void> {
  try {
    await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement | null;
      if (v) {
        try {
          v.muted = true;
          void v.play();
        } catch {
          /* 自动播放可能被拦截，不影响后续兜底 */
        }
      }
      // 悬停态才出现的播放按钮
      document.querySelectorAll('[class*="play"], [aria-label*="播放"]').forEach((el) => {
        try {
          (el as HTMLElement).click();
        } catch {
          /* 忽略 */
        }
      });
    });
  } catch {
    /* 页面正在导航时忽略 */
  }
}

/** 素材标题：优先取页面内可见标题，取不到就返回 undefined，不用站点名冒充 */
const SITE_TITLES = new Set(['腾讯妙思', '腾讯妙思 - 营销内容AIGC创作平台', '妙思']);

/**
 * 页面内标题节点探测（2026-09-16 实测确认）。
 *
 * 妙思素材详情页没有 h1/h2，站点 <title> 是「腾讯妙思 - 营销内容AIGC创作平台」，
 * 所以旧写法（找 assetName / h1 / h2 再退到站点标题）在真实素材上**一律返回 undefined**，
 * 表现为任务标题与「原视频标题」总是「未提供」。
 *
 * 实测：素材标题是页面上唯一一个 **计算字号 20px + 字重 500 + 内联 font-family 为 PingFangSC**
 * 的节点（两条不同素材均成立）。同页的指标数字（4W+、1%-3%、22.78s）字号字重相同，
 * 但内联字体是 ODNumber，必须排除。
 *
 * 这段必须以字符串形式传给 page.evaluate：本项目用 tsx 运行，函数体内会被注入 __name 辅助变量，
 * 在页面上下文里会报 `__name is not defined`。
 */
const TITLE_PROBE = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const nodes = document.querySelectorAll('div,span,h1,h2,h3,p');
  const ellipsis = [];
  const plain = [];
  for (const el of nodes) {
    const cs = getComputedStyle(el);
    if (cs.fontSize !== '20px') continue;
    if (cs.fontWeight !== '500' && cs.fontWeight !== 'medium') continue;
    if (String(el.className || '').indexOf('ODNumber') >= 0) continue;
    const style = String(el.getAttribute('style') || '');
    if (style.indexOf('ODNumber') >= 0) continue;
    const t = clean(el.textContent);
    if (t.length < 2 || t.length > 120) continue;
    if (style.indexOf('text-overflow: ellipsis') >= 0) ellipsis.push(t);
    else plain.push(t);
  }
  const legacy = [];
  for (const s of ['[class*="assetName"]', '[class*="videoName"]', '[class*="materialName"]', '[class*="detailTitle"]', 'h1', 'h2']) {
    const el = document.querySelector(s);
    const t = clean(el ? el.textContent : '');
    if (t.length >= 2 && t.length <= 120) legacy.push(t);
  }
  return { ellipsis: ellipsis, plain: plain, legacy: legacy, docTitle: document.title };
})()`;

export async function readMaterialTitle(page: any): Promise<string | undefined> {
  try {
    const probe: {
      ellipsis?: string[];
      plain?: string[];
      legacy?: string[];
      docTitle?: string;
    } = await page.evaluate(TITLE_PROBE);
    const candidates = [
      ...(probe.ellipsis ?? []),
      ...(probe.plain ?? []),
      ...(probe.legacy ?? []),
      probe.docTitle ?? '',
    ];
    for (const c of candidates) {
      const t = (c ?? '').trim();
      if (t && !SITE_TITLES.has(t)) return t;
    }
  } catch {
    /* 忽略 */
  }
  return undefined;
}

/** 取当前上下文在该地址下的 cookie 头（用于 ffmpeg 拉 HLS 时透传登录态） */
export async function cookieHeaderFor(context: any, url: string): Promise<string> {
  const cookies = await context.cookies(url).catch(() => [] as any[]);
  return (cookies as any[]).map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * 兜底下载：点页面上的「下载」按钮并接收浏览器下载事件。
 * 妙思若在弹窗里还要再确认一次分辨率/格式，这里会顺带点一次确认。
 *
 * 这一步走的是浏览器自身登录态与自身下载逻辑，因此比直接拉地址更耐页面改版；
 * 缺点依赖按钮文案，所以只作为第二级兜底，失败不会伪装成功。
 */
export async function tryBrowserDownload(page: any, dest: string, timeoutMs: number): Promise<boolean> {
  const clickByText = async (source: string): Promise<boolean> =>
    page
      .evaluate((pattern: string) => {
        const rx = new RegExp(pattern);
        const nodes = Array.from(document.querySelectorAll('button, a, div[role="button"], span')) as HTMLElement[];
        const target = nodes.find((el) => {
          const t = (el.textContent ?? '').trim();
          return el.offsetParent !== null && t.length <= 12 && rx.test(t);
        });
        if (!target) return false;
        target.click();
        return true;
      }, source)
      .catch(() => false);

  const dlPromise = page.waitForEvent('download', { timeout: timeoutMs }).catch(() => null);
  const clicked = await clickByText('^(下载|下载视频|导出|保存)$');
  if (!clicked) {
    await dlPromise; // 放掉等待，避免悬挂
    return false;
  }
  // 弹窗里的二次确认
  await new Promise((r) => setTimeout(r, 1500));
  await clickByText('^(确定|确认|开始下载|下载)$');
  const dl = await dlPromise;
  if (!dl) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await dl.saveAs(dest);
  return true;
}

/** 按可见文案精确点击（诊断用：切页签、展开面板） */
export async function clickByExactText(page: any, text: string): Promise<boolean> {
  return page
    .evaluate((txt: string) => {
      const nodes = Array.from(
        document.querySelectorAll('button, a, div[role="button"], li, span, div'),
      ) as HTMLElement[];
      const target = nodes.find((el) => {
        const t = (el.textContent ?? '').trim();
        return t === txt && el.offsetParent !== null;
      });
      if (!target) return false;
      target.click();
      return true;
    }, text)
    .catch(() => false);
}

export type MuseInspection = {
  /** 命中的候选媒体地址（含来源，便于排查） */
  candidates: MediaCandidate[];
  /** 最佳候选（可直接下载的那个） */
  best: MediaCandidate | null;
  title?: string;
  /** 是否出现登录引导（即登录态已失效） */
  loginWall: boolean;
  /** 是否真的进到了目标素材详情页：链接里的素材 id 是否出现在最终地址里 */
  materialReached: boolean;
  /** 因分数不够被丢弃的候选（通常是站点装饰/宣传素材），用于给失败原因留证据 */
  rejectedBest: MediaCandidate | null;
  finalUrl: string;
  pageTitle: string;
  /** 页面 video 元素的原始 src（可能是 blob:，仅作证据） */
  videoSrcs: string[];
  /** 页面上可见的操作按钮文案，用于定位「下载」入口 */
  visibleActions: string[];
  bodySnippet: string;
};

/**
 * 打开素材页并捕获媒体地址。正式抓取与诊断脚本共用同一实现，
 * 因此 `muse:probe` 的结论与解析进程内的真实行为一致。
 */
export async function inspectMusePage(opts: {
  page: any;
  url: string;
  navTimeoutMs: number;
  waitMs: number;
  /** 打开后先依次点击这些文案（用于切换「成品库/原料库」等页签），诊断排查用 */
  clicks?: string[];
}): Promise<MuseInspection> {
  const { page, url, navTimeoutMs, waitMs, clicks } = opts;
  const candidates: MediaCandidate[] = [];

  page.on('response', async (res: any) => {
    try {
      const resUrl: string = res.url();
      const headers: Record<string, string> = res.headers?.() ?? {};
      const ct: string | null = headers['content-type'] ?? null;
      if (isMediaUrl(resUrl, ct)) {
        const len = Number(headers['content-length']);
        candidates.push({
          url: resUrl,
          kind: classifyCandidate(resUrl),
          from: '网络媒体响应',
          contentType: ct ?? undefined,
          contentLength: Number.isFinite(len) && len > 0 ? len : undefined,
        });
        return;
      }
      if (/json/i.test(ct ?? '')) {
        const body = await res.json().catch(() => null);
        if (body) {
          for (const f of collectMediaUrlsFromJson(body)) {
            candidates.push({ url: f, kind: classifyCandidate(f), from: '接口 JSON' });
          }
        }
      }
    } catch {
      /* 响应体可能已被消费或非 JSON，忽略 */
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
  // SPA 首帧 body 为空，必须等渲染完成，否则登录态会被误判
  await waitForAppReady(page);

  if (clicks?.length) {
    for (const text of clicks) {
      await clickByExactText(page, text);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  const bodySnippet: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const loginWall = looksLikeLoginWall(bodySnippet);

  let best: MediaCandidate | null = null;
  // 已判定为登录墙时不再空等媒体地址：没登录看不到素材，等下去只是白耗时间
  if (!loginWall) {
    await nudgePlay(page);
    best = await waitForMedia(page, candidates, { timeoutMs: waitMs });
    if (!best) {
      // 仍未命中：再触发一次播放/展开，给懒加载留出时间
      await nudgePlay(page);
      best = await waitForMedia(page, candidates, { timeoutMs: Math.min(10_000, waitMs) });
    }
  }

  const landed = page.url();
  const materialReached = landedReachesMaterial(url, landed);

  // 分数门禁：拿到的只是装饰/宣传素材时宁可判为没取到，绝不伪装成功
  let rejectedBest: MediaCandidate | null = null;
  if (best && scoreCandidate(best) < MIN_MEDIA_SCORE) {
    rejectedBest = best;
    best = null;
  }

  const videoSrcs: string[] = await page
    .evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('video, video source').forEach((el) => {
        const src =
          (el as HTMLVideoElement).currentSrc || (el as HTMLVideoElement).src || (el as HTMLSourceElement).src;
        if (src) out.push(src);
      });
      return out;
    })
    .catch(() => []);

  const visibleActions: string[] = await page
    .evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('button, a, div[role="button"]').forEach((el) => {
        const t = (el.textContent ?? '').trim();
        if (t && t.length <= 12 && (el as HTMLElement).offsetParent !== null) out.push(t);
      });
      return Array.from(new Set(out)).slice(0, 30);
    })
    .catch(() => []);

  const title = await readMaterialTitle(page);

  return {
    candidates,
    best,
    title,
    loginWall,
    materialReached,
    rejectedBest,
    finalUrl: landed,
    pageTitle: await page.title().catch(() => ''),
    videoSrcs,
    visibleActions,
    bodySnippet: bodySnippet.slice(0, 1500),
  };
}

/** 从素材链接里取素材标识（长数字或长十六进制），取不到返回空串 */
export function materialKeyFromUrl(url: string): string {
  const tail = `${url.split('#')[1] ?? ''}${url.split('?')[1] ?? ''}`;
  const m = /([0-9a-f]{16,}|\d{8,})/i.exec(tail);
  return m ? m[1] : '';
}

/**
 * 链接打开后是否真的落在目标素材上。
 *
 * 必要性：妙思在登录态失效时会把详情页**弹回首页**（`#/index`）并弹登录框，
 * 此时页面上的媒体地址全是站点装饰素材。只看「有没有登录文案」会被弹窗文案绕过，
 * 因此再补一条结构性判据：最终地址里必须还带着素材 id。
 */
export function landedReachesMaterial(requestedUrl: string, landedUrl: string): boolean {
  const key = materialKeyFromUrl(requestedUrl);
  if (!key) return true; // 链接本身没带可识别的素材标识，不做这项判断
  return landedUrl.includes(key);
}
