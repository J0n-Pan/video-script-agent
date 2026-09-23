import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { fmtLocal } from '../datetime';
import {
  detectLoggedInDom,
  looksLikeLoginWall,
  looksLoggedIn,
  openMuseBrowser,
  sessionInfo,
  waitForAppReady,
} from './muse-browser';
import {
  museControlPath,
  museHealthPath,
  museLoginOwnerPath,
  museLoginStatusPath,
  museQrPath,
  museStatePath,
} from './muse-session-paths';

/**
 * 妙思登录态健康状态（2026-09-20 需求迭代；2026-09-22 改为**按用户隔离**）。
 *
 * ## 为什么需要这个
 *
 * 2026-09-20 的故障：妙思登录态在 09-17 之后过期，用户仍能提交妙思链接，
 * 任务一路跑到 SAVE 阶段才失败（3 次尝试、开浏览器、耗时约 14 分钟），
 * 用户看到的是「主机视频副本不可用（尚未获取成功或被清理）」——
 * 完全看不出真正原因是登录态过期。
 *
 * ## 为什么不直接发 HTTP 请求问妙思
 *
 * 做不到。妙思接口有 CSRF 校验，除 `x-csrf-token` 外还要前端 SDK 现算的 `x-sign`，
 * 即使把头部补全也一律返回 `{"code":221010,"message":"csrf check invalid"}`
 * （见 `muse-insight.ts` 顶部注释，已有实测）。因此唯一可信的判据是
 * 「真实浏览器渲染后读页面文案」，即 `LOGIN_WALL_RE` / `LOGGED_IN_RE`。
 *
 * ## 三层信号，按成本分级
 *
 * - L0 免费：抓取结果本身。失败即失效、成功即有效（`markFromFetch`），零成本且最真实。
 * - L1 免费：`sessionInfo()`。文件不存在 → 必然失效（`MISSING`），可零成本定罪。
 * - L2 付费：真实探测（`probeMuseSession`），约 10 秒 + 一个 Chromium。
 *   **这是唯一能「提前」发现失效的手段** —— L0 要等失败一次才知道。
 *
 * 探测由解析进程（worker）独占执行并写盘，web 只读这个文件：
 * Chromium 只有一个所有者，且 web 请求不会被阻塞 10 秒。
 *
 * ## 2026-09-22：每个函数都要带 userId
 *
 * 会话不再全局共享 —— 每个编导扫自己的腾讯妙思账号。因此：
 *   - `data/muse-session/users/<userId>/` 下各有独立的
 *     state / health / control / login-status / qr（路径统一由 muse-session-paths 提供）；
 *   - 所有读写函数**第一个参数都是 userId**，且**没有默认值** ——
 *     这是刻意的：默认值会让「忘了传」静默退化成「操作了别人的会话」，
 *     而这类 bug 在界面上看起来完全正常（读到了另一份结论）。
 */

export type MuseHealthStatus = 'VALID' | 'EXPIRED' | 'MISSING' | 'UNKNOWN' | 'FETCH_DISABLED';

/** 结论的来源，用于在界面上说明「这个结论有多可信」 */
export type MuseHealthSource = 'PROBE' | 'FETCH_OK' | 'FETCH_FAIL' | 'NONE';

export type MuseHealth = {
  status: MuseHealthStatus;
  /** ISO 时间；从未检测过为 null */
  checkedAt: string | null;
  source: MuseHealthSource;
  /** 面向编导的一句话说明 */
  message: string;
  /** 会话文件更新时间，帮助判断「是不是从没登录过」 */
  sessionMtime: string | null;
  cookieCount: number;
  /**
   * 会话类 cookie 里最晚的到期时间（ISO）。
   * 实测 2026-09-20：state.json 里 admuse_token / creative_center_token / gdt_token
   * 均带明确到期时间，因此这是**零成本且精确**的判据，不必开浏览器。
   */
  sessionExpiresAt?: string | null;
  /** 探测耗时（毫秒），仅 source=PROBE 有 */
  costMs?: number;
};

/** 登录态相关 cookie 名：只用于判定与展示名字，绝不打印取值 */
export const SESSION_COOKIE_RE = /uin|skey|token|ticket|sid|session|pass|login|ams|adq|auth/i;

/** 同一次探测结论的有效期：避免「任务列表 ↔ 导出 ↔ IP 资料包」来回点就反复花 10 秒 */
const TTL_DEFAULT_MS = 15 * 60 * 1000;

/** 某用户的会话目录 */
export function userSessionDir(userId: string): string {
  return path.dirname(museStatePath(userId));
}

export function healthPath(userId: string): string {
  return museHealthPath(userId);
}

/** 控制文件：web 写请求，worker 读取并执行（单向，避免两端互相调用） */
export function controlPath(userId: string): string {
  return museControlPath(userId);
}

export function loginStatusPath(userId: string): string {
  return museLoginStatusPath(userId);
}

/** 二维码图片落盘位置（worker 写，web 读并发给浏览器） */
export function qrPath(userId: string): string {
  return museQrPath(userId);
}

export function healthTtlMs(): number {
  // 注意 `Number('')` 等于 0：环境变量没配时若不做空值判断，
  // TTL 会变成 0 → 结论永远「已过期」→ 每次打开页面都投一次探测。
  // 实测踩过：日志里出现 18 次探测，远超设计的 1~2 次。
  const raw = (process.env.MUSE_HEALTH_TTL_MS ?? '').trim();
  if (!raw) return TTL_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : TTL_DEFAULT_MS;
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const EMPTY: MuseHealth = {
  status: 'UNKNOWN',
  checkedAt: null,
  source: 'NONE',
  message: '尚未检测妙思登录态。',
  sessionMtime: null,
  cookieCount: 0,
  sessionExpiresAt: null,
};

export function readHealth(userId: string): MuseHealth {
  const h = readJson<MuseHealth>(healthPath(userId));
  if (!h || typeof h.status !== 'string') return { ...EMPTY };
  return {
    status: h.status,
    checkedAt: h.checkedAt ?? null,
    source: h.source ?? 'NONE',
    message: h.message ?? '',
    sessionMtime: h.sessionMtime ?? null,
    cookieCount: Number(h.cookieCount ?? 0),
    sessionExpiresAt: h.sessionExpiresAt ?? null,
    costMs: h.costMs,
  };
}

export function writeHealth(userId: string, h: MuseHealth): MuseHealth {
  writeJsonAtomic(healthPath(userId), h);
  return h;
}

/** 登录态是否「需要人工处理」——决定横幅是否出现 */
export function needsAttention(h: MuseHealth): boolean {
  // 2026-09-23 补：抓取开关关着时也必须弹横幅。
  // 故障背景：出厂默认曾是 MUSE_FETCH_ENABLED=false，此时 probe 早退写 UNKNOWN，
  // 而这里只认 EXPIRED/MISSING → 横幅不渲染 → 编导粘链接必然失败、
  // 界面上却**没有任何修复入口**（连「去扫码登录」按钮都不出现），只能无路可走。
  // 所以「功能被关掉」本身就是最该让人看见的状态。
  if (h.status === 'FETCH_DISABLED') return true;
  return h.status === 'EXPIRED' || h.status === 'MISSING';
}

/** 结论是否已过期，需要重新探测 */
export function isHealthStale(h: MuseHealth, now = Date.now()): boolean {
  if (!h.checkedAt) return true;
  const t = Date.parse(h.checkedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > healthTtlMs();
}

/**
 * 会话类 cookie 里最晚的到期时间（毫秒时间戳）。
 *
 * 取「最晚」而不是「最早」是刻意的保守选择：只要还有任何一条会话类 cookie 未到期，
 * 就不能断言会话一定失效 —— 否则会误拦本来能成功的抓取。
 * 只有当**最晚的一条都已过期**，才可以零成本定罪。
 */
function latestSessionCookieExpiry(userId: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(museStatePath(userId), 'utf8'));
    const cookies = (raw?.cookies ?? []) as Array<{ name: string; expires?: number }>;
    const times = cookies
      .filter((c) => SESSION_COOKIE_RE.test(c.name))
      .map((c) => Number(c.expires ?? 0))
      .filter((t) => Number.isFinite(t) && t > 0)
      .map((t) => t * 1000);
    if (!times.length) return null; // 全是会话级 cookie（无到期时间），无法据此判断
    return Math.max(...times);
  } catch {
    return null;
  }
}

function base(userId: string): Pick<MuseHealth, 'sessionMtime' | 'cookieCount' | 'sessionExpiresAt'> {
  const info = sessionInfo(museStatePath(userId));
  const expiresAt = latestSessionCookieExpiry(userId);
  return {
    sessionMtime: info.mtime ? info.mtime.toISOString() : null,
    cookieCount: info.exists && info.cookies > 0 ? info.cookies : 0,
    sessionExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  };
}

function shortTime(iso: string | null | undefined): string {
  return fmtLocal(iso) || '未知';
}

/**
 * L1：零成本判据。按强弱依次判定，能定罪就不去开浏览器。
 *
 * 返回 null 表示「文件在、也没法零成本定罪」——此时仍需 L2 探测。
 * 尤其注意：**不能因为文件存在就报 VALID**（09-20 故障正是文件一直在、会话早已失效）。
 */
export function checkSessionFile(userId: string): MuseHealth | null {
  const info = sessionInfo(museStatePath(userId));
  const b = base(userId);

  if (!info.exists) {
    return writeHealth(userId, {
      status: 'MISSING',
      checkedAt: new Date().toISOString(),
      source: 'NONE',
      message: '你还没有登录腾讯妙思。请扫码登录，或对单条任务使用本地补传。',
      ...b,
    });
  }
  if (info.cookies === 0) {
    return writeHealth(userId, {
      status: 'MISSING',
      checkedAt: new Date().toISOString(),
      source: 'NONE',
      message: '腾讯妙思会话文件里没有 cookie，等同于未登录。请重新扫码登录。',
      ...b,
    });
  }

  // 会话 cookie 自带到期时间：连最晚的一条都已过期即必然失效，零成本且精确
  const expiresAt = latestSessionCookieExpiry(userId);
  if (expiresAt !== null && expiresAt < Date.now()) {
    return writeHealth(userId, {
      status: 'EXPIRED',
      checkedAt: new Date().toISOString(),
      source: 'NONE',
      message: `你的腾讯妙思会话已于 ${shortTime(b.sessionExpiresAt)} 过期。此时提交妙思链接会在抓取阶段失败（脚本文字与来源信息不受影响）。`,
      ...b,
    });
  }

  return null;
}

/**
 * L2：真实探测。无头打开妙思首页，判定登录态。
 *
 * 判据优先级（实测 2026-09-20）：
 *   1. **DOM 权威标识**：已登录时导航右上角存在
 *      `.ms-global-feature-user--logged-in`（内含微信头像）→ 直接 VALID。
 *      必须优先走这条 —— `LOGGED_IN_RE` 那几个词只在账号菜单展开后才在 DOM 里，
 *      只看文字会把**有效会话判成 UNKNOWN**（已实测踩到）。
 *   2. 未登录：游客态首页可浏览，导航挂着「登录/注册」→ `LOGIN_WALL_RE` 命中 → EXPIRED。
 *      已登录时该入口消失，所以「无登录引导」在游客态不构成证据。
 *   3. 两者都不命中 → UNKNOWN，不武断宣称失效（避免网络异常/改版时误报吓人）。
 */
export async function probeMuseSession(userId: string): Promise<MuseHealth> {
  const b = base(userId);

  // 顺序很关键：**先判开关，再判会话文件**。
  // 若颠倒，未登录时 checkSessionFile 会先返回 MISSING，横幅照常弹，
  // 但给编导指的路是「去扫码登录」—— 而开关关着时扫完依然失败，是条死路。
  // 换句话说：功能没开的时候，让他去扫码是误导。
  if (!cfg.muse.fetchEnabled) {
    // 用独立状态而不是 UNKNOWN：UNKNOWN 的语义是「探不出结论、不必打扰用户」，
    // 而这里是「功能被关掉了、必须打扰用户」——两者混用会让横幅静默（09-23 故障）。
    return writeHealth(userId, {
      status: 'FETCH_DISABLED',
      checkedAt: new Date().toISOString(),
      source: 'PROBE',
      message:
        '妙思链接抓取功能未启用（MUSE_FETCH_ENABLED=false）：粘妙思链接会被直接拒绝，只能走本地补传。' +
        '请让维护人员把程序配置里的 MUSE_FETCH_ENABLED 改为 true 并重启工作台。',
      ...b,
    });
  }

  const fileVerdict = checkSessionFile(userId);
  if (fileVerdict) return fileVerdict;

  const started = Date.now();

  let browser: Awaited<ReturnType<typeof openMuseBrowser>> | null = null;
  try {
    browser = await openMuseBrowser({ headless: true, storageState: museStatePath(userId) });
    const page = await browser.context.newPage();
    await page.goto(cfg.muse.loginUrl, { waitUntil: 'domcontentloaded', timeout: cfg.muse.navTimeoutMs });
    await waitForAppReady(page);

    // ① DOM 权威标识优先
    const loggedInDom = await detectLoggedInDom(page);
    const text: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const wall = looksLikeLoginWall(text);
    const loggedText = looksLoggedIn(text);
    const costMs = Date.now() - started;

    if (loggedInDom) {
      return writeHealth(userId, {
        status: 'VALID',
        checkedAt: new Date().toISOString(),
        source: 'PROBE',
        message: '你的妙思登录态有效，可直接抓取妙思链接。',
        costMs,
        ...b,
      });
    }
    if (loggedText) {
      return writeHealth(userId, {
        status: 'VALID',
        checkedAt: new Date().toISOString(),
        source: 'PROBE',
        message: '你的妙思登录态有效，可直接抓取妙思链接。',
        costMs,
        ...b,
      });
    }
    if (wall) {
      return writeHealth(userId, {
        status: 'EXPIRED',
        checkedAt: new Date().toISOString(),
        source: 'PROBE',
        message: '你的腾讯妙思登录态已过期。此时提交妙思链接会在抓取阶段失败（脚本文字与来源信息不受影响）。',
        costMs,
        ...b,
      });
    }
    return writeHealth(userId, {
      status: 'UNKNOWN',
      checkedAt: new Date().toISOString(),
      source: 'PROBE',
      message: `无法确认妙思登录态（页面既无已登录账号区，也无登录引导；页面文字 ${
        text.trim().length
      } 字）。上次会话文件更新于 ${fmtLocal(b.sessionMtime) || '未知'}。`,
      costMs,
      ...b,
    });
  } catch (e) {
    return writeHealth(userId, {
      status: 'UNKNOWN',
      checkedAt: new Date().toISOString(),
      source: 'PROBE',
      message: `妙思登录态探测失败（不影响其它来源的任务）：${(e as Error).message}`,
      costMs: Date.now() - started,
      ...b,
    });
  } finally {
    await browser?.close();
  }
}

/** L0：把一次真实抓取的结果当作免费判据写回 */
export function markFromFetch(userId: string, outcome: 'OK' | 'SESSION_EXPIRED', message = ''): MuseHealth {
  const b = base(userId);
  if (outcome === 'OK') {
    return writeHealth(userId, {
      status: 'VALID',
      checkedAt: new Date().toISOString(),
      source: 'FETCH_OK',
      message: '最近一次妙思抓取成功，登录态有效。',
      ...b,
    });
  }
  return writeHealth(userId, {
    status: 'EXPIRED',
    checkedAt: new Date().toISOString(),
    source: 'FETCH_FAIL',
    message:
      message ||
      '最近一次妙思抓取因登录态失效而失败。请重新扫码登录，或对单条任务使用本地补传。',
    ...b,
  });
}

export type MuseControl = {
  /** web 请求探测的时间戳；worker 处理后会原样写回 ackedProbeAt */
  probeRequestedAt?: string;
  ackedProbeAt?: string;
  /** web 请求开始扫码登录 */
  loginRequestedAt?: string;
  /** 发起人（显示名），写进登录状态便于排查是谁触发的 */
  loginRequestedBy?: string;
  /**
   * 本次登录是否强制（不带已有登录态启动）。
   *
   * 用途：登录态看起来有效、但要**换一个微信号**时，必须强制打开登录入口 ——
   * 已登录状态下导航里没有「登录/注册」，点不出二维码。
   * 强制登录只在成功扫码后才覆盖会话文件，取消/超时不会动它。
   */
  loginForce?: boolean;
  /** web 请求取消正在进行的登录 */
  loginCancelAt?: string;
};

export function readControl(userId: string): MuseControl {
  return readJson<MuseControl>(controlPath(userId)) ?? {};
}

export function writeControl(userId: string, patch: Partial<MuseControl>): MuseControl {
  const next = { ...readControl(userId), ...patch };
  writeJsonAtomic(controlPath(userId), next);
  return next;
}

/* ────────────── 扫码登录进度（worker 写，web 读） ────────────── */

export type MuseLoginPhase = 'IDLE' | 'STARTING' | 'WAITING_SCAN' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

export type MuseLoginStatus = {
  phase: MuseLoginPhase;
  startedAt: string | null;
  updatedAt: string | null;
  /** 二维码图片的更新时间，用于前端判断要不要刷新图片（防缓存） */
  qrAt: string | null;
  message: string;
  /** 二维码有效期到期时间（前端显示倒计时） */
  qrExpiresAt: string | null;
  /** 由谁发起，便于排查 */
  startedBy?: string;
  /**
   * 排队信息：解析进程同一时刻只能开一个浏览器，因此同时只有一个人能扫码。
   * 这条存在时表示「你的请求已受理，正在等前面的人扫完」。
   */
  queuedBehind?: string;
};

export const IDLE_LOGIN: MuseLoginStatus = {
  phase: 'IDLE',
  startedAt: null,
  updatedAt: null,
  qrAt: null,
  message: '当前没有进行中的扫码登录。',
  qrExpiresAt: null,
};

export function readLoginStatus(userId: string): MuseLoginStatus {
  const s = readJson<MuseLoginStatus>(loginStatusPath(userId));
  if (!s || typeof s.phase !== 'string') return { ...IDLE_LOGIN };
  return { ...IDLE_LOGIN, ...s };
}

export function writeLoginStatus(userId: string, patch: Partial<MuseLoginStatus>): MuseLoginStatus {
  const next: MuseLoginStatus = { ...readLoginStatus(userId), ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(loginStatusPath(userId), next);
  return next;
}

/**
 * 「当前谁在扫」的全局占位（不是按用户的）——它描述的是**唯一那台 Chromium 的占用者**。
 *
 * 存在的意义只有一个：让排队的人看到一句准确的话
 * （「前面 张三 正在扫码，请稍候」），而不是盯着「正在打开登录页…」猜是不是卡了。
 */
export type MuseLoginOwner = {
  userId: string;
  displayName: string;
  startedAt: string;
};

export function readLoginOwner(): MuseLoginOwner | null {
  return readJson<MuseLoginOwner>(museLoginOwnerPath());
}

export function writeLoginOwner(v: MuseLoginOwner | null): void {
  const p = museLoginOwnerPath();
  if (v === null) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* 不存在即已清空 */
    }
    return;
  }
  writeJsonAtomic(p, v);
}
