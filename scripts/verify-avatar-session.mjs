import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { creds } from './_credentials.mjs';

/**
 * 验收：鲲之益（数字人平台）连接状态自动检测 + 账号密码自动连接（2026-09-22）。
 *
 * 必须用真实浏览器：工作台是客户端组件，SSR 只吐加载壳，curl 会假 PASS。
 *
 * 覆盖：
 *   1. 数字人解析进程随工作台一起启动（接口返回 workerRunning=true）
 *   2. 登录工作台后自动检测 → 未连接时自动弹出「连接数字人平台」窗口
 *   3. 弹窗有账号/密码输入框；空值时「连接」按钮禁用
 *   4. 输入**错误的**账号密码发起连接 → worker 真实执行自动登录 → 失败分支落地
 *      （FAILED + 明确文案；不花钱、不产生额度消耗）
 *   5. 凭据安全：登录结束后 control.json 里**不残留**账号密码
 *   6. 接口契约：未登录 401；GET 会话返回 viewer / needsAttention
 *   7. QA 逃生口：置 avatarAutoLoginDisabled 后不自动弹窗
 *
 * 刻意不用真实账号：成功分支需要真凭据，由维护人员首次使用时自然覆盖。
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3939';
const OUT = '_scratch/avatar-session';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? `  —— ${extra}` : ''}`);
  }
};

const SESSION_DIR = 'data/avatar-session';
const HEALTH_FILE = path.join(SESSION_DIR, 'health.json');
const CONTROL_FILE = path.join(SESSION_DIR, 'control.json');
const LOGIN_STATUS_FILE = path.join(SESSION_DIR, 'login-status.json');

/** 清掉上一轮验收遗留的登录运行时状态（残留 FAILED 会让弹窗按钮变成「重试连接」） */
function resetLoginRuntime() {
  try {
    if (fs.existsSync(CONTROL_FILE)) {
      const ctl = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
      delete ctl.loginRequestedAt;
      delete ctl.loginRequestedBy;
      delete ctl.loginUsername;
      delete ctl.loginPassword;
      delete ctl.loginCancelAt;
      fs.writeFileSync(CONTROL_FILE, JSON.stringify(ctl, null, 2));
    }
  } catch { /* 没有就算了 */ }
  try { fs.rmSync(LOGIN_STATUS_FILE, { force: true }); } catch { /* 忽略 */ }
}
resetLoginRuntime();

/** 备份/还原真实 health.json：验收用夹具覆盖，结束后还原 */
const origHealth = fs.existsSync(HEALTH_FILE) ? fs.readFileSync(HEALTH_FILE, 'utf8') : null;
function writeHealthFixture(status) {
  const now = new Date().toISOString();
  const fixture =
    status === 'EXPIRED'
      ? {
          status: 'EXPIRED',
          checkedAt: now,
          source: 'PROBE',
          message: '鲲之益登录会话已失效（验收夹具）。',
          sessionMtime: now,
          cookieCount: 1,
        }
      : {
          status: 'MISSING',
          checkedAt: now,
          source: 'NONE',
          message: '还没有连接过鲲之益平台（验收夹具）。',
          sessionMtime: null,
          cookieCount: 0,
        };
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(fixture, null, 2));
}
function restoreHealth() {
  try {
    if (origHealth !== null) fs.writeFileSync(HEALTH_FILE, origHealth);
    else fs.rmSync(HEALTH_FILE, { force: true });
  } catch {
    /* 还原失败不影响结论 */
  }
}
process.on('exit', restoreHealth);
process.on('SIGINT', () => {
  restoreHealth();
  process.exit(1);
});

async function userIdOf(username) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds[username]),
  });
  const j = await res.json();
  if (!j?.ok) throw new Error(`登录失败：HTTP ${res.status}`);
  return j.data.id;
}

const browser = await chromium.launch({ headless: true });

/** 验收浏览器默认关掉两个自动弹窗（妙思 + 数字人）；autoLogin=true 时保留数字人弹窗 */
async function login(user, { avatarAuto = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  await ctx.addInitScript((v) => {
    localStorage.setItem('museAutoLoginDisabled', '1');
    if (!v) localStorage.setItem('avatarAutoLoginDisabled', '1');
  }, avatarAuto);
  const res = await ctx.request.post(`${BASE}/api/auth/login`, { data: user });
  const j = await res.json().catch(() => null);
  if (!j?.ok) throw new Error(`登录失败：HTTP ${res.status}`);
  return ctx;
}

/* ───────── 1) 接口契约 ───────── */
console.log('\n══ 接口契约 ══');
writeHealthFixture('EXPIRED');
const mctx = await login(creds.maintainer);
const sess = await mctx.request.get(`${BASE}/api/avatar/session`);
const sj = await sess.json();
check('GET /api/avatar/session 200', sess.status() === 200);
check('返回 needsAttention=true（夹具失效）', sj?.data?.needsAttention === true);
check('返回 workerRunning=true（随工作台启动）', sj?.data?.workerRunning === true, JSON.stringify(sj?.data?.workerRunning));
check('返回 viewer 身份', Boolean(sj?.data?.viewer?.id));
check('返回 ttlMs（15 分钟）', sj?.data?.ttlMs === 15 * 60 * 1000);
// 夹具 checkedAt=now → 不 stale → 不应自动投递探测（不干扰后续断言）
check('结论新鲜时未自动投递探测', sj?.data?.refreshRequested === false);
const anonCtx = await browser.newContext();
const anon = await anonCtx.request.get(`${BASE}/api/avatar/session`);
check('未登录访问会话接口返回 401', anon.status() === 401, `HTTP ${anon.status()}`);
const anonLogin = await anonCtx.request.post(`${BASE}/api/avatar/login`, { data: { action: 'start', username: 'a', password: 'b' } });
check('未登录发起连接返回 401', anonLogin.status() === 401, `HTTP ${anonLogin.status()}`);
await anonCtx.close();
// 空凭据应 400
const empty = await mctx.request.post(`${BASE}/api/avatar/login`, { data: { action: 'start', username: '', password: '' } });
check('空账号密码发起连接返回 400', empty.status() === 400, `HTTP ${empty.status()}`);

/* ───────── 2) 自动检测与自动弹窗 ───────── */
console.log('\n══ 登录后自动检测与弹窗 ══');
// 弹窗记忆按用户清一次（sessionStorage 全新上下文本就为空）
writeHealthFixture('MISSING');
const actx = await login(creds.maintainer, { avatarAuto: true });
const apage = await actx.newPage();
await apage.goto(`${BASE}/tasks`, { waitUntil: 'domcontentloaded' });
const modal = apage.locator('.muse-modal');
await modal.waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
check('登录后检测到未连接自动弹出连接窗口', await modal.isVisible().catch(() => false));
const mtext = (await modal.textContent().catch(() => '')) ?? '';
check('弹窗写明需要「鲲之益平台」的账号', /鲲之益/.test(mtext), mtext.slice(0, 120));
check('弹窗有账号输入框', (await modal.locator('input').count()) >= 2);
check('弹窗有「稍后再说」可跳过', (await modal.getByRole('button', { name: '稍后再说' }).count()) > 0);
// 空值时「连接」按钮禁用
const connectBtn = modal.getByRole('button', { name: /^连接$/ });
check('账号密码为空时「连接」按钮禁用', (await connectBtn.count()) > 0 && !(await connectBtn.isEnabled().catch(() => true)));
await apage.screenshot({ path: `${OUT}/01-auto-modal.png` });
await modal.getByRole('button', { name: '稍后再说' }).click().catch(() => null);
await apage.waitForTimeout(400);
check('点「稍后再说」后弹窗消失（不阻断工作台）', (await modal.count()) === 0);
await apage.goto(`${BASE}/export`, { waitUntil: 'networkidle' });
await apage.waitForTimeout(1200);
check('跳过后导航到其它页面不再自动弹出', (await apage.locator('.muse-modal').count()) === 0);
await actx.close();

// QA 逃生口
const dctx = await login(creds.maintainer);
const dpage = await dctx.newPage();
await dpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await dpage.waitForTimeout(2500);
check('置 avatarAutoLoginDisabled 后不自动弹窗（QA 逃生口）', (await dpage.locator('.muse-modal').count()) === 0);
await dctx.close();

/* ───────── 3) 错误凭据的全链路（真实执行、零费用） ───────── */
console.log('\n══ 错误凭据全链路（worker 真实执行自动登录）══');
// 真实会话此刻可能有效：登录流程会先短路成「ALREADY」，验不到失败分支。
// 临时移走 state.json，让 worker 真的走到登录墙、填错误凭据、被平台拒绝。
const STATE_FILE = path.join(SESSION_DIR, 'state.json');
const origState = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : null;
if (origState !== null) fs.rmSync(STATE_FILE, { force: true });
const restoreState = () => {
  try {
    if (origState !== null) fs.writeFileSync(STATE_FILE, origState);
  } catch { /* 还原失败下次探测会重建 */ }
};
process.on('exit', restoreState);

// 先把可能遗留的登录状态清干净
fs.existsSync(path.join(SESSION_DIR, 'login-status.json')) && fs.rmSync(path.join(SESSION_DIR, 'login-status.json'), { force: true });
const bad = await mctx.request.post(`${BASE}/api/avatar/login`, {
  data: { action: 'start', username: 'qa-invalid-account', password: 'qa-wrong-password' },
});
check('发起连接返回 200（已受理）', bad.status() === 200, `HTTP ${bad.status()}`);
check('响应不回显凭据', !JSON.stringify(await bad.json().catch(() => ({})))?.includes('qa-wrong-password'));

// 轮询登录结果：worker 开无头浏览器 → 填凭据 → 提交 → 失败。最长 150 秒。
let finalStatus = null;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const j = await (await mctx.request.get(`${BASE}/api/avatar/login`)).json().catch(() => null);
  const p = j?.data?.status?.phase;
  if (p === 'FAILED' || p === 'CANCELLED' || p === 'SUCCESS') {
    finalStatus = j.data.status;
    break;
  }
}
restoreState();
console.log(`  （最终状态：${finalStatus?.phase} · ${finalStatus?.message?.slice(0, 80)}）`);
check('错误凭据最终落地为 FAILED/CANCELLED（真实执行了自动登录）', finalStatus?.phase === 'FAILED' || finalStatus?.phase === 'CANCELLED', finalStatus?.phase);
check('失败文案不暴露技术命令', !/npm run|tsx |curl/.test(finalStatus?.message ?? ''));

// 凭据安全：登录结束后 control.json 不残留账号密码
const ctl = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
check('control.json 不残留账号', !ctl.loginUsername, JSON.stringify({ u: ctl.loginUsername }));
check('control.json 不残留密码', !ctl.loginPassword);
check('login-status.json 不含凭据', !JSON.stringify(finalStatus ?? {}).includes('qa-wrong-password'));

/* ───────── 4) 连接结论与健康互不干扰 ───────── */
console.log('\n══ 结论文件 ══');
const after = (await (await mctx.request.get(`${BASE}/api/avatar/session`)).json())?.data;
check('失败后结论仍 needsAttention（不会误报已连接）', after?.needsAttention === true);
check('失败后 status 为 EXPIRED/UNKNOWN/MISSING 之一', ['EXPIRED', 'UNKNOWN', 'MISSING'].includes(after?.health?.status), after?.health?.status);

await browser.close();
console.log(`\n══ 结果：通过 ${pass} 项，失败 ${fail} 项 ══`);
process.exit(fail === 0 ? 0 : 1);
