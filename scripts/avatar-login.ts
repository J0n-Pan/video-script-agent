/**
 * 鲲之益（数字人）登录会话（2026-09-20 需求迭代 §7.2）。
 *
 * 与妙思登录脚本同一套路，但**会话文件独立**（data/avatar-session/state.json）：
 * 两个站点不同账号，共用一个 storageState 会互相覆盖登录态。
 *
 * 用法：
 *   npm run avatar:login           # 有头浏览器打开，人工扫码；登录成功后自动保存会话
 *   npm run avatar:login -- --check   # 只检查现有会话文件与登录态，不打开浏览器等人工
 *   npm run avatar:login -- --force   # 忽略已有会话，强制重新扫码
 *
 * 登录成功后请**重启数字人 worker**（npm run worker:avatar），它会用新会话提交任务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../src/lib/config';
import { loadPlaywright } from '../src/lib/sources/muse-browser';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const FORCE = args.includes('--force');

function line(k: string, v: string) {
  console.log(`${k.padEnd(10, '　')} ${v}`);
}

function sessionInfo() {
  const p = cfg.avatar.storageState;
  if (!fs.existsSync(p)) return { exists: false, cookies: 0, mtime: null as Date | null };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      exists: true,
      cookies: Array.isArray(raw?.cookies) ? raw.cookies.length : 0,
      mtime: fs.statSync(p).mtime,
    };
  } catch {
    return { exists: true, cookies: -1, mtime: fs.statSync(p).mtime };
  }
}

/**
 * 是否处于登录墙内。
 *
 * 判据与 `--check` 保持一致（原本两处判据不同：交互式要求页面上**恰好出现「文本驱动」**，
 * `--check` 只要求「不在登录墙」）—— 结果是页面文案一改，扫码成功了也判成失败、白白扫一场。
 * 统一为「URL 命中登录路径 **或** 页面上仍有扫码/登录字样」。
 */
async function onLoginWall(page: import('playwright').Page): Promise<boolean> {
  if (/\/login|\/signin|\/auth/i.test(page.url())) return true;
  const markers = ['扫码登录', '微信扫码', '请登录', '登录 / 注册', '手机号登录'];
  for (const m of markers) {
    if (await page.locator(`text=${m}`).first().isVisible({ timeout: 400 }).catch(() => false)) return true;
  }
  return false;
}

async function main() {
  console.log('=== 鲲之益数字人登录会话 ===');
  line('平台', cfg.avatar.baseUrl);
  line('会话文件', cfg.avatar.storageState);

  const before = sessionInfo();
  if (before.exists) {
    line('现有会话', `${before.cookies} 个 cookie，更新于 ${before.mtime?.toLocaleString('zh-CN')}`);
  } else {
    line('现有会话', '不存在（首次使用需要扫码）');
  }

  const pw = await loadPlaywright();
  if (!pw) {
    console.error('未安装 playwright 运行时，无法打开浏览器。请先执行 npm install 与 npx playwright install chromium。');
    process.exit(1);
  }

  // --check：只验证会话是否仍然可用，不打开交互式浏览器
  if (CHECK_ONLY) {
    if (!before.exists) {
      console.error('✗ 没有会话文件，请执行 npm run avatar:login 扫码登录');
      process.exitCode = 1;
      return;
    }
    const browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: cfg.avatar.storageState });
    const page = await context.newPage();
    try {
      await page.goto(new URL(cfg.avatar.createPath, cfg.avatar.baseUrl).toString(), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      if (await onLoginWall(page)) {
        console.error('✗ 会话已失效，请重新执行 npm run avatar:login -- --force');
        process.exitCode = 1;
        return;
      }
      /**
       * 这个站点**不用 cookie 记登录态**（实测只有 1 个 _bl_uid 统计 cookie），
       * 真正的凭据是 localStorage 里的 `token`。所以只判「没看到登录墙」不够：
       * SPA 首屏还没渲染完时也可能看不到登录墙，会假报「会话可用」。
       * 这里补一个硬信号：页面上下文里必须真的取到 token。
       */
      const hasToken = await page
        .evaluate(() => {
          try {
            return !!localStorage.getItem('token');
          } catch {
            return false;
          }
        })
        .catch(() => false);
      if (!hasToken) {
        console.error('✗ 页面里读不到登录令牌（localStorage.token），会话可能已失效；请重新扫码登录');
        process.exitCode = 1;
        return;
      }
      console.log('✓ 会话可用（有登录令牌，未出现登录墙）');
    } finally {
      await browser.close();
    }
    return;
  }

  // 交互式扫码：有头浏览器，轮询直到检测到已登录
  const statePath = FORCE ? null : cfg.avatar.storageState;
  const browser = await pw.chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    storageState: statePath && fs.existsSync(statePath) ? statePath : undefined,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();

  await page.goto(new URL(cfg.avatar.createPath, cfg.avatar.baseUrl).toString(), { waitUntil: 'domcontentloaded' });
  console.log('');
  console.log('请在打开的浏览器窗口里完成登录（扫码或账号登录）。');
  console.log('登录完成后脚本会自动保存会话，最多等待 5 分钟。');
  console.log('');

  const deadline = Date.now() + 5 * 60 * 1000;
  let ok = false;
  let tick = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    tick += 1;
    if (!(await onLoginWall(page))) {
      ok = true;
      break;
    }
    // 每约 30 秒报一次当前地址，扫码卡住时能看出是停在哪一步
    if (tick % 12 === 0) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      console.log(`  …仍在等待扫码（剩余 ${left}s），当前地址：${page.url()}`);
    }
  }

  if (!ok) {
    console.error('✗ 超时未检测到登录成功。可重试，或在 --check 模式下排查会话文件。');
    await browser.close();
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(cfg.avatar.storageState), { recursive: true });
  await context.storageState({ path: cfg.avatar.storageState });
  const after = sessionInfo();
  console.log(`✓ 登录成功，会话已保存：${cfg.avatar.storageState}（${after.cookies} 个 cookie）`);
  console.log('  请重启数字人 worker：npm run worker:avatar');
  await browser.close();
}

main().catch((e) => {
  console.error('登录脚本异常：', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
