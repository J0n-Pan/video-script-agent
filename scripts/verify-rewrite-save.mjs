import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { creds } from './_credentials.mjs';

/**
 * 验收：个性化文案的「编辑 → 保存修改 → 选定本版」这一条**界面路径**（2026-09-21 修 bug）。
 *
 * 为什么要单独写这个脚本：
 *   `verify-rewrite.ts` 是直接调服务端函数 `saveVariantRevision({variantId,...})`，
 *   它证明了服务端逻辑没问题 —— 但**保存接口的路径参数用的是候选稿 id**，
 *   而界面当时把 revisionId 传了进去。服务端单测再怎么过，也照不到这层接线。
 *   所以这里必须：① 走真实 HTTP 接口；② 用真实浏览器点按钮（工作台是客户端组件，curl 会假 PASS）。
 *
 * 夹具策略：复制一条已有改写任务的输入快照与 3 版分段，新建一条**临时任务**，
 * 让界面自动选中它（列表按 createdAt 倒序）。不调模型、零费用；结束时删除，级联清干净。
 * 净内容不变：先改再改回原文，只多出两条修订记录，夹具又整体删除。
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3939';
const VIDEO_ID = process.env.REWRITE_VIDEO_ID ?? 'cmu3sxgc0000gccidd95sc36j';
const FIXTURE_KEY = `verify-save-${Date.now().toString(36)}`;

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

async function cleanup() {
  if (!fixtureJobId) return;
  try {
    // 级联：job → variants → revisions → segments / selections
    await prisma.rewriteJob.delete({ where: { id: fixtureJobId } });
    console.log(`  （已清理夹具任务 ${fixtureJobId}）`);
  } catch (e) {
    console.warn(`  （夹具清理失败，请手动删除 ${fixtureJobId}：${e.message}）`);
  }
}

/* ───────── 1) 建夹具：复制一条已有任务的结构与分段 ───────── */
console.log('\n══ 1) 准备夹具任务（复制已有任务，不调模型）══');
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
  include: { variants: { orderBy: { variantNo: 'asc' }, include: { revisions: { orderBy: { revisionNo: 'desc' }, include: { segments: { orderBy: { orderIndex: 'asc' } } } } } } },
});
if (!template) {
  console.error(`找不到可复制的改写任务（video=${VIDEO_ID}）。先在该任务上生成一次改写。`);
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`  模板任务 ${template.id}（${template.modelId}），复制 ${template.variants.length} 版结构`);

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
    clientKey: FIXTURE_KEY,
    finishedAt: new Date(),
  },
});
fixtureJobId = job.id;

const SEGS = [];
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
  SEGS.push((cur?.segments ?? []).length);
}
const segCount = SEGS[0] ?? 0;
console.log(`  夹具任务 ${job.id}：3 版，每版 ${segCount} 段`);

/* ───────── 2) 真实浏览器 ───────── */
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' });
// 验收浏览器关掉妙思自动弹码：任何「已失效」夹具/状态都会真的发起扫码、堵住解析队列
await ctx.addInitScript(() => localStorage.setItem('museAutoLoginDisabled', '1'));
const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: creds.editor });
check('编导登录成功', (await login.json().catch(() => null))?.ok === true);

console.log('\n══ 2) 接口契约：variants 必须带候选稿 id ══');
const detailRes = await ctx.request.get(`${BASE}/api/rewrites/${job.id}`);
const detail = await detailRes.json();
const firstVariant = detail?.data?.variants?.[0];
check('详情接口返回候选稿 id', typeof firstVariant?.id === 'string' && firstVariant.id.length > 0, JSON.stringify(Object.keys(firstVariant ?? {})));
check('仍返回当前修订 id（选定与提交用它）', typeof firstVariant?.revisionId === 'string' && firstVariant.revisionId.length > 0);

console.log('\n══ 3) 界面：改一段 → 保存修改 ══');
const page = await ctx.newPage();
await page.goto(`${BASE}/tasks/${VIDEO_ID}/rewrite`, { waitUntil: 'networkidle' });
await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30000 });

/**
 * 只数**可编辑**段：参考稿列现在也是 textarea（`.ref-copy`，只读，与右侧同一样式），
 * 它不是版本列的一部分；不排除掉的话计数与下标 `editIdx` 会整体错位
 * （2026-09-22 改参考稿列样式时踩到）。
 */
const tas = page.locator('textarea:not(.ref-copy)');
const total = await tas.count();
check(`界面出现 3 版共 ${3 * segCount} 个可编辑段（不含只读的参考稿列）`, total === 3 * segCount, `实际 ${total} 个可编辑 textarea`);

// 第 2 版第 1 段（前 segCount 个属于第 1 版）
const editIdx = segCount;
const original = await tas.nth(editIdx).inputValue();
const marker = '（保存校验）';
await tas.nth(editIdx).fill(original + marker);
await page.getByRole('button', { name: '保存修改' }).nth(1).click();

const okMsg = page.locator('.banner.ok').first();
await okMsg.waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
check('保存成功（提示为成功态 banner.ok）', (await okMsg.count()) > 0);
const msgText = (await page.locator('.banner').allTextContents()).join(' | ');
check('提示写明已保存为修订 2', /已保存为修订\s*2/.test(msgText), msgText.slice(0, 200));
check('没有出现失败提示', !/版本不存在|无权访问|保存失败/.test(msgText), msgText.slice(0, 200));

const selectBtn2 = page.getByRole('button', { name: '选定本版' }).nth(1);
check('保存后第 2 版「选定本版」可点（不再被未保存改动锁住）', await selectBtn2.isEnabled().catch(() => false));

console.log('\n══ 4) 改回原文再保存一次（净内容不变）══');
await tas.nth(editIdx).fill(original);
await page.getByRole('button', { name: '保存修改' }).nth(1).click();
await page.waitForTimeout(2000);
const msgText2 = (await page.locator('.banner').allTextContents()).join(' | ');
check('第二次保存成功（修订 3）', /已保存为修订\s*3/.test(msgText2), msgText2.slice(0, 200));

const variantsAfter = await prisma.rewriteVariant.findMany({
  where: { jobId: job.id },
  orderBy: { variantNo: 'asc' },
  include: { revisions: { orderBy: { revisionNo: 'asc' }, include: { segments: { orderBy: { orderIndex: 'asc' } } } } },
});
const v2 = variantsAfter.find((v) => v.variantNo === 2);
const text = (r) => r.segments.map((s) => s.copyText).join('');
check('第 2 版累计 3 条修订（原稿 + 两次保存）', v2?.revisions.length === 3, `实际 ${v2?.revisions.length}`);
check('首尾两条修订正文完全一致（改回原文确实改回来了）', v2?.revisions.length >= 3 && text(v2.revisions[0]) === text(v2.revisions[2]));
check(
  '其它版本未被波及（各只剩 1 条修订）',
  variantsAfter.filter((v) => v.variantNo !== 2).every((v) => v.revisions.length === 1),
  variantsAfter.map((v) => `v${v.variantNo}:${v.revisions.length}`).join(' '),
);

await browser.close();
await cleanup();
await prisma.$disconnect();

console.log(`\n══ 结果：通过 ${pass} 项，失败 ${fail} 项 ══\n`);
process.exit(fail === 0 ? 0 : 1);
