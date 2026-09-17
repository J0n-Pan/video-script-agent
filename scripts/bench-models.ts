/**
 * 模型横向对比自检 —— 用同一份真实素材，比较候选模型在「三大需求」上的输出与费用。
 *
 * 三大需求（PRD 10.5）：
 *   1) 音频识别：把语音转成带句级时间戳的原文片段（独立于文案，供原文保真校验）
 *   2) 画面理解：逐帧描述妆造 / 场景 / 情绪，并给出形式与 AI 画面区间建议
 *   3) 脚本整理：引用原始语音片段，组织成固定九列
 *
 * 只读：不写数据库、不修改 .env、不产生导出文件；仅在 data/tmp 下生成临时帧与音轨。
 *
 * 用法：
 *   tsx scripts/bench-models.ts                       # 全部三项对比
 *   tsx scripts/bench-models.ts --only=asr            # 只比语音识别
 *   tsx scripts/bench-models.ts --only=vision
 *   tsx scripts/bench-models.ts --only=organize
 *   tsx scripts/bench-models.ts --file 路径.mp4        # 指定素材（默认内置中文语音测试素材）
 *   tsx scripts/bench-models.ts --frames 6            # 视觉取样帧数（默认沿用 VISION_SAMPLE_COUNT）
 *
 * 价格口径：华北2（北京），核对日 2026-09-14，来源为百炼各模型官方页。
 * 仅供横向比较，实际以阿里云账单为准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../src/lib/config';
import { probeMedia, extractSampledFrames, extractAudio } from '../src/lib/ffmpeg';
import { FORM, FORM_LABEL } from '../src/lib/constants';
import { ORGANIZE_RULES } from '../src/lib/organize-rules';
import { checkTranscriptFidelity } from '../src/lib/validate';
import { DashscopeOrganizeAdapter, DashscopeVisionAdapter } from '../src/lib/ai/dashscope';
import { DashscopeRealtimeAudioAdapter } from '../src/lib/ai/dashscope/realtime-asr';
import type {
  AudioUtterance,
  OrganizeSegmentInput,
  Usage,
  VisionFrameResult,
} from '../src/lib/ai/types';

/** 运行期改写适配器读取的模型名（cfg 只在启动时组装一次，对象本身可写） */
const ds = cfg.dashscope as unknown as {
  asrModel: string;
  visionModel: string;
  organizeModel: string;
};

type TokenTier = { maxInputTokens: number; input: number; output: number };
type Price = { kind: 'audio'; perSecond: number } | { kind: 'token'; tiers: TokenTier[] };

const PRICES: Record<string, Price> = {
  'paraformer-realtime-v2': { kind: 'audio', perSecond: 0.00024 },
  'fun-asr-realtime': { kind: 'audio', perSecond: 0.00033 },
  'qwen3-vl-plus': {
    kind: 'token',
    tiers: [
      { maxInputTokens: 32_000, input: 1, output: 10 },
      { maxInputTokens: 128_000, input: 1.5, output: 15 },
      { maxInputTokens: 256_000, input: 3, output: 30 },
    ],
  },
  'qwen3-vl-flash': {
    kind: 'token',
    tiers: [
      { maxInputTokens: 32_000, input: 0.15, output: 1.5 },
      { maxInputTokens: 128_000, input: 0.3, output: 3 },
      { maxInputTokens: 256_000, input: 0.6, output: 6 },
    ],
  },
  'qwen3.8-flash': {
    kind: 'token',
    tiers: [{ maxInputTokens: 1_000_000, input: 0.8, output: 2.7 }],
  },
  'qwen3.8-max': {
    kind: 'token',
    tiers: [{ maxInputTokens: 1_000_000, input: 12, output: 36 }],
  },
  'qwen3.7-plus': {
    kind: 'token',
    tiers: [
      { maxInputTokens: 256_000, input: 2, output: 8 },
      { maxInputTokens: 1_000_000, input: 6, output: 24 },
    ],
  },
  'qwen3.7-flash': {
    kind: 'token',
    tiers: [
      { maxInputTokens: 32_000, input: 0.2, output: 0.8 },
      { maxInputTokens: 256_000, input: 0.6, output: 2.4 },
      { maxInputTokens: 1_000_000, input: 1.2, output: 4.8 },
    ],
  },
  'qwen-plus': {
    kind: 'token',
    tiers: [
      { maxInputTokens: 128_000, input: 0.8, output: 2 },
      { maxInputTokens: 256_000, input: 2.88, output: 24 },
      { maxInputTokens: 1_000_000, input: 5.76, output: 57.6 },
    ],
  },
  'qwen3-max': {
    kind: 'token',
    tiers: [
      { maxInputTokens: 32_000, input: 2.5, output: 10 },
      { maxInputTokens: 128_000, input: 4, output: 16 },
      { maxInputTokens: 256_000, input: 7, output: 28 },
    ],
  },
};

/**
 * 候选清单（可改；默认覆盖「当前在用 + 官方当前推荐 + 同代上/下一档」）。
 * 实测记录（2026-09-14，19.2s 素材、9 帧）：
 *   qwen3.8-max  9 帧 ¥0.4048 / 167.4s（输出 8500 tok，思考开销大）→ 默认不纳入，性价比不成立
 *   qwen3-asr-flash-realtime 北京区 ModelNotFound（官方标注部署范围为国际）
 */
const ASR_CANDIDATES = [
  'paraformer-realtime-v2',
  'fun-asr-realtime',
  'qwen-audio-3.0-asr-flash-streaming',
  'qwen3-asr-flash-realtime',
];
const VISION_CANDIDATES = ['qwen3-vl-plus', 'qwen3-vl-flash', 'qwen3.8-flash'];
const ORGANIZE_CANDIDATES = ['qwen-plus', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3-max'];

function yuan(n: number): string {
  if (n < 0.0001) return `¥${n.toFixed(6)}`;
  return `¥${n.toFixed(4)}`;
}

function costOf(modelId: string, usage: Usage, audioSeconds: number): number | null {
  const p = PRICES[modelId];
  if (!p) return null;
  if (usage.usageMissing) return null;
  if (p.kind === 'audio') return audioSeconds * p.perSecond;
  const i = usage.inputTokens ?? 0;
  const o = usage.outputTokens ?? 0;
  const tier = p.tiers.find((t) => i <= t.maxInputTokens) ?? p.tiers[p.tiers.length - 1];
  return (i * tier.input) / 1e6 + (o * tier.output) / 1e6;
}

const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

const ONLY = arg('only') || '';
const MEDIA = arg('file')
  ? path.resolve(arg('file') as string)
  : path.resolve(process.cwd(), 'data/test-media/speech-full.mp4');

const bar = (s: string) => console.log(`\n${'─'.repeat(8)} ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`);

/** 单个候选的对比结果 */
type Row = {
  modelId: string;
  ok: boolean;
  seconds: number;
  cost: number | null;
  detail: string;
  note?: string;
};

async function benchAsr(audioPath: string, durationMs: number, rows: Row[]): Promise<AudioUtterance[]> {
  bar('需求 1／音频识别（句级时间戳 + 原文）');
  let baseline: AudioUtterance[] = [];
  for (const model of ASR_CANDIDATES) {
    ds.asrModel = model;
    const adapter = new DashscopeRealtimeAudioAdapter();
    const t0 = Date.now();
    try {
      const out = await adapter.recognize({
        audioPath,
        durationMs,
        language: 'zh',
        hasAudio: true,
      });
      const sec = (Date.now() - t0) / 1000;
      const audioSeconds = out.usage.audioSeconds ?? durationMs / 1000;
      const cost = costOf(model, out.usage, audioSeconds);
      const sentences = out.utterances;
      if (model === 'paraformer-realtime-v2') baseline = sentences;
      const err = out.issues.filter((i) => i.severity === 'error');
      rows.push({
        modelId: model,
        ok: err.length === 0 && sentences.length > 0,
        seconds: sec,
        cost,
        detail: `${sentences.length} 句 ｜ ${audioSeconds.toFixed(1)}s 音频 ｜ ${err.length ? err[0].message.slice(0, 40) : '无错误'}`,
        note: sentences.length ? undefined : '未产出句子',
      });
      console.log(`\n【${model}】${sentences.length} 句，耗时 ${sec.toFixed(1)}s，费用 ${cost === null ? '待核对' : yuan(cost)}`);
      for (const s of sentences) {
        console.log(`   ${String(s.startMs).padStart(6)}–${String(s.endMs).padEnd(6)}ms  ${s.unclear ? '(听不清) ' : ''}${s.text}`);
      }
      for (const i of out.issues) console.log(`   [${i.severity}] ${i.code} ${i.message.slice(0, 90)}`);
    } catch (e) {
      const sec = (Date.now() - t0) / 1000;
      rows.push({
        modelId: model,
        ok: false,
        seconds: sec,
        cost: null,
        detail: '调用失败',
        note: (e as Error).message.replace(/\s+/g, ' ').slice(0, 110),
      });
      console.log(`\n【${model}】调用失败（${sec.toFixed(1)}s）：${(e as Error).message.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  return baseline;
}

async function benchVision(
  mediaPath: string,
  durationMs: number,
  frames: Array<{ timeMs: number; path: string }>,
  rows: Row[],
): Promise<VisionFrameResult[]> {
  bar('需求 2／画面理解（妆造 / 场景 / 情绪 + 形式建议）');
  let baseline: VisionFrameResult[] = [];
  for (const model of VISION_CANDIDATES) {
    ds.visionModel = model;
    const adapter = new DashscopeVisionAdapter();
    const t0 = Date.now();
    try {
      const out = await adapter.analyze({ durationMs, frames });
      const sec = (Date.now() - t0) / 1000;
      const cost = costOf(model, out.usage, 0);
      if (baseline.length === 0) baseline = out.frames;
      const desc = out.frames.filter((f) => f.scene && f.scene.length > 1).length;
      rows.push({
        modelId: model,
        ok: out.frames.length > 0,
        seconds: sec,
        cost,
        detail: `${out.frames.length} 帧 ｜ 输入 ${out.usage.inputTokens ?? '?'} tok ｜ 输出 ${out.usage.outputTokens ?? '?'} tok`,
        note: out.formSuggestion.uncertain ? '形式判断标记为不确定' : undefined,
      });
      console.log(
        `\n【${model}】${out.frames.length} 帧（有效描述 ${desc}），耗时 ${sec.toFixed(1)}s，费用 ${cost === null ? '待核对' : yuan(cost)}`,
      );
      for (const f of out.frames) {
        console.log(`   ${String(f.timeMs).padStart(6)}ms  妆造:${f.makeup} ｜ 场景:${f.scene} ｜ 情绪:${f.emotion}`);
      }
      console.log(
        `   形式建议：混剪=${out.formSuggestion.mixedCut === true ? '是' : '否'}，AI 区间 ${(out.formSuggestion.aiIntervals ?? []).length} 段，区间可估=${out.formSuggestion.aiRatioEstimated !== false}`,
      );
    } catch (e) {
      const sec = (Date.now() - t0) / 1000;
      rows.push({
        modelId: model,
        ok: false,
        seconds: sec,
        cost: null,
        detail: '调用失败',
        note: (e as Error).message.replace(/\s+/g, ' ').slice(0, 110),
      });
      console.log(`\n【${model}】调用失败（${sec.toFixed(1)}s）：${(e as Error).message.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  return baseline;
}

async function benchOrganize(
  durationMs: number,
  utterances: AudioUtterance[],
  frames: VisionFrameResult[],
  rows: Row[],
) {
  bar('需求 3／脚本整理（引用原文组织九列 + 原文保真）');
  if (utterances.length === 0 || frames.length === 0) {
    console.log('缺少上游结果（语音或画面），跳过整理对比。');
    return;
  }
  const form = {
    category: FORM.REAL_PERSON,
    categoryLabel: FORM_LABEL[FORM.REAL_PERSON] ?? '真人',
    evidence: '横向对比用固定形式',
  };
  const input = { durationMs, utterances, visionFrames: frames, form, rules: ORGANIZE_RULES };

  for (const model of ORGANIZE_CANDIDATES) {
    ds.organizeModel = model;
    const adapter = new DashscopeOrganizeAdapter();
    const t0 = Date.now();
    try {
      const out = await adapter.organize(input);
      const sec = (Date.now() - t0) / 1000;
      const cost = costOf(model, out.usage, 0);
      const problems = checkTranscriptFidelity(utterances, out.segments);
      const hard = problems.filter((p) => p.severity === 'error');
      const segs: OrganizeSegmentInput[] = out.segments;
      const cover = (() => {
        const ids = new Set<string>();
        for (const s of segs) {
          for (const id of s.sourceUtteranceIds) ids.add(id);
          for (const id of s.sourceVoiceoverIds ?? []) ids.add(id);
        }
        return `${ids.size}/${utterances.length}`;
      })();
      rows.push({
        modelId: model,
        ok: segs.length > 0 && hard.length === 0,
        seconds: sec,
        cost,
        detail: `${segs.length} 段 ｜ 输入 ${out.usage.inputTokens ?? '?'} tok ｜ 输出 ${out.usage.outputTokens ?? '?'} tok ｜ 引用覆盖 ${cover}`,
        note: hard.length ? `${hard.length} 处保真问题：${hard[0].code}` : undefined,
      });
      console.log(
        `\n【${model}】${segs.length} 段，覆盖原文 ${cover}，保真问题 ${hard.length} 处，耗时 ${sec.toFixed(1)}s，费用 ${cost === null ? '待核对' : yuan(cost)}`,
      );
      for (const s of segs) {
        console.log(`   ${s.startMs}–${s.endMs}ms  [${s.tag ?? '（无标签）'}]  文案:${s.copyText.slice(0, 40)}`);
        console.log(`     妆造:${s.makeup.slice(0, 20)} ｜ 情绪:${s.emotion.slice(0, 16)}`);
      }
      for (const p of problems.slice(0, 5)) console.log(`   [${p.severity}] ${p.code} ${p.message.slice(0, 100)}`);
      for (const i of out.issues.slice(0, 3)) console.log(`   [${i.severity}] ${i.code} ${i.message.slice(0, 90)}`);
    } catch (e) {
      const sec = (Date.now() - t0) / 1000;
      rows.push({
        modelId: model,
        ok: false,
        seconds: sec,
        cost: null,
        detail: '调用失败',
        note: (e as Error).message.replace(/\s+/g, ' ').slice(0, 110),
      });
      console.log(`\n【${model}】调用失败（${sec.toFixed(1)}s）：${(e as Error).message.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
}

function printRows(title: string, rows: Row[]) {
  if (rows.length === 0) return;
  bar(`${title} · 汇总`);
  console.log(
    `${'模型'.padEnd(30)}${'结果'.padEnd(8)}${'耗时'.padEnd(10)}${'费用'.padEnd(12)}${'输出'.padEnd(46)}说明`,
  );
  for (const r of rows) {
    console.log(
      `${r.modelId.padEnd(30)}${(r.ok ? 'OK' : 'FAIL').padEnd(8)}${(`${r.seconds.toFixed(1)}s`).padEnd(10)}${
        (r.cost === null ? '待核对' : yuan(r.cost)).padEnd(12)
      }${r.detail.padEnd(46)}${r.note ?? ''}`,
    );
  }
}

(async () => {
  const CURRENT = {
    asr: cfg.dashscope.asrModel,
    vision: cfg.dashscope.visionModel,
    organize: cfg.dashscope.organizeModel,
  };
  if (!cfg.dashscope.apiKey) {
    console.error('未配置 DASHSCOPE_API_KEY，无法对比真实模型。请在 .env 中填写后重试。');
    process.exit(1);
  }
  if (!fs.existsSync(MEDIA)) {
    console.error(`素材不存在：${MEDIA}\n可先运行 npm run make:speech-media 生成内置中文语音测试素材。`);
    process.exit(1);
  }

  console.log(`供应商：百炼（区域 ${cfg.dashscope.region}，域名 ${cfg.dashscope.host}）`);
  console.log(`密钥：${cfg.dashscope.apiKey.slice(0, 7)}...${cfg.dashscope.apiKey.slice(-4)}`);
  console.log(`素材：${MEDIA}`);
  console.log('价格口径：华北2（北京），核对日 2026-09-14；仅供比较，实际以阿里云账单为准。');

  const probe = await probeMedia(MEDIA);
  const durationMs = probe.durationMs;
  console.log(`时长：${(durationMs / 1000).toFixed(1)}s ｜ 音轨：${probe.hasAudio ? '有' : '无'} ｜ ${probe.width}x${probe.height}`);

  const outDir = path.join(process.cwd(), 'data/tmp/bench');
  fs.mkdirSync(outDir, { recursive: true });

  const frameCount = Number(arg('frames')) > 0 ? Number(arg('frames')) : cfg.visionSampleCount;
  const frames = await extractSampledFrames(MEDIA, durationMs, outDir, frameCount);
  console.log(`取样帧：${frames.length} 张（${frameCount} 次尝试）→ ${outDir}`);

  // 注意：extractAudio 输出 mp3，扩展名必须与编码一致，否则 ffmpeg 按容器推断会报
  // 「Could not find tag for codec mp3 in stream #0」（m4a/ipod 容器装不下 mp3）。
  const audioPath = path.join(outDir, 'bench-audio.mp3');
  if (probe.hasAudio) await extractAudio(MEDIA, audioPath);

  const asrRows: Row[] = [];
  const visRows: Row[] = [];
  const orgRows: Row[] = [];

  const wantAsr = !ONLY || ONLY === 'asr';
  const wantVision = !ONLY || ONLY === 'vision';
  const wantOrganize = !ONLY || ONLY === 'organize';

  let utterances: AudioUtterance[] = [];
  let visionFrames: VisionFrameResult[] = [];

  if (wantAsr && probe.hasAudio) utterances = await benchAsr(audioPath, durationMs, asrRows);
  else if (wantAsr) console.log('\n素材无音轨，跳过音频识别对比。');

  if (wantVision) visionFrames = await benchVision(MEDIA, durationMs, frames, visRows);
  if (wantOrganize) await benchOrganize(durationMs, utterances, visionFrames, orgRows);

  printRows('音频识别', asrRows);
  printRows('画面理解', visRows);
  printRows('脚本整理', orgRows);

  if (asrRows.length && visRows.length && orgRows.length) {
    bar('当前配置 vs 合计');
    const pick = (rows: Row[], id: string) => rows.find((r) => r.modelId === id);
    const cur = [pick(asrRows, CURRENT.asr), pick(visRows, CURRENT.vision), pick(orgRows, CURRENT.organize)];
    const sum = cur.reduce((a, r) => a + (r?.cost ?? 0), 0);
    const cheapest = ['paraformer-realtime-v2', 'qwen3-vl-flash', 'qwen3.8-flash'];
    const alt = [
      pick(asrRows, cheapest[0]),
      pick(visRows, cheapest[1]),
      pick(orgRows, cheapest[2]),
    ];
    const altSum = alt.reduce((a, r) => a + (r?.cost ?? 0), 0);
    console.log(`当前配置（${cur.map((r) => r?.modelId ?? '?').join(' + ')}）合计约 ${yuan(sum)}／条`);
    console.log(`低成本组合（${alt.map((r) => r?.modelId ?? '?').join(' + ')}）合计约 ${yuan(altSum)}／条`);
    console.log('（画面理解按当前取样帧数计；帧数越多，视觉费用线性上升）');
  }
  console.log();
})().catch((e) => {
  console.error('对比失败：', e);
  process.exit(1);
});
