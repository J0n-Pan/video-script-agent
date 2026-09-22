import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creds } from './_credentials.mjs';

/**
 * 验收：「数字人任务」卡片在**页面重新进入**后仍能被找回，并且从未提交时说的是实话。
 *
 * 为什么要单独写：
 *   卡片的状态原先只存在 React state（`avatarJobId`）里 —— 点完能看到，
 *   一刷新/一离开页面再回来就整块消失，连成品下载链接一起没。
 *   这是**接线层**问题：`verify-rewrite.ts` 直接调服务端函数，照不到；
 *   所有服务端断言全绿，界面却是空的。所以这里必须走真实浏览器。
 *
 * 同时钉住 2026-09-21 修的「误导」问题：
 *   从未提交的任务不得显示「找不到对应作品记录」，而应显示「尚未提交 + 当前适配器模式」，
 *   且「重新核对平台记录」应不可点（核对一个没提交过的任务没有意义）。
 *
 * 夹具：复制一条已有改写任务的结构 → 新建临时任务 + 一条**未提交**的数字人任务（QUEUED）。
 * 不调模型、不提交平台、零费用；结束时整体删除。
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3939';
const VIDEO_ID = process.env.REWRITE_VIDEO_ID ?? 'cmu3sxgc0000gccidd95sc36j';
const PREFIX = `verify-card-${Date.now().toString(36)}`;

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

const prisma = new PrismaClient();
let fixtureJobId = null;

/* ───────── 0) 安全检查：夹具里那条 QUEUED 任务会被常驻进程认领 ───────── */
/**
 * 夹具故意造一条 **QUEUED（未提交）** 的数字人任务 —— 这正是要测的状态。
 * 但 `worker:avatar` 是轮询进程：它会把这条任务认领并推进，
 *   · mock 适配器 → 状态从「排队中」被改掉，界面断言直接假失败；
 *   · playwright 适配器 → **真的提交到平台**，费钱且污染真实作品列表。
 * 所以只要有活着的数字人进程，本脚本就拒绝运行。
 * 锁文件 `data/avatar-worker.lock` 里是 PID（进程会自我覆写，陈旧 PID 视为未运行）。
 */
const lockFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'avatar-worker.lock');
const aliveWorkerPid = (() => {
  let raw;
  try {
    raw = fs.readFileSync(lockFile, 'utf8').trim();
  } catch {
    return 0;
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return 0;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return e && e.code === 'EPERM' ? pid : 0; // EPERM = 进程在，只是没权限发信号
  }
})();
if (aliveWorkerPid) {
  console.error(`\n✋ 拒绝运行：数字人进程正在运行（PID ${aliveWorkerPid}，锁文件 data/avatar-worker.lock）`);
  console.error('   本脚本的夹具含一条 QUEUED 数字人任务，常驻进程会把它认领：');
  console.error('   mock 会被改状态导致假失败，playwright 会真的提交到平台（费钱 + 污染作品列表）。');
  console.error(`   先停进程：MSYS_NO_PATHCONV=1 taskkill /PID ${aliveWorkerPid} /F\n`);
  await prisma.$disconnect();
  process.exit(2);
}

async function cleanup() {
  if (!fixtureJobId) return;
  try {
    // 数字人任务 -> 修订 -> 候选稿 -> 任务，逐层清（避免留下悬挂的 avatarVideoJob）
    await prisma.avatarVideoJob.deleteMany({ where: { revision: { variant: { jobId: fixtureJobId } } } });
    await prisma.rewriteJob.delete({ where: { id: fixtureJobId } });
    console.log(`  （已清理夹具任务 ${fixtureJobId}）`);
  } catch (e) {
    console.warn(`  （夹具清理失败，请手动删除 ${fixtureJobId}：${e.message}）`);
  }
}

/* ───────── 1) 夹具：临时改写任务 + 一条未提交的数字人任务 ───────── */
console.log('\n══ 1) 准备夹具（复制已有任务结构，不调模型、不提交平台）══');
const owner = await prisma.user.findUnique({ where: { username: 'editor' } });
if (!owner) {
  console.error('找不到 editor 账号');
  process.exit(1);
}

const template = await prisma.rewriteJob.findFirst({
  where: {
    ownerId: owner.id,
    sourceVideoId: VIDEO_ID,
    variants: { some: { revisions: { some: { segments: { some: {} } } } } },
  },
  orderBy: { createdAt: 'desc' },
  include: {
    variants: {
      orderBy: { variantNo: 'asc' },
      include: { revisions: { orderBy: { revisionNo: 'asc' }, include: { segments: { orderBy: { orderIndex: 'asc' } } } } },
    },
  },
});
if (!template) {
  console.error(`找不到可复制的改写任务（video=${VIDEO_ID}）。先在该任务上生成一次改写。`);
  await prisma.$disconnect();
  process.exit(1);
}

const profile = await prisma.ipProfileRevision.findFirst({ where: { ownerId: owner.id, status: 'ACTIVE' } });
const job = await prisma.rewriteJob.create({
  data: {
    ownerId: owner.id,
    sourceVideoId: VIDEO_ID,
    sourceRevisionId: template.sourceRevisionId,
    ipProfileRevisionId: profile?.id ?? template.ipProfileRevisionId,
    platform: template.platform,
    variantCount: template.variantCount,
    modelId: 'fixture',
    promptVersion: template.promptVersion,
    ruleVersion: template.ruleVersion,
    inputSnapshot: template.inputSnapshot,
    status: 'SUCCEEDED',
    clientKey: PREFIX,
    finishedAt: new Date(),
  },
});
fixtureJobId = job.id;

let firstVariantId = null;
let firstRevisionId = null;
for (const v of template.variants) {
  const cur = v.revisions[0];
  const variant = await prisma.rewriteVariant.create({
    data: { jobId: job.id, variantNo: v.variantNo, diffSummary: v.diffSummary },
  });
  const rev = await prisma.rewriteRevision.create({
    data: {
      variantId: variant.id,
      revisionNo: 1,
      createdBy: 'AI',
      transcriptText: cur?.transcriptText ?? '',
      charCount: cur?.charCount ?? 0,
      estimatedDurationMs: cur?.estimatedDurationMs ?? 0,
      problemFlags: cur?.problemFlags ?? '[]',
      segments: {
        create: (cur?.segments ?? []).map((s) => ({
          orderIndex: s.orderIndex,
          sourceSegmentId: s.sourceSegmentId,
          tag: s.tag,
          copyText: s.copyText,
          factRefs: s.factRefs,
        })),
      },
    },
  });
  await prisma.rewriteVariant.update({ where: { id: variant.id }, data: { currentRevisionId: rev.id } });
  if (!firstVariantId) {
    firstVariantId = variant.id;
    firstRevisionId = rev.id;
  }
}
await prisma.rewriteSelection.create({
  data: { jobId: job.id, variantId: firstVariantId, revisionId: firstRevisionId, selectedById: owner.id },
});

// 一条**从未提交**的数字人任务：attemptCount=0、无 vendorJobId、状态排队中
const avatarJob = await prisma.avatarVideoJob.create({
  data: {
    ownerId: owner.id,
    rewriteRevisionId: firstRevisionId,
    textSnapshot: '验收用正文',
    paramsSnapshot: '{}',
    idempotencyKey: `${PREFIX}-avatar`,
    businessName: `${PREFIX}-biz`,
    status: 'QUEUED',
  },
});
console.log(`  夹具任务 ${job.id}（${template.variants.length} 版）、数字人任务 ${avatarJob.id}（QUEUED，未提交）`);

/* ───────── 2) 真实浏览器 ───────── */
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, locale: 'zh-CN' });
// 验收浏览器关掉妙思自动弹码：任何「已失效」夹具/状态都会真的发起扫码、堵住解析队列
await ctx.addInitScript(() => localStorage.setItem('museAutoLoginDisabled', '1'));
const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: creds.editor });
check('编导登录成功', (await login.json().catch(() => null))?.ok === true);

console.log('\n══ 2) 详情接口必须回填数字人任务 id（否则刷新后卡片必丢）══');
const detail = await (await ctx.request.get(`${BASE}/api/rewrites/${job.id}`)).json();
check('详情接口返回 avatarJobId', detail?.data?.avatarJobId === avatarJob.id, String(detail?.data?.avatarJobId));

const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${BASE}/tasks/${VIDEO_ID}/rewrite`, { waitUntil: 'networkidle' });
await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30000 });

console.log('\n══ 3) 重新进入页面（非点击后瞬间）：卡片是否还在 ══');
/**
 * 期望值**不能写死**：适配器模式与数字人进程是否在跑都属于运行环境，
 * 联调期 .env 会切到 playwright、worker 会常驻。所以先问接口拿到真实状态，
 * 再断言「界面显示的东西与服务端上报的状态一致」—— 这才是要钉的东西。
 */
const live = await (await ctx.request.get(`${BASE}/api/avatar-jobs/${avatarJob.id}`)).json();
const adapterMode = live?.data?.adapter?.mode;
const workerRunning = live?.data?.avatarWorkerRunning === true;
console.log(`  接口上报：适配器=${adapterMode}，数字人进程在跑=${workerRunning}`);

const chips = await page.locator('.chip').allTextContents();
const banners = (await page.locator('.banner').allTextContents()).map((b) => b.replace(/\s+/g, ' '));
check('卡片仍在（出现任务状态 chip）', chips.some((c) => c.includes('排队中')), chips.join(' | ').slice(0, 200));
check(
  `适配器标记与接口一致（${adapterMode}）`,
  adapterMode === 'mock' ? chips.some((c) => c.includes('Mock 适配器')) : chips.some((c) => c.includes('真实适配器')),
  chips.join(' | ').slice(0, 200),
);
check(
  workerRunning ? '进程在跑时不出现「数字人进程未运行」' : '进程没跑时明确提示「数字人进程未运行」',
  workerRunning ? !chips.some((c) => c.includes('数字人进程未运行')) : chips.some((c) => c.includes('数字人进程未运行')),
  chips.join(' | ').slice(0, 200),
);

const neverSubmitted = banners.find((b) => b.includes('尚未提交到平台'));
check('如实说明「尚未提交到平台」', !!neverSubmitted, banners.join(' || ').slice(0, 240));
check('不再伪造成「找不到对应作品记录」', !banners.some((b) => b.includes('找不到对应作品记录')));
check('提示语不含字面 Markdown 星号', !banners.some((b) => b.includes('**')), neverSubmitted ?? '');
check('页面无脚本异常', pageErrors.length === 0, pageErrors.join(' | '));

const reconcile = page.getByRole('button', { name: '重新核对平台记录' });
check('未提交时「重新核对平台记录」不可点', (await reconcile.count()) === 1 && (await reconcile.first().isDisabled()));

/**
 * 提交模式的界面差异（期望值同样从接口拿）。
 * assist 下必须说清「窗口开着、要你自己点生成视频」—— 否则编导会以为任务卡住了。
 */
const submitMode = live?.data?.adapter?.submitMode;
check(
  submitMode === 'assist' ? 'assist 模式下出现「人工接手模式」标记' : 'auto 模式下不出现「人工接手模式」标记',
  submitMode === 'assist'
    ? chips.some((c) => c.includes('人工接手模式'))
    : !chips.some((c) => c.includes('人工接手模式')),
  chips.join(' | ').slice(0, 200),
);
check(
  submitMode === 'assist'
    ? 'assist 模式下明确引导「去浏览器窗口里选形象并自己点生成视频」'
    : 'auto 模式下不出现人工接手引导',
  submitMode === 'assist'
    ? banners.some((b) => b.includes('人工接手模式') && b.includes('生成视频'))
    : !banners.some((b) => b.includes('人工接手模式')),
  banners.join(' || ').slice(0, 260),
);

/**
 * ───────── 4) 人工接手已取消（ASSIST_CANCELLED）─────────
 *
 * 这个状态最容易被写成「没提交过」，但两者结论相反：
 *   · 未提交（QUEUED）          → 进程／适配器还没把它送出去，该提示去查进程；
 *   · 已取消（ASSIST_CANCELLED）→ 查过平台作品列表、确认没提交，该提示去重新发起。
 * 服务端两种情况的判据在 `verify-rewrite.ts` 里钉；这里钉**界面别把两者说成一句话**。
 *
 * 卡片只显示该任务最近一条数字人任务，所以先按时间造一条更新（createdAt 自然最新）。
 */
console.log('\n══ 4) 人工接手已取消：不能与「尚未提交」混为一谈 ══');
const cancelledJob = await prisma.avatarVideoJob.create({
  data: {
    ownerId: owner.id,
    rewriteRevisionId: firstRevisionId,
    textSnapshot: '验收用正文',
    paramsSnapshot: '{}',
    idempotencyKey: `${PREFIX}-assist-cancelled`,
    businessName: `${PREFIX}-biz-cancelled`,
    // 与真实取消后的落库形状一致：无 vendorJobId、attemptCount 归零、原因留在 errorMessage
    status: 'ASSIST_CANCELLED',
    vendorJobId: null,
    submittedAt: null,
    attemptCount: 0,
    errorCode: 'AVATAR_ASSIST_CANCELLED',
    errorMessage: '人工接手未完成（协助窗口被关闭），且作品列表里查不到本任务作品名',
    reconcileNote: '',
  },
});
const cancelledDetail = await (await ctx.request.get(`${BASE}/api/rewrites/${job.id}`)).json();
check('详情接口把最新一条任务回填为「已取消」那条', cancelledDetail?.data?.avatarJobId === cancelledJob.id);

await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: '重新核对平台记录' }).first().waitFor({ state: 'visible', timeout: 30000 });
const cChips = await page.locator('.chip').allTextContents();
const cBanners = (await page.locator('.banner').allTextContents()).map((b) => b.replace(/\s+/g, ' '));

check('状态 chip 显示「人工接手已取消」', cChips.some((c) => c.includes('人工接手已取消')), cChips.join(' | ').slice(0, 200));
check(
  '不再出现「尚未提交到平台（排队中）」那条误导提示',
  !cBanners.some((b) => b.includes('尚未提交到平台')),
  cBanners.join(' || ').slice(0, 240),
);
const cancelBanner = cBanners.find((b) => b.includes('人工接手已取消'));
check('给出「没有提交到平台」的确定结论', !!cancelBanner, cBanners.join(' || ').slice(0, 240));
check('给出重新发起的出路（点「生成数字人视频」）', !!cancelBanner && cancelBanner.includes('生成数字人视频'), cancelBanner ?? '');
check('不再按「平台生成可能要十几分钟」来描述已取消的任务', !cBanners.some((b) => b.includes('平台生成可能需要十几分钟')));
check(
  '取消原因如实展示（关闭窗口 / 超时）',
  !!cancelBanner && cancelBanner.includes('取消原因'),
  cancelBanner ?? '',
);
check(
  '已取消时「重新核对平台记录」不可点',
  (await page.getByRole('button', { name: '重新核对平台记录' }).first().isDisabled()) === true,
);
check('页面无脚本异常（取消态）', pageErrors.length === 0, pageErrors.join(' | '));

/**
 * ───────── 5) 绑定平台作品：作品在平台上被改名后的出路 ─────────
 *
 * 2026-09-22 真实事故：编导在平台上把作品从 `VSA-…` 改成「信息流编导工作台测试_1」，
 * 而我们对账只认那个唯一作品名 —— 名字一改就再也找不到，一条**已经出片成功**的任务
 * 被判成「确定没提交」，`submittedAt` 被清空。
 *
 * 界面这一侧要钉的是：无平台作品 ID 时会摆出绑定入口、把「平台作品 ID 不随改名变化」
 * 这件事说清楚、且不许「没填内容就点得动」（那只会白报一个错）。
 * 服务端那侧的判据与写库形状在 `verify-rewrite.ts` 里钉（mock 适配器，零费用）。
 */
console.log('\n══ 5) 绑定平台作品：作品被改名后能不能接回来 ══');
const bindInput = page.getByPlaceholder('平台作品 ID（如 12857）或当前作品名');
const bindButton = page.getByRole('button', { name: '绑定平台作品' });
const worksButton = page.getByRole('button', { name: /从最近作品中点选|刷新最近作品/ });
const bindBanner = cBanners.find((b) => b.includes('作品名对不上'));
check('无平台作品 ID 时出现绑定入口', !!bindBanner, cBanners.join(' || ').slice(0, 300));
check('说清「平台作品 ID 不随改名变化」', !!bindBanner && bindBanner.includes('不随改名变化'), bindBanner ?? '');
check('解释改名后按作品名会找不到', !!bindBanner && bindBanner.includes('改名'), bindBanner ?? '');
check('有作品 ID / 作品名输入框', (await bindInput.count()) === 1);
check('有「绑定平台作品」按钮', (await bindButton.count()) === 1);
check('有「从最近作品中点选」入口', (await worksButton.count()) === 1);
check('没填内容时「绑定平台作品」不可点', (await bindButton.first().isDisabled()) === true);
await bindInput.first().fill('12857');
check('填了内容后「绑定平台作品」可点', (await bindButton.first().isDisabled()) === false);
await bindInput.first().fill('');

/**
 * 作品列表接口：**绝不静默返回空列表**。
 * 会话失效时必须明确报错 —— 空数组会被界面说成「这个账号没有作品」，把编导带向错误方向。
 */
const worksRes = await ctx.request.get(`${BASE}/api/avatar-works?limit=5`);
const worksBody = await worksRes.json().catch(() => null);
const worksOk = worksRes.ok() && worksBody?.ok === true && Array.isArray(worksBody?.data?.works);
if (adapterMode === 'mock') {
  check('mock 适配器下能读到平台作品列表', worksOk, `HTTP ${worksRes.status()} ${JSON.stringify(worksBody).slice(0, 160)}`);
} else {
  check(
    '真实适配器下：读到列表，或明确报错（绝不静默返回空列表）',
    worksOk || (worksRes.status() === 400 && typeof worksBody?.error === 'string' && worksBody.error.length > 0),
    `HTTP ${worksRes.status()} ${JSON.stringify(worksBody).slice(0, 200)}`,
  );
  check('作品列表接口不返回 500', worksRes.status() !== 500, `HTTP ${worksRes.status()}`);
}

/**
 * 绑定接口的前置校验：**没填内容必须被拒**（400 + 可读原因），且不能改库。
 * 这里刻意不打平台 —— 状态不符时服务端在读列表之前就会拒掉。
 */
const emptyBind = await ctx.request.post(`${BASE}/api/avatar-jobs/${cancelledJob.id}/bind`, { data: {} });
const emptyBody = await emptyBind.json().catch(() => null);
check('绑定接口：内容为空 → 400 且给出可读原因', emptyBind.status() === 400 && !!emptyBody?.error, `HTTP ${emptyBind.status()} ${JSON.stringify(emptyBody).slice(0, 160)}`);
check('绑定接口：不返回 500', emptyBind.status() !== 500, `HTTP ${emptyBind.status()}`);
const afterEmpty = await prisma.avatarVideoJob.findUnique({ where: { id: cancelledJob.id } });
check('绑定失败不改库（状态与 ID 原样）', afterEmpty.status === 'ASSIST_CANCELLED' && !afterEmpty.vendorJobId, `${afterEmpty.status} / ${afterEmpty.vendorJobId}`);
check('页面无脚本异常（绑定区块）', pageErrors.length === 0, pageErrors.join(' | '));

/**
 * 「没有数字人任务时不显示卡片」这一侧由服务端断言覆盖
 * （`verify-rewrite.ts` 的「没建过数字人任务的改写任务 → 回填 null」），
 * 这里只钉界面这一侧，避免把测试写成依赖历史列表点击顺序的脆弱形态。
 */

console.log('\n══ 清理 ══');
await browser.close();
await cleanup();
await prisma.$disconnect();

console.log(`\n══ 结果：通过 ${pass} 项，失败 ${fail} 项 ══\n`);
process.exit(fail === 0 ? 0 : 1);
