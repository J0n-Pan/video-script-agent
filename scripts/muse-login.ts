import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../src/lib/config';
import { prisma } from '../src/lib/db';
import { sessionInfo } from '../src/lib/sources/muse-browser';
import { probeMuseSession, SESSION_COOKIE_RE } from '../src/lib/sources/muse-health';
import { runMuseLogin } from '../src/lib/sources/muse-login-flow';
import { museStatePath } from '../src/lib/sources/muse-session-paths';
import { readUserArg, resolveMuseTarget, type MuseTarget } from './_muse-target';

/**
 * 腾讯妙思专用会话：人工扫码登录一次，把登录态保存到本地。
 *
 * 用法：
 *   npm run muse:login              # 打开浏览器，扫码登录，识别成功后自动保存
 *   npm run muse:login -- --check    # 只检查现有会话是否仍然有效
 *   npm run muse:login -- --force    # 忽略已有会话，强制重新登录
 *   npm run muse:login -- --manual   # 不靠自动识别，按回车即保存当前登录态
 *
 * 会话自 2026-09-22 起按人保存（data/muse-session/users/<userId>/state.json），只保存在本机，
 * 不随代码提交（.gitignore 已排除 data/）。默认给**维护人员**登录（与改动前全局会话的归属一致），
 * 要给某个编导登录请加 --user=<用户名>。
 *
 * 实现说明（2026-09-20）：登录与判定逻辑已抽到 src/lib/sources/muse-login-flow.ts 与
 * muse-health.ts，与工作台里的「网页扫码登录」共用同一份实现 ——
 * 命令行版只是给它接上有头浏览器与终端输出，避免两份逻辑各自漂移。
 */

const args = process.argv.slice(2);
const MODE_CHECK = args.includes('--check');
const FORCE = args.includes('--force');
const MANUAL = args.includes('--manual') || process.env.MUSE_LOGIN_CONFIRM === '1';
const LOGIN_TIMEOUT_MS = Number(process.env.MUSE_LOGIN_TIMEOUT_MS ?? 600_000);
const URL_ARG = args.find((a) => a.startsWith('--url='))?.slice('--url='.length);
const USER_ARG = readUserArg(args);
const START_URL = URL_ARG || cfg.muse.loginUrl;

function line(tag: string, text: string, extra = '') {
  console.log(`  ${tag.padEnd(6)} ${text}${extra ? '  ' + extra : ''}`);
}

async function review(cookies: Array<{ name: string; domain?: string; expires?: number }>) {
  console.log('');
  console.log('── 会话 cookie（仅显示名称与域名，不显示取值）──');
  if (!cookies.length) {
    console.log('  （未捕获到会话类 cookie）');
    return;
  }
  for (const c of cookies.slice(0, 12)) {
    const exp = c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 16) : '会话级';
    console.log(`  ${c.name}  ${(c.domain ?? '').padEnd(24)} 到期 ${exp}`);
  }
}

/**
 * --check：复用与工作台完全相同的判定（probeMuseSession），
 * 因此命令行的结论与界面提示栏不会出现分歧。顺带刷新 health.json。
 */
async function runCheck(target: MuseTarget): Promise<number> {
  const info = sessionInfo(target.storageStatePath);
  console.log('\n══ 腾讯妙思会话检查 ══\n');
  line('配置', `MUSE_FETCH_ENABLED=${cfg.muse.fetchEnabled}`);
  line('会话文件', info.path);
  if (!info.exists) {
    line('状态', '不存在');
    console.log('\n  → 执行 npm run muse:login 完成一次扫码登录。\n');
    return 1;
  }
  line('状态', `存在，${info.cookies} 条 cookie，更新时间 ${info.mtime?.toISOString().slice(0, 19)}`);
  line('核实', '正在用无头浏览器打开妙思首页判定（约 10 秒）…');

  const h = await probeMuseSession(target.userId);
  line('判定', `${h.status}  ${h.message}`);
  if (h.costMs) line('耗时', `${(h.costMs / 1000).toFixed(1)} 秒`);

  try {
    const raw = JSON.parse(fs.readFileSync(cfg.muse.storageState, 'utf8'));
    const all = (raw?.cookies ?? []) as Array<{ name: string; domain?: string; expires?: number }>;
    await review(all.filter((c) => SESSION_COOKIE_RE.test(c.name)));
  } catch {
    console.log('\n  （会话文件解析失败，仅凭页面判定）');
  }

  console.log('');
  if (h.status === 'VALID') {
    console.log('  → 会话可用，可直接用于妙思抓取。\n');
    return 0;
  }
  if (h.status === 'EXPIRED' || h.status === 'MISSING') {
    console.log('  → 会话已失效，执行 npm run muse:login 重新登录；');
    console.log('    或在工作台页头提示栏点「重新扫码登录」在网页里扫码。\n');
    return 1;
  }
  console.log('  → 无法确认（既无登录引导也无已登录标识）。若确认已登录，可试 npm run muse:probe 实测抓取。\n');
  return 1;
}

async function runLogin(target: MuseTarget): Promise<number> {
  console.log(`  会话归属：${target.displayName}（${target.username}）\n`);
  console.log('\n══ 腾讯妙思登录（专用会话）══\n');
  const info = sessionInfo(target.storageStatePath);
  if (info.exists) {
    line('已有会话', `${info.path}（${info.cookies} 条 cookie，${info.mtime?.toISOString().slice(0, 16)}）`);
    if (FORCE) line('提示', '--force 已指定，将覆盖为新会话');
    else line('提示', '若已登录会直接复用；需换账号请加 --force');
  } else {
    line('会话文件', '不存在，本次将新建');
  }
  console.log('');
  console.log('  浏览器即将打开，请用【微信 / 企业微信扫码】登录腾讯妙思。');
  console.log('  脚本会自动点开登录弹窗并识别登录结果，无需手动操作。');
  console.log('  若 60 秒内未自动识别，可回到本终端按【回车】手动保存当前登录态。');
  console.log(`  最长等待 ${Math.round(LOGIN_TIMEOUT_MS / 1000)} 秒，超时会说明原因而不写入无效会话。`);
  console.log('');

  // 终端手动确认通道：回车即认为「我已登录」
  let manual = false;
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => {
      manual = true;
    });
    process.stdin.resume();
  }

  const r = await runMuseLogin({
    ownerId: target.userId,
    headless: false,
    force: FORCE,
    timeoutMs: LOGIN_TIMEOUT_MS,
    startUrl: START_URL,
    hooks: {
      onLog: (s) => line('进度', s),
      onPhase: (_p, m) => console.log(`  → ${m}`),
      manualSignal: () => manual,
    },
  });

  if (!r.ok) {
    console.log('');
    line('失败', r.message);
    if (/Executable doesn't exist|browserType.launch/i.test(r.message)) {
      line('建议', '浏览器运行时未安装，执行：npx playwright install chromium');
    }
    if (MANUAL) line('提示', '--manual 已开启：确认已在浏览器里登录完成后按回车即可保存。');
    console.log('');
    return 1;
  }

  console.log('');
  line('成功', r.message);
  line('会话文件', target.storageStatePath);
  line('规模', `会话类 cookie ${r.sessionCookies.length} 条`);
  await review(r.sessionCookies);

  const size = fs.existsSync(target.storageStatePath) ? fs.statSync(target.storageStatePath).size : 0;
  if (size <= 0) {
    line('异常', '会话文件为空，请重新登录');
    return 1;
  }
  console.log('');
  console.log('  下一步：把 .env 的 MUSE_FETCH_ENABLED 改为 "true"，然后重启解析进程（npm run worker）。');
  console.log('  验证抓取：npm run muse:check   然后   npm run muse:probe -- "<妙思单条素材链接>"\n');
  return 0;
}

(async () => {
  const target = await resolveMuseTarget(USER_ARG);
  fs.mkdirSync(museStatePath(target.userId), { recursive: true });
  const code = MODE_CHECK ? await runCheck(target) : await runLogin(target);
  await prisma.$disconnect();
  process.exit(code);
})();
