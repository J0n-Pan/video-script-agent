import { chromium } from 'playwright';
import fs from 'node:fs';
import { creds } from './_credentials.mjs';

/**
 * 验收：网页扫码登录链路（2026-09-20 需求迭代）。
 *
 * 这段是整案唯一有失败风险的环节（二维码在跨域 iframe 里），所以单独验：
 *   1. 维护人员 POST /api/muse/login {action:start, force:true} → worker 起无头 Chromium 开登录页
 *   2. 进度文件出现 WAITING_SCAN
 *   3. GET /api/muse/login/qr → 200 image/jpeg，且是**有效高分辨率二维码**（不是空白/占位）
 *   4. 取消 → 阶段变 CANCELLED
 *   5. **重要**：取消后健康状态仍为 EXPIRED —— 一次没完成的登录不得把状态刷成有效
 *   6. **重要**：取消不得动会话文件（force 登录取消后 mtime 不变）
 *
 * 为什么要 force：已登录状态下导航里没有「登录/注册」入口，点不出二维码，
 * 流程会（正确地）短路成 SUCCESS —— 那样本脚本就验不到二维码链路了。
 * force 不带本地登录态启动，因此**无论真实会话是否有效都能稳定拿到二维码**，
 * 断言不再依赖「会话恰好过期」这种运行时巧合。
 *
 * 刻意不真扫码：那需要人工，且会写会话。本脚本只证明「二维码能被取到并交给网页」。
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3939';
const OUT = '_scratch/muse-login';
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
// 验收脚本自己会发起登录，不需要自动弹窗再插一脚
await ctx.addInitScript(() => localStorage.setItem('museAutoLoginDisabled', '1'));

const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: creds.maintainer });
check('维护人员登录成功', (await login.json().catch(() => null))?.ok === true);

// 可重入：先清掉上一轮可能残留的等待中登录，否则 start 会返回 alreadyRunning
// 且会一直占着一个 Chromium、暂停解析队列。
const pre = await ctx.request.post(`${BASE}/api/muse/login`, { data: { action: 'cancel' } });
void pre;
for (let i = 0; i < 20; i++) {
  const j = await (await ctx.request.get(`${BASE}/api/muse/login`)).json().catch(() => null);
  const p = j?.data?.status?.phase;
  if (p !== 'STARTING' && p !== 'WAITING_SCAN') break;
  await new Promise((r) => setTimeout(r, 1500));
}

const before = await (await ctx.request.get(`${BASE}/api/muse/session`)).json();
const beforeStatus = before?.data?.health?.status;
const beforeCheckedAt = before?.data?.health?.checkedAt;
const beforeMtime = before?.data?.health?.sessionMtime;
console.log(`  （开始前状态：${beforeStatus}，检测时间 ${beforeCheckedAt}，会话文件 ${beforeMtime}）`);
console.log('\n══ 1) 发起扫码登录（force：不带本地登录态，稳定拿到二维码）══');
const start = await ctx.request.post(`${BASE}/api/muse/login`, {
  data: { action: 'start', force: true },
});
const sj = await start.json().catch(() => null);
check('start 接口返回 200', start.status() === 200, `HTTP ${start.status()} ${JSON.stringify(sj)?.slice(0, 160)}`);
check('接口回显本次是强制登录', sj?.data?.force === true, JSON.stringify(sj?.data)?.slice(0, 120));

// 轮询直到 WAITING_SCAN
let st = null;
let sawStarting = false;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const r = await ctx.request.get(`${BASE}/api/muse/login`);
  const j = await r.json().catch(() => null);
  st = j?.data?.status;
  if (st?.phase === 'STARTING') sawStarting = true;
  if (st?.phase === 'WAITING_SCAN') break;
  if (st?.phase === 'FAILED' || st?.phase === 'CANCELLED') break;
}
console.log(`  阶段：${st?.phase} · ${st?.message}`);
check('观察到 STARTING 阶段', sawStarting || st?.phase === 'WAITING_SCAN');
check('进入 WAITING_SCAN（二维码已就绪）', st?.phase === 'WAITING_SCAN', st?.message);
check('状态里带二维码更新时间 qrAt', Boolean(st?.qrAt));
check('状态里带二维码到期时间', Boolean(st?.qrExpiresAt));

console.log('\n══ 2) 取二维码图片 ══');
const qrRes = await ctx.request.get(`${BASE}/api/muse/login/qr?t=${encodeURIComponent(st?.qrAt ?? '')}`);
check('二维码接口返回 200', qrRes.status() === 200, `HTTP ${qrRes.status()}`);
check('Content-Type 是 image/jpeg', (qrRes.headers()['content-type'] ?? '').includes('image/jpeg'), qrRes.headers()['content-type']);
check('禁用了缓存（no-store）', /no-store/.test(qrRes.headers()['cache-control'] ?? ''), qrRes.headers()['cache-control']);

const buf = Buffer.from(await qrRes.body());
const dst = `${OUT}/qr-from-worker.jpg`;
fs.writeFileSync(dst, buf);
const isJpeg = buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
check('是合法 JPEG 字节', isJpeg, `首字节 ${buf.slice(0, 4).toString('hex')}`);
check('体积像真实二维码（>10KB）', buf.length > 10_000, `${buf.length} bytes`);

// 用浏览器解码图片尺寸，确认不是空白占位。
// 必须先导航到应用 origin：about:blank 是不透明 origin，fetch 会被 CORS 直接拒。
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
const dim = await page.evaluate(`(async () => {
  const res = await fetch('/api/muse/login/qr?t=${encodeURIComponent(st?.qrAt ?? '')}');
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob).catch(() => null);
  return bmp ? { w: bmp.width, h: bmp.height } : null;
})()`);
console.log(`  图片尺寸：${dim ? `${dim.w}x${dim.h}` : '解码失败'}`);
check('尺寸达到可扫描级别（≥200px）', Boolean(dim && dim.w >= 200 && dim.h >= 200), JSON.stringify(dim));

console.log('\n══ 3) 取消 ══');
const cancel = await ctx.request.post(`${BASE}/api/muse/login`, { data: { action: 'cancel' } });
check('cancel 接口返回 200', cancel.status() === 200, `HTTP ${cancel.status()}`);
let cancelled = false;
const cdeadline = Date.now() + 30_000;
while (Date.now() < cdeadline) {
  await new Promise((r) => setTimeout(r, 1500));
  const j = await (await ctx.request.get(`${BASE}/api/muse/login`)).json().catch(() => null);
  if (j?.data?.status?.phase === 'CANCELLED' || j?.data?.status?.phase === 'FAILED') {
    cancelled = true;
    console.log(`  阶段：${j.data.status.phase} · ${j.data.status.message}`);
    break;
  }
}
check('取消后阶段变为 CANCELLED/FAILED', cancelled);

console.log('\n══ 4) 取消不得污染健康状态 ══');
const after = await (await ctx.request.get(`${BASE}/api/muse/session`)).json();
const afterStatus = after?.data?.health?.status;
console.log(`  （结束后状态：${afterStatus}）`);
// 断言「没被改动」而不是硬编码某个取值：真实会话可能本来就是有效的，
// 写死 EXPIRED 的断言只在会话恰好过期时才成立，不能入库。
check(`健康状态未被取消动作改变（仍为 ${beforeStatus}）`, afterStatus === beforeStatus, `${beforeStatus} → ${afterStatus}`);
check('未把状态误刷成 VALID（除非本来已是 VALID）', beforeStatus === 'VALID' || afterStatus !== 'VALID', `实际 ${afterStatus}`);
// 取消掉的一次强制登录绝不能覆盖会话文件（否则会把可用会话换成一个空会话）
check(
  '取消不得覆盖会话文件（mtime 未变）',
  after?.data?.health?.sessionMtime === beforeMtime,
  `${beforeMtime} → ${after?.data?.health?.sessionMtime}`,
);

// 收尾：确认取消后二维码接口不再对外提供（避免陈旧码被扫）
const qrAfter = await ctx.request.get(`${BASE}/api/muse/login/qr`);
check('取消后取二维码返回 404', qrAfter.status() === 404, `HTTP ${qrAfter.status()}`);

await browser.close();
console.log(`\n══ 结果：通过 ${pass} 项，失败 ${fail} 项 ══`);
console.log(`二维码留档：${dst}\n`);
process.exit(fail === 0 ? 0 : 1);
