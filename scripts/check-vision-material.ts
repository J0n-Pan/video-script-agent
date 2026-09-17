/**
 * 单段素材的画面理解 + 形式判定复核。
 *
 * 为什么需要它：形式判定是否准确，取决于「模型返回的键名」与「适配器解析的键名」是否对齐。
 * 这类错配过去是**静默**的 —— 流程照常跑完，只是结论退化成「待复核」，从日志里看不出来。
 * 本脚本直接对指定素材跑生产适配器，并把原始返回落盘，用于快速核对契约。
 *
 * 用法：
 *   npx tsx scripts/check-vision-material.ts                        # 用 data/media 里体积最大的素材
 *   npx tsx scripts/check-vision-material.ts --id=<mediaDirId>      # 指定 data/media 下的目录名
 *   npx tsx scripts/check-vision-material.ts --file=D:/a.mp4        # 指定任意本地文件
 *
 * 会写盘：data/tmp/dashscope-raw/vision-*.json（原始返回）、data/tmp/vision-check/<id>/sample/*.png（取样帧）
 */
import fs from 'node:fs';
import path from 'node:path';

import { cfg } from '../src/lib/config';
import { probeMedia, extractSampledFrames } from '../src/lib/ffmpeg';
import { classify } from '../src/lib/classification';
import { DashscopeVisionAdapter } from '../src/lib/ai/dashscope';
import { estimateCost } from '../src/lib/ai/usage';

const argv = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** 未指定素材时，取 data/media 下 source.mp4 体积最大的一条（通常是真实抓取回来的那条） */
function pickLargestMedia(): string {
  const root = cfg.mediaDir;
  let best = '';
  let bestSize = -1;
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, 'source.mp4');
    if (!fs.existsSync(f)) continue;
    const s = fs.statSync(f).size;
    if (s > bestSize) {
      bestSize = s;
      best = f;
    }
  }
  if (!best) throw new Error(`未在 ${root} 找到任何 source.mp4`);
  return best;
}

async function main() {
  // 保留原始返回，便于核对键名
  process.env.DASHSCOPE_DUMP_RAW = '1';

  const byFile = argValue('--file');
  const byId = argValue('--id');
  const file = byFile
    ? path.resolve(byFile)
    : byId
      ? path.join(cfg.mediaDir, byId, 'source.mp4')
      : pickLargestMedia();

  if (!fs.existsSync(file)) throw new Error(`素材不存在：${file}`);

  console.log('\n=== 画面理解 / 形式判定复核 ===\n');
  console.log(`素材        : ${file}（${(fs.statSync(file).size / 1048576).toFixed(2)}MB）`);
  console.log(`VISION_MODEL: ${cfg.dashscope.visionModel}`);
  console.log(`取样帧数    : ${cfg.visionSampleCount}`);
  console.log('');

  const probe = await probeMedia(file);
  console.log(
    `媒体信息    : ${(probe.durationMs / 1000).toFixed(1)}s，${probe.width}x${probe.height}，` +
      `音轨 ${probe.hasAudio ? '有' : '无'}，${probe.videoCodec}/${probe.audioCodec ?? '-'}`,
  );

  const outDir = path.join(cfg.tmpDir, 'vision-check', path.basename(path.dirname(file)));
  const frames = await extractSampledFrames(file, probe.durationMs, outDir, cfg.visionSampleCount);
  console.log(`取样结果    : ${frames.length} 帧 @ ${frames.map((f) => f.timeMs).join(', ')}ms\n`);

  const t0 = Date.now();
  const out = await new DashscopeVisionAdapter().analyze({
    durationMs: probe.durationMs,
    frames: frames.map((f) => ({ path: f.path, timeMs: f.timeMs })),
  });
  const { cost } = estimateCost('VISION', out.usage);

  console.log(`耗时        : ${((Date.now() - t0) / 1000).toFixed(1)}s，` +
    `tokens ${out.usage.inputTokens ?? '?'}/${out.usage.outputTokens ?? '?'}，约 ¥${(cost ?? 0).toFixed(6)}`);
  console.log(`原始返回    : data/tmp/dashscope-raw/ 下最新 vision-*.json\n`);

  console.log(`--- 帧（${out.frames.length}）---`);
  for (const f of out.frames) {
    console.log(
      `  ${String(f.timeMs).padStart(7)}ms  AI画面=${f.isAiGenerated === undefined ? '未表态' : String(f.isAiGenerated)}` +
        `${f.uncertain ? ' [不确定]' : ''}  妆造:${f.makeup}  场景:${f.scene}`,
    );
  }

  const fsug = out.formSuggestion;
  console.log('\n--- 形式建议（解析后）---');
  console.log(`  mixedCut        : ${fsug.mixedCut}`);
  console.log(`  混剪依据        : ${fsug.mixedCutEvidence || '(空)'}`);
  console.log(`  aiIntervals     : ${JSON.stringify(fsug.aiIntervals)}`);
  console.log(`  aiRatioEstimated: ${fsug.aiRatioEstimated}`);
  console.log(`  uncertain       : ${fsug.uncertain}`);
  console.log(`  依据            : ${fsug.evidence || '(空)'}`);

  const cls = classify({
    durationMs: probe.durationMs,
    vision: fsug,
    ratioUnreliable: frames.length < 3,
  });
  console.log('\n--- 最终形式判定 ---');
  console.log(`  ${cls.categoryLabel}  (category=${cls.category})`);
  console.log(`  AI 并集 ${(cls.aiUnionMs / 1000).toFixed(1)}s / 占比 ${(cls.aiRatio * 100).toFixed(1)}%，比例已估计=${cls.ratioEstimated}`);
  console.log(`  依据: ${cls.evidence}`);

  console.log('\n--- issues ---');
  for (const i of out.issues) console.log(`  [${i.severity}] ${i.code}: ${i.message}`);
  if (out.issues.length === 0) console.log('  (无)');
  console.log('');
}

main().catch((e) => {
  console.error('复核异常：', e);
  process.exit(1);
});
