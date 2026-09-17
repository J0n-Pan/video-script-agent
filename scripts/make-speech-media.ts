/**
 * 生成带**真实中文语音**的测试视频（自备测试素材，不需要公网地址）。
 *
 * 与 make-test-media.ts 的区别：那个用正弦音，只能验流程；这个用百炼 TTS 生成真实人声，
 * 因此可以用来验证「句级时间戳 → 段落切分 → 九列填充」这条真实链路。
 *
 * 用法：
 *   npm run make:speech-media
 *
 * 产物：data/test-media/speech-*.mp4
 * 注意：会调用 TTS 接口，产生极少量费用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { cfg } from '../src/lib/config';
import { ffmpegPath, ffprobePath } from '../src/lib/ffmpeg';

const execFileAsync = promisify(execFile);

/** 四句内容，句间留停顿，便于验证句切分 */
const LINES = [
  '大家好，今天给大家分享三个提升工作效率的小技巧。',
  '第一，每天早上先列出今天最重要的三件事。',
  '第二，把手机调成静音，专注工作二十五分钟。',
  '第三，晚上花五分钟复盘今天的完成情况。',
];

/** 每段对应一种可辨识的画面，便于视觉模型描述场景差异 */
const SCENES = [
  'smptebars=size=1280x720:rate=25',
  'testsrc=size=1280x720:rate=25',
  'rgbtestsrc=size=1280x720:rate=25',
  'gradients=size=1280x720:rate=25:speed=0.02',
];

const SILENCE_SEC = 0.6;

async function tts(text: string, outFile: string): Promise<void> {
  for (const model of ['qwen3-tts-flash', 'qwen-tts']) {
    const res = await fetch(`${cfg.dashscope.host}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.dashscope.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: { text, voice: 'Cherry' } }),
    });
    const j: any = await res.json();
    if (!res.ok) {
      console.log(`    ${model} 不可用（HTTP ${res.status}），尝试下一个`);
      continue;
    }
    const url = j?.output?.audio?.url;
    const b64 = j?.output?.audio?.data;
    if (url) {
      fs.writeFileSync(outFile, Buffer.from(await (await fetch(url)).arrayBuffer()));
      return;
    }
    if (b64) {
      fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
      return;
    }
    console.log(`    ${model} 未返回音频字段`);
  }
  throw new Error('TTS 不可用：qwen3-tts-flash 与 qwen-tts 均未返回音频');
}

async function durationMs(file: string): Promise<number> {
  const { stdout } = await execFileAsync(ffprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]);
  return Math.round(Number(String(stdout).trim()) * 1000);
}

async function main() {
  if (!cfg.dashscope.apiKey) {
    console.error('未配置 DASHSCOPE_API_KEY，无法生成语音。');
    process.exit(1);
  }

  const tmp = path.join(cfg.tmpDir, 'speech-build');
  const outDir = path.join(process.cwd(), 'data', 'test-media');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  console.log('1/4 生成语音…');
  const wavs: string[] = [];
  const gains: number[] = [];
  for (let i = 0; i < LINES.length; i++) {
    const w = path.join(tmp, `line-${i}.wav`);
    await tts(LINES[i], w);
    const d = await durationMs(w);
    wavs.push(w);
    gains.push(d);
    console.log(`    第 ${i + 1} 句 ${d}ms：${LINES[i]}`);
  }

  console.log('2/4 拼接音轨（句间插入 ' + SILENCE_SEC * 1000 + 'ms 停顿）…');
  const sil = path.join(tmp, 'sil.wav');
  await execFileAsync(ffmpegPath(), [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(SILENCE_SEC), sil,
  ]);
  const audioList: string[] = [];
  wavs.forEach((w, i) => {
    audioList.push(`file '${w.replace(/\\/g, '/')}'`);
    if (i < wavs.length - 1) audioList.push(`file '${sil.replace(/\\/g, '/')}'`);
  });
  const audioListFile = path.join(tmp, 'audio.txt');
  fs.writeFileSync(audioListFile, audioList.join('\n'));
  const audio = path.join(tmp, 'full.wav');
  await execFileAsync(ffmpegPath(), [
    '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', audioListFile, '-ac', '1', '-ar', '24000', audio,
  ]);
  const totalSec = (await durationMs(audio)) / 1000;
  console.log(`    音轨总长 ${totalSec.toFixed(2)}s`);

  console.log('3/4 生成四段画面并与语音对齐…');
  const videoParts: string[] = [];
  for (let i = 0; i < LINES.length; i++) {
    // 每段画面时长 = 该句语音时长 +（非末句的）停顿
    const dur = gains[i] / 1000 + (i < LINES.length - 1 ? SILENCE_SEC : 0);
    const v = path.join(tmp, `scene-${i}.mp4`);
    await execFileAsync(ffmpegPath(), [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', SCENES[i],
      '-t', dur.toFixed(3),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '25',
      v,
    ]);
    videoParts.push(v);
  }
  const videoListFile = path.join(tmp, 'video.txt');
  fs.writeFileSync(videoListFile, videoParts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const videoOnly = path.join(tmp, 'video.mp4');
  await execFileAsync(ffmpegPath(), [
    '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', videoListFile, '-c', 'copy', videoOnly,
  ]);

  console.log('4/4 合成最终文件…');
  const finals: string[] = [];

  const full = path.join(outDir, 'speech-full.mp4');
  await execFileAsync(ffmpegPath(), [
    '-y', '-v', 'error', '-i', videoOnly, '-i', audio,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', full,
  ]);
  finals.push(full);

  // 再产出一个纯语音音频，方便直接用于 check:ai --audio
  const audioOnly = path.join(outDir, 'speech-full.m4a');
  await execFileAsync(ffmpegPath(), [
    '-y', '-v', 'error', '-i', audio, '-c:a', 'aac', '-b:a', '96k', audioOnly,
  ]);
  finals.push(audioOnly);

  console.log('\n完成：');
  for (const f of finals) {
    const d = await durationMs(f);
    console.log(`  ${f}  ${(fs.statSync(f).size / 1024).toFixed(0)}KB  ${(d / 1000).toFixed(1)}s`);
  }
  console.log('\n可直接用于自检：');
  console.log(`  npm run check:ai -- --audio "${finals[1]}"`);
}

main().catch((e) => {
  console.error('生成失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
