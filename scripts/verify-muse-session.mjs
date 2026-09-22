import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { creds } from './_credentials.mjs';

/**
 * 验收：妙思登录态提示栏 + 我的妙思会话页 + 登录后自动检查（2026-09-22 按用户隔离版）。
 *
 * 必须用真实浏览器：工作台是客户端组件，SSR 只吐加载壳，curl 会假 PASS。
 *
 * 覆盖：
 *   1. 维护人员打开任务列表 → 出现**自己**的失效提示栏（EXPIRED 夹具时）+「去扫码登录」
 *   2. 编导打开任务列表 → 同样出现提示栏且**也能点「去扫码登录」**（不再有「请联系维护人员」）
 *   3. 两人看到的是**各自**的结论：只写编导的夹具时，维护人员不得被牵连（会话隔离）
 *   4. 「收起」后本浏览器不再显示；但登录态一旦变化要重新出现；换账号不继承收起
 *   5. /settings/muse-session 页：状态卡片、二维码位、开始扫码按钮（人人可用）
 *   6. 编导调用登录接口 200（2026-09-22 起人人可给自己扫码）
 *   7. 未登录自动检查不弹窗；登录后自动检查失效 → 自动弹二维码（可「稍后再说」）
 *
 * 只读验收：不真的等扫码 —— 自动弹窗触发后立刻取消，worker 最多开几秒浏览器。
 * 会话状态用夹具（health.json）强制，与真实会话当时是否有效无关。
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3939';
const OUT = '_scratch/muse-banner';
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

const browser = await chromium.launch({ headless: true });

/* ─────────────────────────────────────────────────────────────
 * 夹具：把**指定用户**的登录态结论强制写成目标状态。
 *
 * 2026-09-22 起结论按用户存（data/muse-session/users/<userId>/health.json），
 * 所以夹具也必须按人写 —— 这正好让「两人互不牵连」成为可断言的行为。
 * health.json 是可再生的派生缓存（探测会重写），因此直接改它、结束时还原。
 * ───────────────────────────────────────────────────────────── */

async function userIdOf(username) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds[username]),
  });
  const j = await res.json();
  if (!j?.ok) throw new Error(`登录失败：HTTP ${res.status}`);
  return j.data.id; // 2026-09-22 起登录接口返回 id
}

const M_ID = await userIdOf('maintainer');
const E_ID = await userIdOf('editor');

const HEALTH_FILE_M = `data/muse-session/users/${M_ID}/health.json`;
const HEALTH_FILE_E = `data/muse-session/users/${E_ID}/health.json`;

function healthFixturePath(user) {
  return user === 'maintainer' ? HEALTH_FILE_M : HEALTH_FILE_E;
}
function backupHealth(user) {
  const p = healthFixturePath(user);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
function writeHealthFixture(user, status) {
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 3 * 86400_000).toISOString();
  const fixture =
    status === 'EXPIRED'
      ? {
          status: 'EXPIRED',
          checkedAt: now,
          source: 'NONE',
          message: `你的腾讯妙思会话已于 ${past.slice(0, 16).replace('T', ' ')} 过期。此时提交妙思链接会在抓取阶段失败（脚本文字与来源信息不受影响）。`,
          sessionMtime: past,
          cookieCount: 7,
          sessionExpiresAt: past,
        }
      : {
          status: 'VALID',
          checkedAt: now,
          source: 'PROBE',
          message: '你的妙思登录态有效，可直接抓取妙思链接。',
          sessionMtime: now,
          cookieCount: 7,
          sessionExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
          costMs: 3800,
        };
  fs.mkdirSync(path.dirname(healthFixturePath(user)), { recursive: true });
  fs.writeFileSync(healthFixturePath(user), JSON.stringify(fixture, null, 2));
}
function restoreHealth(user) {
  const p = healthFixturePath(user);
  const orig = user === 'maintainer' ? origM : origE;
  try {
    if (orig !== null) fs.writeFileSync(p, orig);
    else fs.rmSync(p, { force: true });
  } catch {
    /* 还原失败不影响结论，下次探测会重写 */
  }
}

const origM = backupHealth('maintainer');
const origE = backupHealth('editor');

/** 清掉上一轮验收可能遗留的登录运行时状态（worker 一直活着时没人重置它们）：
 *  control.json 里的登录请求标记、login-status.json（残留 STARTING 会让按钮
 *  变成「登录进行中…」、二维码路由回 200）、遗留的二维码图片。 */
function resetLoginRuntime(user) {
  const dir = `data/muse-session/users/${user === 'maintainer' ? M_ID : E_ID}`;
  const ctlPath = path.join(dir, 'control.json');
  try {
    if (fs.existsSync(ctlPath)) {
      const ctl = JSON.parse(fs.readFileSync(ctlPath, 'utf8'));
      delete ctl.loginRequestedAt;
      delete ctl.loginRequestedBy;
      delete ctl.loginForce;
      delete ctl.loginCancelAt;
      fs.writeFileSync(ctlPath, JSON.stringify(ctl, null, 2));
    }
  } catch { /* 没有就算了 */ }
  for (const f of ['login-status.json', 'qr.jpg']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* 忽略 */ }
  }
}
resetLoginRuntime('maintainer');
resetLoginRuntime('editor');

function restoreAll() {
  restoreHealth('maintainer');
  restoreHealth('editor');
}
process.on('exit', restoreAll);
process.on('SIGINT', () => {
  restoreAll();
  process.exit(1);
});

/** 验收浏览器一律关掉「自动弹码」：否则夹具的「已失效」会真的发起扫码，堵住解析队列 */
async function login(user, { autoLogin = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  await ctx.addInitScript((v) => {
    if (!v) localStorage.setItem('museAutoLoginDisabled', '1');
  }, autoLogin);
  const res = await ctx.request.post(`${BASE}/api/auth/login`, { data: user });
  const j = await res.json().catch(() => null);
  if (!j?.ok) throw new Error(`登录失败：HTTP ${res.status} ${JSON.stringify(j)?.slice(0, 200)}`);
  return ctx;
}

/* ───────── 1) 维护人员视角（自己失效） ───────── */
console.log('\n══ 维护人员视角（自己的会话失效）══');
writeHealthFixture('maintainer', 'EXPIRED');
const mctx = await login(creds.maintainer);
const mpage = await mctx.newPage();
await mpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });

const banner = mpage.locator('.muse-banner');
await banner.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
check('任务列表出现登录态提示栏', await banner.isVisible().catch(() => false));

const btext = (await banner.textContent().catch(() => '')) ?? '';
check('提示栏写明「妙思链接会在抓取阶段失败」', /妙思链接会在抓取阶段失败/.test(btext), btext.slice(0, 120));
check('提示栏写明脚本文字不受影响', /不受影响/.test(btext));
check('提示栏指明是「你的」登录态', /你的腾讯妙思登录态/.test(btext), btext.slice(0, 120));

// 到期时间必须按**本地时区**展示（曾把 ISO 字符串直接切片，显示成 UTC，与会话页差 8 小时）
const apiHealth = (await (await mctx.request.get(`${BASE}/api/muse/session`)).json())?.data?.health;
const expIso = apiHealth?.sessionExpiresAt;
const pad = (n) => String(n).padStart(2, '0');
const expLocal = expIso
  ? (() => {
      const d = new Date(Date.parse(expIso));
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    })()
  : '';
check(`提示栏按本地时区展示到期时间（${expLocal}）`, Boolean(expLocal) && btext.includes(expLocal), btext.slice(0, 220));
check('提示栏不出现 UTC 原始切片（差 8 小时的旧写法）', expIso ? !btext.includes(expIso.slice(0, 16).replace('T', ' ')) : true);
check('提示栏标注判定依据', /判定依据/.test(btext));

const reloginBtn = banner.getByRole('button', { name: '去扫码登录' });
check('维护人员可见「去扫码登录」', (await reloginBtn.count()) > 0);
check('不再出现「请联系维护人员」（会话已按人隔离）', !/请联系维护人员/.test(btext));
check('提示栏有「重新检测」', (await banner.getByRole('button', { name: '重新检测' }).count()) > 0);
check('提示栏有「收起」', (await banner.getByRole('button', { name: '收起' }).count()) > 0);

// 横幅应贴在页头正下方（在 .header 之后、.wrap 之前）
const order = await mpage.evaluate(`(() => {
  const h = document.querySelector('.header');
  const b = document.querySelector('.muse-banner');
  const w = document.querySelector('.wrap');
  if (!h || !b || !w) return null;
  return { headerThenBanner: (h.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,
           bannerThenWrap: (b.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING) > 0 };
})()`);
check('提示栏位于页头之后、内容之前', order?.headerThenBanner === true && order?.bannerThenWrap === true, JSON.stringify(order));

await mpage.screenshot({ path: `${OUT}/01-banner-tasks.png` });

// 点「去扫码登录」应跳转到会话页
await reloginBtn.first().click();
await mpage.waitForURL(/settings\/muse-session/, { timeout: 15000 }).catch(() => null);
check('点击「去扫码登录」跳转到 /settings/muse-session', /settings\/muse-session/.test(mpage.url()), mpage.url());
await mpage.waitForTimeout(1200);
await mpage.screenshot({ path: `${OUT}/02-muse-session.png` });

const ptext = (await mpage.locator('.wrap').textContent().catch(() => '')) ?? '';
check('会话页标题为「我的妙思会话」', /我的妙思会话/.test(ptext), ptext.slice(0, 80));
check('会话页不再有旧说明小字（维护人员扫码/全局共用）', !/由维护人员扫码建立|全局共用/.test(ptext));
check('会话页显示当前状态（已失效）', /登录态已失效/.test(ptext), ptext.slice(0, 160));
check('会话页显示「会话到期」一栏', /会话到期/.test(ptext));
check('会话页显示零成本判据说明', /无需开浏览器/.test(ptext));
check('会话页显示解析进程状态', /解析进程/.test(ptext));
const startBtn = mpage.getByRole('button', { name: '开始扫码登录' });
check('维护人员在会话页可见「开始扫码登录」且可点', await startBtn.isEnabled().catch(() => false));
// 已登录时导航里没有登录入口，换账号必须走强制登录
const forceBtn = mpage.getByRole('button', { name: '更换账号登录' });
check('会话页有「更换账号登录」（强制登录，用于换微信号）', await forceBtn.isEnabled().catch(() => false));
check('会话页有二维码占位区', /点「开始扫码登录」后这里显示二维码/.test(ptext));

/* ───────── 2) 编导视角（也是自己的会话） ───────── */
console.log('\n══ 编导视角（editor，人人可给自己扫码）══');
// 只写编导的夹具：维护人员的结论不被动 —— 这就是「互不牵连」的可断言版本
writeHealthFixture('editor', 'EXPIRED');
const ectx = await login(creds.editor);
const epage = await ectx.newPage();
await epage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
const ebanner = epage.locator('.muse-banner');
await ebanner.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
check('编导看到自己失效的提示栏', await ebanner.isVisible().catch(() => false));
const etext = (await ebanner.textContent().catch(() => '')) ?? '';
check('编导也有「去扫码登录」按钮', (await ebanner.getByRole('button', { name: '去扫码登录' }).count()) > 0);
check('编导看不到「请联系维护人员」', !/请联系维护人员/.test(etext), etext.slice(0, 160));
await epage.screenshot({ path: `${OUT}/03-editor-banner.png` });

// 会话隔离：编导失效时，维护人员的 API 结论不得被牵连
const mHealthDuring = (await (await mctx.request.get(`${BASE}/api/muse/session`)).json())?.data?.health;
check('编导失效不影响维护人员的结论（会话隔离）', mHealthDuring?.status === 'EXPIRED', `维护人员=${mHealthDuring?.status}`);
// 同理反过来：把维护人员修好，编导的提示栏必须还在
writeHealthFixture('maintainer', 'VALID');
const mHealthAfter = (await (await mctx.request.get(`${BASE}/api/muse/session`)).json())?.data?.health;
check('维护人员修好只影响自己', mHealthAfter?.status === 'VALID', `维护人员=${mHealthAfter?.status}`);
check('编导的提示栏不因维护人员修好而消失', await ebanner.isVisible().catch(() => false));

// 编导的会话页：按钮应该可点（不再禁用）
await epage.goto(`${BASE}/settings/muse-session`, { waitUntil: 'networkidle' });
await epage.waitForTimeout(1200);
const estart = epage.getByRole('button', { name: '开始扫码登录' });
check('编导在会话页「开始扫码登录」可点', (await estart.count()) > 0 && (await estart.isEnabled().catch(() => false)));
const eforce = epage.getByRole('button', { name: '更换账号登录' });
check('编导在会话页「更换账号登录」也可点', (await eforce.count()) > 0 && (await eforce.isEnabled().catch(() => false)));
const eptext = (await epage.locator('.wrap').textContent().catch(() => '')) ?? '';
check('编导在会话页不再看到无权限说明', !/不能发起扫码登录/.test(eptext), eptext.slice(0, 160));
await epage.screenshot({ path: `${OUT}/04-editor-session.png` });

// 编导直接调接口应 200（2026-09-22 起人人可给自己扫码）
const eok = await ectx.request.post(`${BASE}/api/muse/login`, { data: { action: 'start' } });
check('编导调用登录接口返回 200', eok.status() === 200, `HTTP ${eok.status()}`);
// 立刻取消，避免 worker 真的去等扫码
await ectx.request.post(`${BASE}/api/muse/login`, { data: { action: 'cancel' } });
// 各人的请求写在各自的 control.json 里：编导发了请求，维护人员的必须没动静
const ctlE = JSON.parse(fs.readFileSync(`data/muse-session/users/${E_ID}/control.json`, 'utf8'));
check('编导的登录请求落在自己的 control.json', Boolean(ctlE.loginRequestedAt));
const ctlM = JSON.parse(fs.readFileSync(`data/muse-session/users/${M_ID}/control.json`, 'utf8'));
check('维护人员的 control 没有被编导的请求污染', !ctlM.loginRequestedAt);

/* ───────── 3) 收起行为（含换账号不继承） ───────── */
console.log('\n══ 收起行为 ══');
// 夹具必须写在 goto **之前**：提示栏只在挂载时取一次结论（60s 才轮询一次），
// 先开页再改夹具的话，15s 等待内提示栏永远不会出现 —— 假失败。
writeHealthFixture('maintainer', 'EXPIRED');
await mpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
const b2 = mpage.locator('.muse-banner');
await b2.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
const wasVisible = await b2.isVisible().catch(() => false);
check('收缩前提示栏可见', wasVisible);
if (wasVisible) {
  await b2.getByRole('button', { name: '收起' }).click();
  await mpage.waitForTimeout(500);
  check('点「收起」后提示栏消失', !(await b2.isVisible().catch(() => false)));
  await mpage.reload({ waitUntil: 'networkidle' });
  await mpage.waitForTimeout(1500);
  check('刷新后仍保持收起（浏览器会话记忆）', (await mpage.locator('.muse-banner').count()) === 0);

  // 换账号登录（同一浏览器上下文）：编导的收起记忆必须与维护人员无关。
  // 编导此刻也是失效状态 → 维护人员的「收起」不得把编导的提示栏也吞掉。
  await epage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
  await epage.locator('.muse-banner').waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
  check('同一浏览器里编导的提示栏不受维护人员收起影响', await epage.locator('.muse-banner').isVisible().catch(() => false));

  // 换新上下文（等价于换浏览器/新会话）应重新出现
  const fresh = await login(creds.maintainer);
  const fpage = await fresh.newPage();
  writeHealthFixture('maintainer', 'EXPIRED');
  await fpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
  await fpage.locator('.muse-banner').waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
  check('新浏览器会话里提示栏重新出现', await fpage.locator('.muse-banner').isVisible().catch(() => false));
  await fpage.screenshot({ path: `${OUT}/05-fresh-session.png` });
  await fresh.close();
}

/* ───────── 4) 接口契约 ───────── */
console.log('\n══ 接口契约 ══');
const sess = await mctx.request.get(`${BASE}/api/muse/session`);
const sj = await sess.json();
check('GET /api/muse/session 200', sess.status() === 200);
check('返回 needsAttention=true', sj?.data?.needsAttention === true);
check('返回 status=EXPIRED', sj?.data?.health?.status === 'EXPIRED', sj?.data?.health?.status);
check('返回 workerRunning=true', sj?.data?.workerRunning === true);
check('返回 sessionExpiresAt', Boolean(sj?.data?.health?.sessionExpiresAt));
check('返回 viewer 身份（按人区分记忆用）', sj?.data?.viewer?.id === M_ID, JSON.stringify(sj?.data?.viewer));
check('返回 canOperate=true（人人可给自己扫码）', sj?.data?.canOperate === true);
const anonCtx = await browser.newContext();
const anon = await anonCtx.request.get(`${BASE}/api/muse/session`);
check('未登录访问返回 401', anon.status() === 401, `HTTP ${anon.status()}`);
await anonCtx.close();
const qr = await mctx.request.get(`${BASE}/api/muse/login/qr`);
check('无登录进行中时取二维码返回 404', qr.status() === 404, `HTTP ${qr.status()}`);

/* ───────── 5) 登录后自动检查 + 自动弹码（可跳过） ───────── */
console.log('\n══ 登录后自动检查与自动弹码 ══');
// 用维护人员 + 未关自动弹窗的上下文：夹具已是 EXPIRED → 应自动弹二维码
writeHealthFixture('maintainer', 'EXPIRED');
const actx = await login(creds.maintainer, { autoLogin: true });
const apage = await actx.newPage();
await apage.goto(`${BASE}/tasks`, { waitUntil: 'domcontentloaded' });
const modal = apage.locator('.muse-modal');
await modal.waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
check('登录后检测到失效自动弹出扫码窗', await modal.isVisible().catch(() => false));
const mtext = (await modal.textContent().catch(() => '')) ?? '';
check('弹窗写明会话「只属于你自己」', /只属于你自己|你自己的/.test(mtext), mtext.slice(0, 160));
check('弹窗有「稍后再说」可跳过', (await modal.getByRole('button', { name: '稍后再说' }).count()) > 0);
await apage.screenshot({ path: `${OUT}/06-auto-login-modal.png` });
// 立刻取消，别让 worker 真的等扫码（弹窗由 worker 写出的 control 驱动）
await actx.request.post(`${BASE}/api/muse/login`, { data: { action: 'cancel' } });
await modal.getByRole('button', { name: '稍后再说' }).click().catch(() => null);
await apage.waitForTimeout(400);
check('点「稍后再说」后弹窗消失（不阻断工作台）', (await modal.count()) === 0);
// 同一次登录内不得再次自动弹出（跳过后的导航/刷新）
await apage.goto(`${BASE}/export`, { waitUntil: 'networkidle' });
await apage.waitForTimeout(1500);
check('跳过后导航到其它页面不再自动弹出', (await apage.locator('.muse-modal').count()) === 0);
await actx.close();

// 关掉自动弹窗（验收浏览器默认）：同样的失效夹具不得弹窗
const dctx = await login(creds.maintainer);
const dpage = await dctx.newPage();
await dpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await dpage.waitForTimeout(2000);
check('置 museAutoLoginDisabled 后不自动弹窗（QA 逃生口）', (await dpage.locator('.muse-modal').count()) === 0);
await dctx.close();

/* ───────── 6) 修好之后提示栏要自动消失 ───────── */
console.log('\n══ 修好之后提示栏应自动消失 ══');
writeHealthFixture('maintainer', 'VALID');
await mpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await mpage.waitForTimeout(2000);
check('状态转 VALID 后提示栏不再出现', (await mpage.locator('.muse-banner').count()) === 0);

// 「收起」只对当下这一段失效有效：中途修好过（状态变过）就该重新提醒 ——
// 把状态再改回失效来验这一点（否则一次收起会让下一次故障永远看不见）
writeHealthFixture('maintainer', 'EXPIRED');
await mpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await mpage.locator('.muse-banner').waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
check('收起后状态再次失效，提示栏重新出现（不受之前收起影响）', await mpage.locator('.muse-banner').isVisible().catch(() => false));

await browser.close();
restoreAll();

console.log(`\n══ 结果：通过 ${pass} 项，失败 ${fail} 项 ══`);
console.log(`截图目录：${OUT}\n`);
process.exit(fail === 0 ? 0 : 1);
