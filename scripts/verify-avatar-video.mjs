import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import { creds } from './_credentials.mjs';

/**
 * 验收：**成品出来之后**这一整段 —— 工作台能看到吗、能播吗、下载下来的是不是同一个文件。
 *
 * 为什么单独写：
 *   2026-09-21 才第一次真实跑通「平台创作完成 → 取回成品 → 落盘」这条路
 *   （此前三条真实提交全部被平台判失败，取回分支一次都没执行过）。
 *   而这条路上每一步都可能悄悄坏掉，且**都不会让状态机报错**：
 *     · 卡片不显示成品 → 界面问题（`verify-rewrite` 照不到，它只调服务端函数）；
 *     · `<video>` 有 src 但读不到元数据 → 媒体地址白名单/路由问题；
 *     · 下载接口吐的字节数与落盘文件不符 → 下载路由问题。
 *   所以断言必须落在**真实浏览器渲染出来的东西**上，并且真的把文件下下来对 sha256。
 *
 * 为什么不能写死一个任务 ID：
 *   它依赖「库里存在一条 SUCCEEDED 且带成品的数字人任务」这个**真实业务数据**。
 *   全新克隆的仓库没有这种数据 —— 那种情况下明确跳过（退出码 0），而不是报红。
 *
 * 用法：
 *   npm run verify:avatar-video                # 自动取最近一条已完成的数字人任务
 *   npm run verify:avatar-video -- <jobId>     # 指定任务
 *
 * 零模型费用、零平台额度（只读本地成品与本地接口）。
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3939';

let pass = 0;
let fail = 0;
const check = (n, c, extra = '') => {
  if (c) {
    pass++;
    console.log(`  ✅ ${n}`);
  } else {
    fail++;
    console.log(`  ❌ ${n}${extra ? `  —— ${extra}` : ''}`);
  }
};

const p = new PrismaClient();
const wantId = process.argv[2] ?? null;

/** 该改写任务下**最新**的一条数字人任务 —— 界面卡片显示的就是它（latestAvatarJobIdForRewriteJob） */
async function newestOfRewriteJob(rewriteJobId) {
  return p.avatarVideoJob.findFirst({
    where: { revision: { variant: { jobId: rewriteJobId } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
}

let job = await p.avatarVideoJob.findFirst({
  where: { status: 'SUCCEEDED', ...(wantId ? { id: wantId } : {}), assets: { some: { status: 'READY' } } },
  orderBy: { finishedAt: 'desc' },
  include: {
    assets: { where: { status: 'READY' }, orderBy: { createdAt: 'desc' }, take: 1 },
    revision: { include: { variant: { include: { job: { select: { sourceVideoId: true } } } } } },
  },
});

/**
 * ⚠️ 选中的成品任务必须**就是界面卡片当前显示的那一条**，否则断言必然假失败（2026-09-22 踩到）：
 * 卡片只显示「该改写任务下最新的一条数字人任务」，而这里默认取的是「全局最新的成功任务」。
 * 只要有人在同一改写任务上又点了一次「生成数字人视频」（哪怕它还在排队），两者就分叉 ——
 * 页面上当然没有成品播放器，可成品明明好端端在库里。
 * 所以：若该改写任务下有更新的一条，就改测它；它没有成品（还在排队/失败）则**如实跳过**，不报红。
 */
if (job) {
  const newest = await newestOfRewriteJob(job.revision.variant.jobId);
  if (newest && newest.id !== job.id) {
    const alt = await p.avatarVideoJob.findFirst({
      where: { id: newest.id, status: 'SUCCEEDED', assets: { some: { status: 'READY' } } },
      include: {
        assets: { where: { status: 'READY' }, orderBy: { createdAt: 'desc' }, take: 1 },
        revision: { include: { variant: { include: { job: { select: { sourceVideoId: true } } } } } },
      },
    });
    if (!alt) {
      console.log(`\n⏭  跳过：这条改写任务下更新的一条数字人任务是 ${newest.id}（${newest.status}），没有成品。`);
      console.log('    界面卡片按设计只显示最新那条，此时页面上不该出现成品播放器 —— 拿它当失败是误报。');
      console.log('    想验成品那一条，先让更新的任务跑完，或把它清掉（并确认上游是你要的状态）。');
      console.log(`    （已完成的成品任务：${job.id} / 平台作品 ${job.vendorJobId ?? '-'}）`);
      await p.$disconnect();
      process.exit(0);
    }
    console.log(`\n注：该改写任务下更新的一条是 ${newest.id}，且它也有成品 —— 改测这一条（与界面一致）。`);
    job = alt;
  }
}

if (!job || !job.assets[0]) {
  console.log('\n⏭  跳过：库里没有「已完成且带成品」的数字人任务。');
  console.log('    （这是依赖真实平台产出的验收，全新环境没有这类数据属正常。）');
  if (wantId) console.log(`    指定的是 ${wantId}，但它不是 SUCCEEDED 或没有 READY 成品。`);
  await p.$disconnect();
  process.exit(0);
}

const asset = job.assets[0];
const VIDEO_ID = job.revision.variant.job.sourceVideoId;
console.log(`\n验收对象：数字人任务 ${job.id}`);
console.log(`  平台作品 ID ${job.vendorJobId ?? '-'}   作品名 ${job.businessName}`);
console.log(`  成品 ${asset.filePath}`);
console.log(`  ${(Number(asset.sizeBytes) / 1048576).toFixed(2)}MB  ${asset.durationMs}ms  ${asset.width}x${asset.height}  audio=${asset.hasAudio}`);

// 工作台没在跑就直接说清楚，别让后续断言变成一堆误报
try {
  const probe = await fetch(`${BASE}/`, { redirect: 'manual' });
  if (probe.status >= 500) throw new Error(`HTTP ${probe.status}`);
} catch (e) {
  console.error(`\n✋ 工作台没在跑（${BASE} 不可达：${e.message}）。先执行 npm run dev:web 或双击 start-workbench.bat。`);
  await p.$disconnect();
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1200 }, locale: 'zh-CN' });
// 验收浏览器关掉妙思自动弹码：任何「已失效」夹具/状态都会真的发起扫码、堵住解析队列
await ctx.addInitScript(() => localStorage.setItem('museAutoLoginDisabled', '1'));
const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: creds.editor });
check('编导登录成功', (await login.json().catch(() => null))?.ok === true);

const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

console.log('\n══ 1) 重新进入生成页：卡片呈现「已完成 + 成品」══');
await page.goto(`${BASE}/tasks/${VIDEO_ID}/rewrite`, { waitUntil: 'networkidle' });
await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 60000 });
await page.waitForTimeout(3000);

const chips = await page.locator('.chip').allTextContents();
check('出现「已完成」状态 chip', chips.some((c) => c.includes('已完成')), chips.join(' | ').slice(0, 200));
check('不残留「待核对」', !chips.some((c) => c.includes('待核对')));
check('不残留排队/生成中', !chips.some((c) => c.includes('排队中') || c.includes('平台生成中')));

const banners = (await page.locator('.banner').allTextContents()).map((b) => b.replace(/\s+/g, ' '));
check('无失败类提示', !banners.some((b) => b.includes('生成失败')), banners.join(' || ').slice(0, 240));

console.log('\n══ 2) 播放器与下载入口 ══');
const video = page.locator(`video[src*="${job.id}"]`).first();
check('有指向该任务的播放器', (await video.count()) > 0);
const src = await video.getAttribute('src').catch(() => null);
const dl = page.locator(`a[href*="${job.id}"][download]`).first();
check('有下载链接', (await dl.count()) > 0);
if (!src) {
  console.log('  （拿不到 video src，后续播放/下载断言无法进行）');
  await browser.close();
  await p.$disconnect();
  console.log(`\n══ 结果：通过 ${pass} 项，失败 ${fail + 1} 项 ══`);
  process.exit(1);
}
console.log(`  video src: ${src}`);

console.log('\n══ 3) 播放器真的能出帧（不是只有 src 的空壳）══');
await video.evaluate((el) => el.play().catch(() => undefined)).catch(() => undefined);
await page.waitForTimeout(6000);
const vinfo = await video
  .evaluate((el) => ({ readyState: el.readyState, duration: el.duration, w: el.videoWidth, h: el.videoHeight, current: el.currentTime }))
  .catch(() => null);
console.log(`  ${JSON.stringify(vinfo)}`);
check('已加载到可播放状态（readyState ≥ 2）', (vinfo?.readyState ?? 0) >= 2, String(vinfo?.readyState));
check('时长与库内一致（±1s）', Math.abs((vinfo?.duration ?? 0) * 1000 - asset.durationMs) < 1000, `${vinfo?.duration}s vs ${asset.durationMs}ms`);
check('分辨率与库内一致', vinfo?.w === asset.width && vinfo?.h === asset.height, `${vinfo?.w}x${vinfo?.h} vs ${asset.width}x${asset.height}`);
check('播放进度真的在走', (vinfo?.current ?? 0) > 0, `currentTime=${vinfo?.current}`);

console.log('\n══ 4) 下载下来的就是落盘的那一个文件 ══');
const abs = src.startsWith('http') ? src : `${BASE}${src}`;
const head = await ctx.request.get(abs, { headers: { Range: 'bytes=0-1023' } });
check('下载接口返回 200/206', head.status() === 200 || head.status() === 206, String(head.status()));
check('Content-Type 为视频', /video|octet-stream/.test(head.headers()['content-type'] ?? ''), head.headers()['content-type']);
const headBuf = await head.body();
check('是合法 MP4（前部含 ftyp box）', headBuf.includes(Buffer.from('ftyp')), headBuf.slice(0, 16).toString('hex'));

const full = await ctx.request.get(abs);
const fullBuf = await full.body();
check('完整下载字节数与库内一致', fullBuf.byteLength === Number(asset.sizeBytes), `${fullBuf.byteLength} vs ${asset.sizeBytes}`);
const sha = crypto.createHash('sha256').update(fullBuf).digest('hex');
check('完整下载 sha256 与库内一致', sha === asset.sha256, `${sha.slice(0, 16)} vs ${asset.sha256?.slice(0, 16)}`);

check('页面无脚本异常', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
await p.$disconnect();
console.log(`\n══ 结果：通过 ${pass} 项，失败 ${fail} 项 ══`);
process.exit(fail === 0 ? 0 : 1);
