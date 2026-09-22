import fs from 'node:fs';
import { chromium } from 'playwright';
import { creds } from './_credentials.mjs';

/**
 * 验收：探测节流（TTL）真的生效 —— 结论新鲜时不得再投探测请求。
 *
 * 背景（2026-09-20 实测踩到）：healthTtlMs() 原先写成
 *   Number(process.env.MUSE_HEALTH_TTL_MS ?? '')
 * 而 `Number('') === 0`，于是环境变量没配时 TTL 变成 0 →
 * 结论永远「已过期」→ 每次打开页面都投一次探测（日志里出现 18 次）。
 * 本脚本就是防这个回归：结论新鲜时，control.json 里的 probeRequestedAt 必须一动不动。
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3939';
// 2026-09-22 起会话按用户隔离：control/health 都在 users/<userId>/ 下（这里看维护人员的）
let CONTROL = '';
let HEALTH = '';

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

const readControl = () => {
  try {
    return JSON.parse(fs.readFileSync(CONTROL, 'utf8'));
  } catch {
    return {};
  }
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
// 验收浏览器一律关掉自动弹码：夹具/过期结论会真的触发扫码，堵住解析队列
await ctx.addInitScript(() => localStorage.setItem('museAutoLoginDisabled', '1'));
const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: creds.maintainer });
const loginBody = await login.json().catch(() => null);
if (!loginBody?.ok) throw new Error('维护人员登录失败');
const M_UID = loginBody.data.id;
CONTROL = `data/muse-session/users/${M_UID}/control.json`;
HEALTH = `data/muse-session/users/${M_UID}/health.json`;

console.log('\n══ 1) 先强制探一次，拿到新鲜结论 ══');
const before = await (await ctx.request.get(`${BASE}/api/muse/session`)).json();
const beforeCheckedAt = before?.data?.health?.checkedAt;
await ctx.request.post(`${BASE}/api/muse/session`, { data: { action: 'probe' } });

let freshened = false;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const j = await (await ctx.request.get(`${BASE}/api/muse/session`)).json().catch(() => null);
  if (j?.data?.health?.checkedAt && j.data.health.checkedAt !== beforeCheckedAt) {
    freshened = true;
    console.log(`  结论已刷新：${j.data.health.checkedAt}`);
    break;
  }
}
check('探测完成，结论已刷新', freshened);

const probeAt1 = readControl().probeRequestedAt;
console.log(`  probeRequestedAt = ${probeAt1}`);

console.log('\n══ 2) 连续访问工作台，结论新鲜时不该再投请求 ══');
const page = await ctx.newPage();
for (const path of ['/tasks', '/tasks/new', '/export', '/settings/ip-profile', '/settings/muse-session', '/tasks']) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await ctx.request.get(`${BASE}/api/muse/session`);
  await ctx.request.get(`${BASE}/api/muse/session`);
}
await page.waitForTimeout(2500);

const afterState = await (await ctx.request.get(`${BASE}/api/muse/session`)).json();
const probeAt2 = readControl().probeRequestedAt;
console.log(`  probeRequestedAt = ${probeAt2}`);

check('结论被判定为新鲜（stale=false）', afterState?.data?.stale === false, String(afterState?.data?.stale));
check('连续 12 次接口调用 + 6 次页面加载后，未投出新的探测请求', probeAt1 === probeAt2, `${probeAt1} → ${probeAt2}`);
check('TTL 为设计值 15 分钟', afterState?.data?.ttlMs === 15 * 60 * 1000, String(afterState?.data?.ttlMs));
check('probePending 已回落为 false', afterState?.data?.probePending === false, String(afterState?.data?.probePending));

console.log('\n══ 3) 过期结论仍应被重新探测 ══');
// 直接把 health.json 的 checkedAt 改到很久以前，模拟 TTL 过期

const raw = JSON.parse(fs.readFileSync(HEALTH, 'utf8'));
const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
fs.writeFileSync(HEALTH, JSON.stringify({ ...raw, checkedAt: old }, null, 2));

const staleResp = await (await ctx.request.get(`${BASE}/api/muse/session`)).json();
check('结论过期时被判定为 stale', staleResp?.data?.stale === true, String(staleResp?.data?.stale));
await new Promise((r) => setTimeout(r, 2500));
const probeAt3 = readControl().probeRequestedAt;
check('过期后重新投出探测请求', probeAt3 !== probeAt2, `${probeAt2} → ${probeAt3}`);

await browser.close();
console.log(`\n══ 结果：通过 ${pass} 项，失败 ${fail} 项 ══`);
process.exit(fail === 0 ? 0 : 1);
