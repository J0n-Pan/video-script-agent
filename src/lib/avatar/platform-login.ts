/**
 * 鲲之益平台的连接探测与账号密码自动登录（2026-09-22 需求迭代）。
 *
 * ## 为什么账密登录可行（2026-09-22 探针实测）
 *
 * 无会话打开 `createPath` 会被重定向到 `https://aigc.huweilai.cn/login`，
 * 页面默认就是「账号 + 密码 + 登录」表单（placeholder：请输入账号 / 请输入密码），
 * **没有图形验证码**；短信验证码输入框只存在于隐藏的「找回密码」流程里。
 * 因此可以全自动：填入凭据 → 点「登录」→ 轮询登录成功信号。
 *
 * ## 登录成功的判据（与 avatar:login --check 一致）
 *
 * 这个站点**不用 cookie 记登录态**（会话文件里只有一个统计 cookie），
 * 真正的凭据是 localStorage 里的 `token`。所以判据是：
 *   1. 不在登录墙（URL 不是 /login，页面无「扫码登录/请登录」等标记）；
 *   2. 页面上下文里真的取得到 `localStorage.token`。
 * 只判 1 会在 SPA 首屏没渲染完时假报成功，必须两个都满足。
 *
 * 本模块**只允许 worker 调用**（要开 Chromium）；web 通过文件协议投递请求。
 */
import type { BrowserContext, Page } from 'playwright';
import { cfg } from '../config';
import { loadPlaywright } from '../sources/muse-browser';
import { checkAvatarSessionFile, clearAvatarCredentials, writeAvatarHealth } from './session-state';

/** 登录墙判定：URL 命中登录路径，或页面上仍有登录标记（与 avatar:login 同判据） */
async function onLoginWall(page: Page): Promise<boolean> {
  if (/\/login|\/signin|\/auth/i.test(page.url())) return true;
  const markers = ['扫码登录', '微信扫码', '请登录', '登录 / 注册', '手机号登录', '欢迎登录'];
  for (const m of markers) {
    if (await page.locator(`text=${m}`).first().isVisible({ timeout: 400 }).catch(() => false)) return true;
  }
  return false;
}

/** 硬信号：localStorage 里必须有 token（见文件头判据说明） */
async function hasToken(page: Page): Promise<boolean> {
  const v = await page
    .evaluate(`(() => { try { return !!localStorage.getItem('token'); } catch { return false; } })()`)
    .catch(() => false);
  return v === true;
}

/** 打开创建页（未登录会被重定向到登录页），等 SPA 首屏稳定 */
async function openCreatePage(page: Page): Promise<void> {
  await page.goto(new URL(cfg.avatar.createPath, cfg.avatar.baseUrl).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: cfg.avatar.navTimeoutMs,
  });
  await page.waitForTimeout(4000);
}

/** 保存当前登录会话 */
async function saveSession(context: BrowserContext): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.dirname(cfg.avatar.storageState), { recursive: true });
  await context.storageState({ path: cfg.avatar.storageState });
}

/**
 * 连接探测：开无头浏览器确认会话是否可用。约 8~15 秒。
 * 结论写 health.json；调用方（worker）不必再处理返回值。
 */
export async function probeAvatarSession(): Promise<void> {
  const started = Date.now();
  const fileState = checkAvatarSessionFile();
  if (fileState.status === 'MISSING') {
    // 零成本定罪：没有会话文件必然未连接，不必开浏览器
    writeAvatarHealth({
      ...fileState,
      status: 'MISSING',
      checkedAt: new Date().toISOString(),
      source: 'NONE',
      message: '还没有连接过鲲之益平台：请登录工作台后在弹窗里输入鲲之益的账号和密码完成连接。',
      costMs: Date.now() - started,
    });
    return;
  }

  const pw = await loadPlaywright();
  if (!pw) throw new Error('未安装 playwright 运行时，无法探测');
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: cfg.avatar.storageState,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const page = await context.newPage();
    await openCreatePage(page);
    const ok = !(await onLoginWall(page)) && (await hasToken(page));
    writeAvatarHealth({
      status: ok ? 'VALID' : 'EXPIRED',
      checkedAt: new Date().toISOString(),
      source: 'PROBE',
      message: ok
        ? '鲲之益平台连接正常，可以直接生成数字人视频。'
        : '鲲之益登录会话已失效：生成数字人视频前需要重新连接（输入账号和密码即可）。',
      sessionMtime: fileState.sessionMtime,
      cookieCount: fileState.cookieCount,
      costMs: Date.now() - started,
    });
  } finally {
    await browser.close();
  }
}

export type AvatarLoginOutcome = 'OK' | 'ALREADY' | 'FAILED';

/**
 * 账号密码自动登录（worker 执行，无头）。
 *
 * 成功后刷新 health 为 VALID；无论成败，control.json 里的凭据字段都会被清掉。
 * `shouldCancel` 由调用方提供（轮询 control 里的取消标记）。
 */
export async function runAvatarLogin(opts: {
  username: string;
  password: string;
  shouldCancel?: () => boolean;
}): Promise<{ outcome: AvatarLoginOutcome; message: string }> {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('未安装 playwright 运行时，无法登录');
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const hasState = checkAvatarSessionFile().status !== 'MISSING';
    const context = await browser.newContext({
      storageState: hasState ? cfg.avatar.storageState : undefined,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const page = await context.newPage();
    await openCreatePage(page);

    // 已有有效会话：不用再登录，刷新快照即可（换密码后旧会话仍有效时会发生）
    if (!(await onLoginWall(page)) && (await hasToken(page))) {
      await saveSession(context);
      return { outcome: 'ALREADY', message: '平台本来就在连接状态，已刷新会话。' };
    }

    // 填账密：凭 placeholder 定位（页面无 name/id；探针确认 placeholder 稳定）
    const account = page.locator('input[placeholder="请输入账号"]').first();
    const secret = page.locator('input[placeholder="请输入密码"]').first();
    if (!(await account.isVisible().catch(() => false)) || !(await secret.isVisible().catch(() => false))) {
      return { outcome: 'FAILED', message: '登录页上找不到账号或密码输入框（页面可能已改版），请截图反馈。' };
    }
    await account.fill(opts.username);
    await secret.fill(opts.password);

    // 点「登录」：type=submit 且文案为「登录」的可见按钮
    const submit = page.locator('button[type="submit"]', { hasText: '登录' }).first();
    if (!(await submit.isVisible().catch(() => false))) {
      return { outcome: 'FAILED', message: '登录页上找不到「登录」按钮（页面可能已改版），请截图反馈。' };
    }
    await submit.click();

    // 轮询登录结果：最长 40 秒；期间响应取消
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      if (opts.shouldCancel?.()) {
        return { outcome: 'FAILED', message: '登录已被取消。' };
      }
      if (!(await onLoginWall(page)) && (await hasToken(page))) {
        await saveSession(context);
        return { outcome: 'OK', message: '连接成功。' };
      }
    }
    return {
      outcome: 'FAILED',
      message: '等待一段时间后仍未登录成功：请确认账号和密码是否正确（若开启短信验证等二次验证，暂不支持自动登录）。',
    };
  } finally {
    // 凭据无论成败都清掉：control.json 里不残留密码
    clearAvatarCredentials();
    await browser.close();
  }
}
