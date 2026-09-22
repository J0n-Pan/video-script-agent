import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import {
  detectLoggedInDom,
  looksLikeLoginWall,
  looksLoggedIn,
  openMuseBrowser,
  saveStorageState,
  waitForAppReady,
} from './muse-browser';
import { markFromFetch, SESSION_COOKIE_RE } from './muse-health';
import { museStatePath } from './muse-session-paths';

/**
 * 腾讯妙思扫码登录流程（可复用实现）。
 *
 * 由两个调用方共用，保证只有一份逻辑：
 *   - `scripts/muse-login.ts`：命令行版（有头浏览器 + 终端），给维护人员在终端里用
 *   - `src/worker/muse-service.ts`：工作台版（无头浏览器），二维码取出来交给网页显示
 *
 * ## 二维码怎么拿到（2026-09-20 实测结论）
 *
 * 二维码不在妙思页面本体里，而在**跨域 iframe**
 * `open.weixin.qq.com/connect/qrconnect?appid=...` 内，是一个普通
 * `<img class="js_qrcode_img" src="/connect/qrcode/<ticket>">`（136x136）。
 *
 * 这个地址直接 fetch 即返回高清 JPEG（实测 47291 字节），**不需要 cookie、不需要 Referer**。
 * 所以这里「取图片地址再自己拉」而不是「元素截图」—— 实测内层 img 元素截图会 30 秒超时，
 * 外层 iframe 截图虽然可用但清晰度差且带周边留白。
 *
 * ## 一个容易走错的方向（务必不要改回去）
 *
 * 不能把微信那个 iframe 地址直接嵌进工作台页面让用户扫：
 * 那样扫码后 cookie 会写进**用户自己的浏览器**，
 * 而抓取用的是 Playwright 上下文 —— `state.json` 拿不到会话，抓取照样失败。
 * 必须由本流程在 Playwright 上下文里持有登录，只把二维码**图片**给前端看。
 */

/** 微信二维码 ticket 有效期偏短，超过这个时间就主动刷新一次，避免用户扫到「已失效」的码 */
const QR_REFRESH_MS = 240_000;

type Cookie = { name: string; value?: string; domain?: string; expires?: number };

export type MuseLoginHooks = {
  onLog?: (line: string) => void;
  /** 阶段变化（写状态文件 / 打印） */
  onPhase?: (phase: 'STARTING' | 'WAITING_SCAN' | 'SUCCESS' | 'FAILED' | 'CANCELLED', message: string) => void;
  /** 拿到新二维码（worker 落盘，CLI 忽略） */
  onQr?: (jpeg: Buffer, meta: { src: string; expiresAt: string }) => void;
  /** 返回 true 即中止本次登录（web 端点取消 / 进程退出） */
  shouldCancel?: () => boolean;
  /** 终端版的手动保存通道：返回 true 视为「我已登录」 */
  manualSignal?: () => boolean;
};

export type MuseLoginResult = {
  ok: boolean;
  message: string;
  /** 会话类 cookie（只含名称与域名，不含取值） */
  sessionCookies: Array<{ name: string; domain?: string; expires?: number }>;
};

/** 点开登录弹窗。已登录时页面上没有这个入口，返回 false（不是错误） */
async function openLoginDialog(page: any, log: (s: string) => void): Promise<boolean> {
  const probe = `(() => {
    const wants = ['登录/注册', '登录', '立即登录'];
    const cands = [];
    for (const el of document.querySelectorAll('button,a,div,span')) {
      const t = (el.textContent || '').trim();
      if (wants.indexOf(t) < 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      cands.push({ el: el, area: r.width * r.height });
    }
    if (!cands.length) return false;
    cands.sort((a, b) => a.area - b.area);
    cands[0].el.click();
    return true;
  })()`;
  try {
    const clicked: boolean = await page.evaluate(probe);
    if (clicked) log('已点击「登录/注册」，等待二维码');
    return clicked;
  } catch {
    return false;
  }
}

/** 取微信帧与帧内二维码图片的原生地址 */
async function grabQrSrc(page: any, waitMs = 15_000): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f: any) => /open\.weixin\.qq\.com/.test(f.url()));
    if (frame) {
      try {
        const src: string | null = await frame.evaluate(`(() => {
          const img = document.querySelector('img.js_qrcode_img') || document.querySelector('img.qrcode');
          if (!img) return null;
          return img.src || img.getAttribute('src') || null;
        })()`);
        if (src) return src;
      } catch {
        /* 帧可能正在导航 */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * 执行一次扫码登录。
 *
 * 成功判据沿用命令行版的既有做法（已实战验证），不改成「看图片变化」之类的猜测：
 * 新增了会话类 cookie，或页面出现已登录文案；并且刷新一次复核仍然成立。
 */
export async function runMuseLogin(opts: {
  /** 为哪个用户登录；会话文件落在 data/muse-session/users/<ownerId>/ 下 */
  ownerId: string;
  headless: boolean;
  force?: boolean;
  timeoutMs?: number;
  startUrl?: string;
  hooks?: MuseLoginHooks;
}): Promise<MuseLoginResult> {
  const hooks = opts.hooks ?? {};
  const log = (s: string) => hooks.onLog?.(s);
  const phase = (p: 'STARTING' | 'WAITING_SCAN' | 'SUCCESS' | 'FAILED' | 'CANCELLED', m: string) =>
    hooks.onPhase?.(p, m);
  const cancel = () => hooks.shouldCancel?.() === true;

  const startUrl = opts.startUrl ?? cfg.muse.loginUrl;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  /** 本次要写入的会话文件：**必须**是该用户自己的那一份 */
  const statePath = museStatePath(opts.ownerId);

  phase('STARTING', '正在打开腾讯妙思登录页…');

  let browser: Awaited<ReturnType<typeof openMuseBrowser>> | null = null;
  try {
    browser = await openMuseBrowser({
      headless: opts.headless,
      storageState: opts.force ? null : statePath,
    });
    const page = await browser.context.newPage();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.muse.navTimeoutMs });
    await waitForAppReady(page);

    const baseline = (await browser.context.cookies()) as Cookie[];
    const baselineNames = new Set(baseline.map((c) => c.name));

    const initialText: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (!looksLikeLoginWall(initialText)) {
      log('页面未出现登录引导（可能已处于登录态）');
    }

    /**
     * 已是登录态就直接收工。
     *
     * 必要性：已登录时导航里的「登录/注册」入口**不存在**，点不出登录弹窗，
     * 于是取不到二维码，旧代码会报「未取到二维码地址（页面结构可能已改版）」——
     * 把「本来就已经登录了」误导成「页面改版」。
     * 这里顺带刷新一次会话快照（cookie 到期时间可能因此延长）。
     * 想换账号请用 force（force 不带登录态启动，必然看到登录入口）。
     */
    if (!opts.force && (await detectLoggedInDom(page))) {
      await saveStorageState(browser.context, statePath);
      markFromFetch(opts.ownerId, 'OK');
      log('检测到已登录账号区，无需重新扫码；已刷新会话快照');
      phase('SUCCESS', '当前已是登录态，无需重新扫码（已刷新会话快照）。');
      const current = ((await browser.context.cookies()) as Cookie[]).filter((c) =>
        SESSION_COOKIE_RE.test(c.name),
      );
      return {
        ok: true,
        message: '当前已是登录态，无需重新扫码（已刷新会话快照）。如需更换账号请使用强制重新登录。',
        sessionCookies: current.map((c) => ({ name: c.name, domain: c.domain, expires: c.expires })),
      };
    }

    // 把二维码点出来并拉第一张图
    let qrFetchedAt = 0;
    const refreshQr = async (reason: string): Promise<boolean> => {
      if (reason === 'refresh') {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
        await waitForAppReady(page);
      }
      await openLoginDialog(page, log);
      const src = await grabQrSrc(page);
      if (!src) {
        log('未取到二维码地址：可能是当前已是登录态（没有登录入口），也可能是页面结构已改版');
        return false;
      }
      try {
        const res = await fetch(src);
        if (!res.ok) {
          log(`二维码图片下载失败 HTTP ${res.status}`);
          return false;
        }
        const jpeg = Buffer.from(await res.arrayBuffer());
        qrFetchedAt = Date.now();
        const expiresAt = new Date(qrFetchedAt + QR_REFRESH_MS).toISOString();
        hooks.onQr?.(jpeg, { src, expiresAt });
        log(`二维码已就绪（${jpeg.length} 字节）`);
        return true;
      } catch (e) {
        log(`二维码图片下载异常：${(e as Error).message}`);
        return false;
      }
    };

    const gotFirst = await refreshQr('initial');
    if (!gotFirst) {
      /**
       * 首次就取不到码时**立刻失败**，不进等待循环。
       * 否则会白等满 timeout（默认 10 分钟）并一直占着 Chromium、
       * 期间主循环不领任务 —— 实测踩到：一次失败的登录把队列卡了 10 分钟。
       */
      phase(
        'FAILED',
        '未能取到登录二维码（页面可能已改版，或当前已是登录态）。请改用 npm run muse:login 在终端扫码，并反馈页面结构变化。',
      );
      return {
        ok: false,
        message: '未能取到登录二维码，已快速失败（不占用解析进程等待）。',
        sessionCookies: [],
      };
    }
    phase('WAITING_SCAN', '请使用微信扫描二维码完成登录。');

    const deadline = Date.now() + timeoutMs;
    let detected = false;
    let sessionCookies: Cookie[] = [];

    while (Date.now() < deadline) {
      if (cancel()) {
        phase('CANCELLED', '登录已被取消。');
        return { ok: false, message: '登录已被取消', sessionCookies: [] };
      }
      if (hooks.manualSignal?.()) {
        log('收到手动确认');
        detected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));

      // 二维码到期前主动换一张，避免用户扫到已失效的码
      if (qrFetchedAt > 0 && Date.now() - qrFetchedAt > QR_REFRESH_MS) {
        log('二维码即将过期，正在刷新…');
        await refreshQr('refresh');
      }

      let cookies: Cookie[] = [];
      try {
        cookies = (await browser.context.cookies()) as Cookie[];
      } catch {
        continue; // 浏览器可能正在导航
      }
      const added = cookies.filter((c) => !baselineNames.has(c.name));
      const sessionish = added.filter((c) => SESSION_COOKIE_RE.test(c.name));
      const text: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      const wall = looksLikeLoginWall(text);
      const loggedText = looksLoggedIn(text);
      const cookieSignal = sessionish.length > 0;

      // 首页游客可浏览时「无登录引导」不构成证据，因此需要 cookie 或登录文案任一信号
      if (loggedText || cookieSignal) {
        // 复核：刷新一次仍无登录引导才算登录成功
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
        await new Promise((r) => setTimeout(r, 2500));
        const text2: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        if (!looksLikeLoginWall(text2) || cookieSignal) {
          detected = true;
          sessionCookies = sessionish;
          break;
        }
        if (wall) log('刚出现的信号未通过复核，继续等待扫码…');
      }
    }

    if (!detected) {
      phase('FAILED', `等待 ${Math.round(timeoutMs / 1000)} 秒仍未识别到登录成功，未写入会话文件。`);
      return {
        ok: false,
        message: `超时未识别到登录成功（等待 ${Math.round(timeoutMs / 1000)} 秒）。未写入会话文件，避免把未登录状态存成有效会话。`,
        sessionCookies: [],
      };
    }

    // 多等一会儿，让业务域名的 cookie 全部落地再保存
    await new Promise((r) => setTimeout(r, 3000));
    await saveStorageState(browser.context, statePath);
    markFromFetch(opts.ownerId, 'OK');

    const finalCookies = (await browser.context.cookies()) as Cookie[];
    const sessionFinal = finalCookies.filter((c) => SESSION_COOKIE_RE.test(c.name));
    log(`会话已保存（共 ${finalCookies.length} 条 cookie，其中会话类 ${sessionFinal.length} 条）`);
    phase('SUCCESS', '登录成功，会话已保存，现在可以抓取妙思链接。');

    return {
      ok: true,
      message: '登录成功，会话已保存。',
      sessionCookies: sessionFinal.map((c) => ({ name: c.name, domain: c.domain, expires: c.expires })),
    };
  } catch (e) {
    const msg = (e as Error).message;
    phase('FAILED', `登录失败：${msg}`);
    return { ok: false, message: msg, sessionCookies: [] };
  } finally {
    await browser?.close();
  }
}

/** 某用户会话文件的绝对路径，供状态文案展示 */
export function museSessionFile(userId: string): string {
  return path.resolve(museStatePath(userId));
}

/** 某用户会话文件当前大小（0 表示不存在或为空） */
export function museSessionSize(userId: string): number {
  try {
    return fs.statSync(museStatePath(userId)).size;
  } catch {
    return 0;
  }
}
