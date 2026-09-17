import path from 'node:path';
import { prisma } from '../src/lib/db';
import { cfg } from '../src/lib/config';
import { getAdapters } from '../src/lib/ai';
import { ORGANIZE_RULES } from '../src/lib/organize-rules';
import { extractAudio, probeMedia } from '../src/lib/ffmpeg';
import { audioDirFor } from '../src/lib/storage';
import { checkTranscriptFidelity, partitionSegments, validateSegments } from '../src/lib/validate';
import type { AudioUtterance } from '../src/lib/ai/types';

/**
 * 分段链路诊断（只读，不写业务库、不改版本）。
 *
 * 一条命令跑完「语音识别 → 脚本整理 → 原文回填 → 保真校验」，把三段中间态全部打印，
 * 用于定位「段落之间内容重复 / 首段吞掉一大段文案 / 段落时间与内容对不上」这类问题。
 * 只消耗 ASR 与整理模型的调用费（约 ¥0.02 / 条，70 秒素材）。
 *
 * 用法：
 *   npm run diag:segment -- <媒体文件绝对路径>
 *   npm run diag:segment -- --rev=<版本id>     # 从库里反查该版本对应素材
 *   npm run diag:segment -- --latest           # 取最近一次解析的素材
 */

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function resolveMediaPath(): Promise<{ media: string; durationMs: number; label: string }> {
  const direct = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (direct) {
    const probe = await probeMedia(direct);
    return { media: path.resolve(direct), durationMs: probe.durationMs, label: path.basename(direct) };
  }

  const revId = arg('rev');
  const rev = revId
    ? await prisma.scriptRevision.findUnique({ where: { id: revId } })
    : (
        await prisma.scriptRevision.findMany({
          orderBy: { savedAt: 'desc' },
          take: 1,
          select: { id: true, videoId: true, versionNo: true },
        })
      )[0];
  if (!rev) throw new Error(revId ? `未找到版本 ${revId}` : '库中没有可用的解析版本');

  const video = await prisma.video.findUnique({
    where: { id: rev.videoId },
    include: { media: true },
  });
  if (!video?.media?.cachePath) throw new Error(`版本 ${rev.id} 对应的素材缓存不存在`);
  const probe = await probeMedia(video.media.cachePath);
  return {
    media: video.media.cachePath,
    durationMs: probe.durationMs,
    label: `rev ${rev.id}（v${rev.versionNo} / ${video.sourceType}）`,
  };
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

(async () => {
  const { media, durationMs, label } = await resolveMediaPath();
  console.log(`\n素材：${label}\n路径：${media}\n时长：${durationMs}ms（${(durationMs / 1000).toFixed(1)}s）\nAI 模式：${cfg.aiMode}\n`);

  const adapters = getAdapters();
  const audioPath = path.join(audioDirFor('diag'), 'audio.mp3');
  await extractAudio(media, audioPath);

  console.log('========== 1. 语音识别（原始片段边界） ==========');
  const asrOut = await adapters.audio.recognize({ audioPath, durationMs, language: 'zh', hasAudio: true });
  const utterances: AudioUtterance[] = asrOut.utterances;
  for (const u of utterances) {
    console.log(
      `  ${u.id.padEnd(6)} ${clock(u.startMs)} → ${clock(u.endMs)}  ${String(u.endMs - u.startMs).padStart(6)}ms  ${String(u.text.length).padStart(4)}字  ${u.text.slice(0, 48)}${u.text.length > 48 ? '…' : ''}`,
    );
  }
  console.log(`  共 ${utterances.length} 个片段，模型 ${adapters.audio.modelId}`);

  console.log('\n========== 2. 脚本整理（模型原始分段） ==========');
  process.env.DASHSCOPE_DUMP_RAW = '1';
  const organized = await adapters.organize.organize({
    durationMs,
    utterances,
    visionFrames: [],
    form: { category: 'REAL_PERSON', categoryLabel: '真人拍摄', evidence: '诊断脚本未跑画面理解' },
    rules: ORGANIZE_RULES,
  });
  for (const [i, s] of organized.segments.entries()) {
    console.log(
      `  #${i + 1}  ${clock(s.startMs)} → ${clock(s.endMs)}  [${s.tag}]  引用 ${s.sourceUtteranceIds.length} 个片段：${s.sourceUtteranceIds.join(',') || '(空)'}`,
    );
    console.log(`       copyText(${s.copyText.length}字)：${s.copyText.slice(0, 60)}${s.copyText.length > 60 ? '…' : ''}`);
  }

  console.log('\n========== 3. 划分兜底（程序按原始片段重建不重不漏的分段） ==========');
  const partition = partitionSegments(utterances, organized.segments);
  const verbatim = partition;
  const byId = new Map(utterances.map((u) => [u.id, u]));
  for (const [i, s] of verbatim.segments.entries()) {
    const parts = s.sourceUtteranceIds.map((id) => byId.get(id)).filter((u): u is AudioUtterance => Boolean(u));
    const span = parts.length
      ? `${clock(Math.min(...parts.map((u) => u.startMs)))} → ${clock(Math.max(...parts.map((u) => u.endMs)))}`
      : '(无引用)';
    console.log(
      `  #${i + 1} 推导时间 ${clock(s.startMs)}→${clock(s.endMs)}  引用片段 ${parts.length} 个 / 区间 ${span}  [${s.tag}]  ${s.copyText.length}字`,
    );
  }

  const problems = [...verbatim.problems, ...checkTranscriptFidelity(utterances, verbatim.segments), ...validateSegments(verbatim.segments, durationMs)];
  if (!problems.length) console.log('  无问题');
  for (const p of problems) console.log(`  - [${p.severity}] ${p.code} | 段${(p.segmentIndex ?? -1) + 1} | ${p.message}`);

  // 重合量化：每段有多少比例的 6 字片段在「它之前的所有段落」里已经出现过。
  // 这正是编导反映的「第一段一大段、后面又和前面大量重合」的度量方式。
  console.log('\n========== 4. 段落重复度检查（该段 6 字片段已在前文出现的比例） ==========');
  const norm = (s: string) => s.replace(/[\s，。！？、；：""''（）…—]/g, '');
  const shingles = (s: string, n = 6): Set<string> => {
    const t = norm(s);
    const out = new Set<string>();
    for (let i = 0; i + n <= t.length; i += 1) out.add(t.slice(i, i + n));
    return out;
  };
  const seen = new Set<string>();
  let worst = 0;
  for (const [i, s] of verbatim.segments.entries()) {
    const mine = shingles(s.copyText);
    let dup = 0;
    for (const g of mine) if (seen.has(g)) dup += 1;
    const pct = mine.size ? Math.round((dup / mine.size) * 100) : 0;
    if (i > 0) worst = Math.max(worst, pct);
    console.log(`  段${i + 1}：${String(pct).padStart(3)}% 重复${pct >= 50 ? '   ← 明显与前面重复' : ''}`);
    for (const g of mine) seen.add(g);
  }
  console.log(`  结论：除首段外最高重复度 ${worst}%${worst >= 50 ? '（不满足「每段内容不应重复」）' : '（可接受）'}`);

  console.log('');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('诊断失败：', (e as Error).message);
  await prisma.$disconnect();
  process.exit(1);
});
