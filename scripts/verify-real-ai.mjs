/**
 * 真实模型端到端验证（非 Mock）：提交带真实中文语音的测试素材，跑完整流水线并打印真实识别结果。
 *
 * 前置：
 *   1. .env 中 AI_MODE=dashscope 且 DASHSCOPE_API_KEY 有效
 *   2. 网页与解析进程都已启动（npm run dev）
 *   3. 已生成测试素材：npm run make:speech-media
 *
 * 用法：node scripts/verify-real-ai.mjs [baseUrl] [素材路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { creds } from './_credentials.mjs';
import { PrismaClient } from '@prisma/client';

/** 页面接口只暴露汇总费用，逐条调用明细与语音引用直接从库里取（本脚本是开发期工具） */
const prisma = new PrismaClient();

const BASE = process.argv[2] ?? 'http://127.0.0.1:3939';
const MEDIA = process.argv[3] ?? path.resolve(process.cwd(), 'data/test-media/speech-full.mp4');

const cookieJar = new Map();
const cookieHeader = () =>
  Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookieJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function api(p, init = {}) {
  const res = await fetch(BASE + p, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: cookieHeader() },
    redirect: 'manual',
  });
  storeCookies(res);
  return res;
}
async function json(p, init) {
  const res = await api(p, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const results = [];
function check(name, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const TERMINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'UNSUPPORTED', 'CANCELLED'];

async function main() {
  console.log(`\n=== 真实模型端到端验证 @ ${BASE} ===`);
  console.log(`素材：${MEDIA}\n`);
  if (!fs.existsSync(MEDIA)) {
    throw new Error(`缺少素材：${MEDIA}，请先运行 npm run make:speech-media`);
  }

  const login = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds.editor),
  });
  check('登录成功', login.body.ok === true);

  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(MEDIA)]), path.basename(MEDIA));
  const up = await json('/api/uploads', { method: 'POST', body: fd });
  check('上传成功', up.body.ok === true, up.body.error ?? '');
  const stageId = up.body.data.stageId;

  const title = `真实模型验证 ${new Date().toLocaleTimeString('zh-CN')}`;
  const submit = await json('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: `real-${Date.now()}`,
      rows: [{
        clientRowKey: 'r1',
        sourceType: 'LOCAL',
        stageId,
        fileName: path.basename(MEDIA),
        title,
        originalPath: MEDIA,
        referenceUrl: 'https://example.com/reference',
      }],
    }),
  });
  const videoId = submit.body.data?.results?.[0]?.videoId;
  check('提交成功', Boolean(videoId), submit.body.error ?? '');
  if (!videoId) process.exit(1);

  console.log('\n  等待真实模型处理（音频实时推流 + 视觉 + 整理）…\n');
  const t0 = Date.now();
  let d = null;
  for (let i = 0; i < 300; i++) {
    const r = await json(`/api/videos/${videoId}`);
    d = r.body.data;
    if (d && TERMINAL.includes(d.status)) break;
    if (i % 5 === 0 && d?.currentStageLabel) {
      process.stdout.write(`\r  阶段：${d.currentStageLabel}（${((Date.now() - t0) / 1000).toFixed(0)}s）   `);
    }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  console.log(`\r  处理结束，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s            \n`);

  check('任务走到终态', TERMINAL.includes(d?.status), `status=${d?.status} (${d?.statusLabel})`);
  check(
    '生成了脚本版本',
    Boolean(d?.current) && (d?.current?.segments ?? []).length > 0,
    `v${d?.current?.versionNo}，${(d?.current?.segments ?? []).length} 段`,
  );
  check('形式已判定', Boolean(d?.classification?.categoryLabel), d?.classification?.categoryLabel ?? '无');
  check('存在当前截图', (d?.current?.segments ?? []).some((s) => (s.screenshots ?? []).length > 0));

  const cls = d?.classification;
  if (cls) {
    console.log('\n── 形式判定 ──');
    console.log(`  形式：${cls.categoryLabel}`);
    // 未估计时不能显示 0%，否则看起来像「确定没有 AI 画面」
    console.log(
      `  AI 占比：${cls.ratioEstimated ? `${(cls.aiRatio * 100).toFixed(1)}%` : '未估计（不编造精确比例）'}`,
    );
    console.log(`  人工覆盖：${cls.manualOverride ? '是' : '否'}`);
    console.log(`  依据：${cls.evidence || '（空）'}`);
  }

  const segs = d?.current?.segments ?? [];
  console.log(`\n── 真实识别结果（${segs.length} 段）──`);
  for (const s of segs) {
    // orderIndex 在库中即为 1-based 展示序号，不再 +1
    console.log(`  ${String(s.orderIndex).padStart(2)}  ${s.startMs}–${s.endMs}ms`);
    console.log(`      文案：${s.copyText}`);
    console.log(`      标签：${s.tag ?? '（无）'}`);
    console.log(`      妆造：${s.makeup} ｜ 场景：${s.scene} ｜ 情绪：${s.emotion}`);
    if ((s.screenshots ?? []).length) {
      console.log(`      截图：${s.screenshots.length} 张`);
    }
  }

  console.log('\n── 模型调用与费用 ──');
  const usages = await prisma.modelUsage.findMany({
    where: { attempt: { videoId } },
    orderBy: { callNo: 'asc' },
  });
  for (const u of usages) {
    const parts = [u.capability, u.modelId, u.status];
    if (u.audioSeconds !== null) parts.push(`${u.audioSeconds}s`);
    if (u.inputTokens !== null || u.outputTokens !== null) parts.push(`tok ${u.inputTokens ?? '?'}/${u.outputTokens ?? '?'}`);
    if (u.thinkingTokens) parts.push(`思考 ${u.thinkingTokens}`);
    parts.push(u.estimatedCost === null ? '费用待核对' : `¥${Number(u.estimatedCost).toFixed(4)}`);
    const ms = u.finishedAt && u.startedAt ? u.finishedAt.getTime() - u.startedAt.getTime() : null;
    if (ms !== null) parts.push(`${(ms / 1000).toFixed(1)}s`);
    console.log(`  ${parts.join(' ｜ ')}`);
    if (u.errorMessage) console.log(`      依据：${u.errorMessage}`);
  }
  const total = usages.reduce((s, u) => s + (u.estimatedCost ?? 0), 0);
  const cost = d?.cost ?? {};
  console.log(
    `  合计：¥${total.toFixed(4)}（接口口径 ¥${cost.estimatedTotal ?? 0}，${cost.calls ?? 0} 次调用，` +
      `${cost.usagePending ?? 0} 条待核对，单价版本 ${cost.priceVersion ?? '?'}）`,
  );

  const problems = d?.current?.problems ?? [];
  if (problems.length) {
    console.log('\n── 校验问题 ──');
    for (const p of problems) console.log(`  [${p.severity ?? 'info'}] ${p.code ?? ''} ${p.message ?? JSON.stringify(p)}`);
  } else {
    console.log('\n  校验问题：无');
  }

  // 导出验证
  const exp = await json('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ videoId }], confirm: true }),
  });
  const exportId = exp.body.data?.exportId;
  check('导出成功', exp.body.data?.stage === 'DONE' && Boolean(exportId), JSON.stringify(exp.body.data ?? exp.body).slice(0, 160));
  if (exportId) {
    const dl = await api(`/api/exports/${exportId}/download`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const outDir = path.resolve(process.cwd(), 'data/exports');
    const name = (dl.headers.get('content-disposition') ?? '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
    const out = path.join(outDir, decodeURIComponent(name ?? `${title}.xlsx`));
    fs.writeFileSync(out, buf);
    console.log(`\n导出文件：${out}（${(buf.length / 1024).toFixed(0)}KB）`);
    check('导出文件可下载且非空', buf.length > 0);
  }

  await prisma.$disconnect();

  const passed = results.filter(Boolean).length;
  console.log(`\n=== 结果：${passed}/${results.length} 项通过 ===`);
  console.log(`视频详情页：${BASE}/tasks/${videoId}\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('验证异常：', e);
  process.exit(1);
});
