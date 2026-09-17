import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../src/lib/config';
import {
  looksLikeLoginWall,
  looksLoggedIn,
  openMuseBrowser,
  saveStorageState,
  sessionInfo,
  waitForAppReady,
} from '../src/lib/sources/muse-browser';

/**
 * 腾讯妙思专用会话：人工扫码登录一次，把登录态保存到本地。
 *
 * 用法：
 *   npm run muse:login              # 打开浏览器，扫码登录，识别成功后自动保存
 *   npm run muse:login -- --check    # 只检查现有会话是否仍然有效
 *   npm run muse:login -- --force    # 忽略已有会话，强制重新登录
 *   npm run muse:login -- --manual   # 不靠自动识别，按回车即保存当前登录态
 *
 * 会话文件默认 data/muse-session/state.json，只保存在本机，不随代码提交（.gitignore 已排除 data/）。
 */

const args = process.argv.slice(2);
const MODE_CHECK = args.includes('--check');
const FORCE = args.includes('--force');
const MANUAL = args.includes('--manual') || process.env.MUSE_LOGIN_CONFIRM === '1';
const LOGIN_TIMEOUT_MS = Number(process.env.MUSE_LOGIN_TIMEOUT_MS ?? 600_000);
const URL_ARG = args.find((a) => a.startsWith('--url='))?.slice('--url='.length);
const START_URL = URL_ARG || cfg.muse.loginUrl;

function line(tag: string, text: string, extra = '') {
  console.log(`  ${tag.padEnd(6)} ${text}${extra ? '  ' + extra : ''}`);
}

/** 登录态相关 cookie 名：只用于判定与展示名字，绝不打印取值 */
const SESSION_COOKIE_RE = /uin|skey|token|ticket|sid|session|pass|login|ams|adq|auth/i;

function summarizeCookies(cookies: Array<{ name: string; domain?: string; expires?: number }>) {
  return cookies;
}

async function review(extraCookies: Array<{ name: string; domain?: string; expires?: number }>) {
  console.log('');
  console.log('── 会话 cookie（仅显示名称与域名，不显示取值）──');
  if (!extraCookies.length) {
    console.log('  （未捕获到会话类 cookie）');
    return;
  }
  for (const c of extraCookies.slice(0, 12)) {
    const exp = c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 16) : '会话级';
    console.log(`  ${c.name}  ${(c.domain ?? '').padEnd(24)} 到期 ${exp}`);
  }
}

async function runCheck(): Promise<number> {
  const info = sessionInfo();
  console.log('\n══ 腾讯妙思会话检查 ══\n');
  line('配置', `MUSE_FETCH_ENABLED=${cfg.muse.fetchEnabled}`);
  line('会话文件', info.path);
  if (!info.exists) {
    line('状态', '不存在');
    console.log('\n  → 执行 npm run muse:login 完成一次扫码登录。\n');
    return 1;
  }
  line('状态', `存在，${info.cookies} 条 cookie，更新时间 ${info.mtime?.toISOString().slice(0, 19)}`);

  let browser: Awaited<ReturnType<typeof openMuseBrowser>> | null = null;
  try {
    browser = await openMuseBrowser({ headless: true });
    const page = await browser.context.newPage();
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: cfg.muse.navTimeoutMs });
    await waitForAppReady(page);
    const text: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const wall = looksLikeLoginWall(text);
    const logged = looksLoggedIn(text);
    line('打开首页', wall ? '出现登录引导' : '未出现登录引导');
    line('页面信号', logged ? '检出已登录标识' : '未检出已登录标识');
    if (wall) {
      console.log('\n  → 会话已失效，请执行 npm run muse:login 重新登录。\n');
      return 1;
    }
    console.log('\n  → 会话可用，可直接用于妙思抓取。\n');
    return 0;
  } catch (e) {
    line('失败', (e as Error).message);
    return 1;
  } finally {
    await browser?.close();
  }
}

async function runLogin(): Promise<number> {
  console.log('\n══ 腾讯妙思登录（专用会话）══\n');
  const info = sessionInfo();
  if (info.exists) {
    line('已有会话', `${info.path}（${info.cookies} 条 cookie，${info.mtime?.toISOString().slice(0, 16)}）`);
    if (FORCE) line('提示', '--force 已指定，将覆盖为新会话');
    else line('提示', '若已登录会直接复用；需换账号请加 --force');
  } else {
    line('会话文件', '不存在，本次将新建');
  }
  console.log('');
  console.log('  浏览器即将打开，请用【微信 / 企业微信扫码】登录腾讯妙思。');
  console.log('  登录成功后脚本会自动识别并保存会话，无需手动操作。');
  console.log(`  若 60 秒内未自动识别，可回到本终端按【回车】手动保存当前登录态。`);
  console.log(`  最长等待 ${Math.round(LOGIN_TIMEOUT_MS / 1000)} 秒，超时会说明原因而不写入无效会话。`);
  console.log('');

  let browser: Awaited<ReturnType<typeof openMuseBrowser>> | null = null;
  try {
    browser = await openMuseBrowser({
      headless: false,
      storageState: FORCE ? null : cfg.muse.storageState,
    });
    const page = await browser.context.newPage();
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: cfg.muse.navTimeoutMs });
    await waitForAppReady(page);

    const baseline = summarizeCookies(await browser.context.cookies());
    const baselineNames = new Set(baseline.map((c) => c.name));
    const initialText: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const hadWallAtStart = looksLikeLoginWall(initialText);
    line(
      '初始状态',
      hadWallAtStart ? '页面出现登录引导，等待扫码' : '页面未出现登录引导（可能已在登录态或首页可游客浏览）',
    );

    // 手动保存通道：终端按回车即认为「我已登录」
    let manual = false;
    if (process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => {
        manual = true;
      });
      process.stdin.resume();
    }

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let detected = false;
    let newSessionCookies: Array<{ name: string; domain?: string; expires?: number }> = [];
    while (Date.now() < deadline) {
      if (manual) {
        detected = true;
        line('保存', '收到手动确认（回车）');
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
      let cookies: Array<{ name: string; domain?: string; expires?: number }> = [];
      try {
        cookies = summarizeCookies(await browser.context.cookies());
      } catch {
        continue; // 浏览器可能正在导航
      }
      const added = cookies.filter((c) => !baselineNames.has(c.name));
      const sessionish = added.filter((c) => SESSION_COOKIE_RE.test(c.name));
      const text: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      const wall = looksLikeLoginWall(text);
      const loggedText = looksLoggedIn(text);
      const cookieSignal = sessionish.length > 0;
      // 首页可游客浏览时「无登录引导」不构成证据，因此需要 cookie 或登录文案任一信号
      if (loggedText || cookieSignal) {
        // 复核：刷新一次仍无登录引导，才算登录成功
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
        await new Promise((r) => setTimeout(r, 2500));
        const text2: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        if (!looksLikeLoginWall(text2) || cookieSignal) {
          detected = true;
          newSessionCookies = sessionish;
          break;
        }
        if (wall) {
          line('等待中', '刚出现的信号未通过复核，继续等待扫码…');
        }
      }
    }

    if (!detected) {
      console.log('');
      line('超时', `等待 ${Math.round(LOGIN_TIMEOUT_MS / 1000)} 秒仍未识别到登录成功`);
      line('说明', '未写入会话文件（避免把未登录状态保存成有效会话）');
      line('建议', '重新执行 npm run muse:login；若确认已登录，改用 --manual 按回车强制保存');
      return 1;
    }

    // 多等一会儿，让业务域名的 cookie 全部落地再保存
    await new Promise((r) => setTimeout(r, 3000));
    await saveStorageState(browser.context);
    const finalCookies = summarizeCookies(await browser.context.cookies());
    const sessionFinal = finalCookies.filter((c) => SESSION_COOKIE_RE.test(c.name));

    console.log('');
    line('成功', `会话已保存：${cfg.muse.storageState}`);
    line('规模', `共 ${finalCookies.length} 条 cookie，其中会话类 ${sessionFinal.length} 条`);
    await review(sessionFinal.length ? sessionFinal : newSessionCookies);

    const size = fs.existsSync(cfg.muse.storageState) ? fs.statSync(cfg.muse.storageState).size : 0;
    if (size <= 0) {
      line('异常', '会话文件为空，请重新登录');
      return 1;
    }
    console.log('');
    console.log('  下一步：把 .env 的 MUSE_FETCH_ENABLED 改为 "true"，然后重启解析进程（npm run worker）。');
    console.log('  验证抓取：npm run muse:check   然后   npm run muse:probe -- "<妙思单条素材链接>"\n');
    return 0;
  } catch (e) {
    console.log('');
    line('失败', (e as Error).message);
    if (/Executable doesn't exist|browserType.launch/i.test((e as Error).message)) {
      line('建议', '浏览器运行时未安装，执行：npx playwright install chromium');
    }
    return 1;
  } finally {
    await browser?.close();
  }
}

(async () => {
  if (!fs.existsSync(path.dirname(cfg.muse.storageState)) && !MODE_CHECK) {
    fs.mkdirSync(path.dirname(cfg.muse.storageState), { recursive: true });
  }
  const code = MODE_CHECK ? await runCheck() : await runLogin();
  process.exit(code);
})();
