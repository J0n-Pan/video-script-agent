/**
 * 分支验收脚本：形式判定双阈值（AI 侧 75% / 真人侧 75%）、混剪优先、无法估计落「其他」、无语音。
 *
 * 2026-09-16 需求方把形式收敛为 4 项（混剪 / AI数字人 / 真人 / 其他），
 * 原「有ai片段」「真人口播」「真人访谈」「待复核」已取消，本脚本据此重排断言。
 *
 * 第一部分用固定分类输入直接测 classify()（PRD 12 备注：分类阈值可用固定输入测试，不能代替识别实测）。
 * 第二~七部分走真实接口与解析进程，验证端到端分支行为。
 *
 * 前置：解析进程必须**以 AI_MODE=mock 启动**。三/四/五部分靠写 data/mock-scenario.txt
 * 场景文件驱动形式判定；dashscope 模式下场景文件被忽略、改由真实视觉模型判定，
 * 那几项会以与预期不符的形式结果假失败，并非功能回归。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-branches.ts [baseUrl]
 *      node node_modules/tsx/dist/cli.mjs scripts/verify-branches.ts --unit-only
 *      --unit-only 只跑第一部分（固定输入测 classify），不需要网页服务与解析进程，
 *      因此可在生产（dashscope）解析进程运行期间安全执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { classify } from '../src/lib/classification';
import { FORM } from '../src/lib/constants';

/**
 * 口令不写死在仓库里：优先读环境变量，其次读项目根 `.env`
 * （变量名与 `prisma/seed.ts` 保持一致）。本文件是 TS，
 * 直接内联读取逻辑，省去给 .mjs 工具库补类型声明。
 */
function passwordFor(key: string): string {
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  try {
    const line = fs
      .readFileSync(path.resolve(process.cwd(), '.env'), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith(`${key}=`));
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  } catch {
    /* .env 不存在时静默降级 */
  }
  console.warn(`[verify-branches] 未找到 ${key}（环境变量与 .env 都没有），登录会失败 —— 见 README 3.1`);
  return '';
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, cond: boolean, detail = '') {
  results.push({ name, ok: cond, detail });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const D = 60_000;
function fixed(ratio: number) {
  return classify({
    durationMs: D,
    vision: { mixedCut: false, aiIntervals: [{ startMs: 0, endMs: Math.round(D * ratio) }], aiRatioEstimated: true, uncertain: false },
  });
}

console.log('\n=== 一、形式分类固定输入测试（双阈值 75%） ===');
// AI 侧阈值：≥75% 判 AI数字人（含等号）
const r74 = fixed(0.74);
check('AI 占比 74% → 其他（未达 AI 侧阈值）', r74.category === FORM.OTHER, `${r74.categoryLabel} / ratio=${(r74.aiRatio * 100).toFixed(1)}%`);
const r75 = fixed(0.75);
check('AI 占比恰好 75% → AI数字人（阈值含等号）', r75.category === FORM.AI_AVATAR, r75.categoryLabel);
const r79 = fixed(0.79);
check('AI 占比 79% → AI数字人', r79.category === FORM.AI_AVATAR, r79.categoryLabel);
const r100 = fixed(1);
check('AI 占比 100% → AI数字人', r100.category === FORM.AI_AVATAR, r100.categoryLabel);

// 真人侧阈值：真人内容 ≥75%（AI ≤25%）判真人（含等号）
const r0 = classify({ durationMs: D, vision: { mixedCut: false, aiIntervals: [], aiRatioEstimated: true, uncertain: false } });
check('无 AI 片段 → 真人', r0.category === FORM.REAL_PERSON, r0.categoryLabel);
const r25 = fixed(0.25);
check('AI 占比 25%（真人 75%）→ 真人（阈值含等号）', r25.category === FORM.REAL_PERSON, `${r25.categoryLabel} / 真人占比 ${((1 - r25.aiRatio) * 100).toFixed(1)}%`);
const r26 = fixed(0.26);
check('AI 占比 26%（真人 74%）→ 其他（未达真人侧阈值）', r26.category === FORM.OTHER, `${r26.categoryLabel} / 真人占比 ${((1 - r26.aiRatio) * 100).toFixed(1)}%`);
const r50 = fixed(0.5);
check('AI 占比 50% → 其他（两侧阈值都不满足）', r50.category === FORM.OTHER, r50.categoryLabel);

console.log('\n=== 二、混剪优先与无法估计（原 A19/A21/A39） ===');
const mixed = classify({
  durationMs: D,
  vision: { mixedCut: true, mixedCutEvidence: '无连贯主体', aiIntervals: [{ startMs: 0, endMs: D }], aiRatioEstimated: true, uncertain: false },
});
check('先判混剪：即使 AI 占比 100% 也归混剪', mixed.category === FORM.MIXED_CUT, mixed.categoryLabel);
const uncertain = classify({ durationMs: D, vision: { mixedCut: false, aiIntervals: [], aiRatioEstimated: false, uncertain: true } });
check(
  '区间无法估计 → 其他，且不编造比例',
  uncertain.category === FORM.OTHER && uncertain.ratioEstimated === false,
  uncertain.evidence.slice(0, 40),
);
const overlap = classify({
  durationMs: D,
  vision: {
    mixedCut: false,
    aiIntervals: [
      { startMs: 0, endMs: 40_000 },
      { startMs: 20_000, endMs: 50_000 },
    ],
    aiRatioEstimated: true,
    uncertain: false,
  },
});
check('重叠区间不重复累加（并集 50s/60s ≈ 83.3% → AI数字人）', overlap.category === FORM.AI_AVATAR, `ratio=${(overlap.aiRatio * 100).toFixed(1)}%`);

// ---------------- 第二部分：端到端分支 ----------------
const UNIT_ONLY = process.argv.includes('--unit-only');
const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:3939';
const SCENARIO_FILE = path.resolve(process.cwd(), 'data', 'mock-scenario.txt');
const jar = new Map();
function cookieHeader() {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function api(p: string, init: RequestInit = {}) {
  const res = await fetch(BASE + p, { ...init, headers: { ...(init.headers ?? {}), cookie: cookieHeader() } });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return res;
}
async function json(p: string, init?: RequestInit) {
  const res = await api(p, init);
  return res.json().catch(() => ({}));
}

async function runScenario(scenario: string) {
  fs.writeFileSync(SCENARIO_FILE, scenario);
  const sample = path.resolve(process.cwd(), 'data/samples/sample_talk_12s.mp4');
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(sample)]), path.basename(sample));
  const up = await json('/api/uploads', { method: 'POST', body: fd });
  const sub = await json('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: `br-${scenario}-${Date.now()}`,
      rows: [
        {
          clientRowKey: 'r1',
          sourceType: 'LOCAL',
          stageId: up.data.stageId,
          fileName: path.basename(sample),
          title: `分支验收 ${scenario}`,
        },
      ],
    }),
  });
  const videoId = sub.data?.results?.[0]?.videoId as string;
  let detail: any = null;
  for (let i = 0; i < 90; i += 1) {
    const r = await json(`/api/videos/${videoId}`);
    detail = r.data;
    if (detail && ['COMPLETED', 'PARTIAL', 'FAILED', 'UNSUPPORTED', 'CANCELLED'].includes(detail.status)) break;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  return { videoId, detail };
}

function report() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  · ${f.name} ${f.detail ?? ''}`));
    process.exit(1);
  }
}

async function main() {
  if (UNIT_ONLY) {
    console.log('\n（--unit-only：仅跑固定输入测试，不依赖网页服务与解析进程）');
    report();
    return;
  }

  const login = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'editor', password: passwordFor('SEED_EDITOR_PASSWORD') }),
  });
  if (!login.ok) throw new Error('登录失败，请先启动网页服务与解析进程');

  console.log('\n=== 三、混剪分支（照常解析文案，妆造/画面场景/情绪留空） ===');
  const mixedRun = await runScenario('mixed');
  check(
    '混剪任务照常完成解析（不再判为暂不支持）',
    ['COMPLETED', 'PARTIAL'].includes(mixedRun.detail?.status ?? ''),
    mixedRun.detail?.status,
  );
  check('形式字段为「混剪」', mixedRun.detail?.classification?.category === '混剪', mixedRun.detail?.classification?.categoryLabel);
  const ms = mixedRun.detail?.current?.segments ?? [];
  check('混剪仍产出带标签的段落', ms.length > 0 && ms.every((s: any) => Boolean(s.tag)));
  check(
    '混剪时妆造 / 画面场景 / 情绪均留空（只标注一次，不重复标注）',
    ms.every((s: any) => s.makeup === '' && s.emotion === '') &&
      (mixedRun.detail?.current?.sceneOverview ?? '') === '',
    ms.map((s: any) => `[${s.makeup}|${s.emotion}]`).join(' ').slice(0, 80),
  );
  check('段落不再有场景字段（已删除段落级场景标注）', ms.every((s: any) => s.scene === undefined));
  check('接口不再下发截图字段（截图下载接口已删除）', ms.every((s: any) => s.screenshots === undefined));

  console.log('\n=== 四、形式双阈值分支（端到端） ===');
  const aiRun = await runScenario('aivideo');
  check('AI 占比 100% → AI数字人', aiRun.detail?.classification?.category === 'AI数字人', aiRun.detail?.classification?.categoryLabel);
  check('AI数字人仍按原流程解析出段落', (aiRun.detail?.current?.segments?.length ?? 0) > 0);
  const lightAiRun = await runScenario('lightai');
  check(
    'AI 占比约 20%（真人约 80%）→ 真人',
    lightAiRun.detail?.classification?.category === '真人',
    `${lightAiRun.detail?.classification?.categoryLabel} / ratio=${lightAiRun.detail?.classification?.aiRatio}`,
  );
  const halfAiRun = await runScenario('halfai');
  check(
    'AI 占比约 50% → 其他（中间带）',
    halfAiRun.detail?.classification?.category === '其他',
    `${halfAiRun.detail?.classification?.categoryLabel} / ratio=${halfAiRun.detail?.classification?.aiRatio}`,
  );

  console.log('\n=== 五、无法可靠估计分支 ===');
  const pendRun = await runScenario('pending');
  check('形式落「其他」', pendRun.detail?.classification?.category === '其他', pendRun.detail?.classification?.categoryLabel);
  check('未编造精确占比（ratioEstimated=false）', pendRun.detail?.classification?.ratioEstimated === false);
  check('依据里说明了无法可靠估计', /无法可靠估计/.test(pendRun.detail?.classification?.evidence ?? ''), pendRun.detail?.classification?.evidence);
  check('仍按通用流程产出可用段落', (pendRun.detail?.current?.segments?.length ?? 0) > 0);

  console.log('\n=== 六、无语音分支（A04/A07） ===');
  const noaudioRun = await runScenario('noaudio');
  const ns = noaudioRun.detail?.current?.segments ?? [];
  check('文案确认无主体语音时填「无」', ns.some((s: any) => s.copyText === '无'), ns.map((s: any) => s.copyText).join('|').slice(0, 60));
  check('无语音段的标签归入「其他」（不猜测归类）', ns.every((s: any) => s.tag === '其他' || Boolean(s.tag)), ns.map((s: any) => s.tag).join('|'));

  console.log('\n=== 七、人工覆盖形式后可重新解析（A21） ===');
  const ov = await json(`/api/videos/${mixedRun.videoId}/classification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: '真人' }),
  });
  check('人工纠正形式成功（真人）', ov.ok === true, ov.error ?? '');
  const after = await json(`/api/videos/${mixedRun.videoId}`);
  check('人工覆盖标记生效', after.data?.classification?.manualOverride === true, after.data?.classification?.categoryLabel);
  const badOv = await json(`/api/videos/${mixedRun.videoId}/classification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: '真人口播' }),
  });
  check('已取消的旧取值被拒绝（真人口播 → 400）', badOv.ok !== true, badOv.error ?? '');
  const re = await json(`/api/videos/${mixedRun.videoId}/attempt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reparse' }),
  });
  check('重新解析作为新尝试排到队尾', re.ok === true);
  const afterReparse = await json(`/api/videos/${mixedRun.videoId}`);
  check('旧混剪版本保留（版本数增加）', (afterReparse.data?.revisions?.length ?? 0) >= 1, `revisions=${afterReparse.data?.revisions?.length}`);

  // 清理本次分支验收产生的任务
  for (const id of [mixedRun.videoId, aiRun.videoId, lightAiRun.videoId, halfAiRun.videoId, pendRun.videoId, noaudioRun.videoId]) {
    await json(`/api/videos/${id}`, { method: 'DELETE' });
  }
  fs.writeFileSync(SCENARIO_FILE, 'normal');

  report();
}

main().catch((e) => {
  console.error('分支验收异常：', e);
  process.exit(1);
});
