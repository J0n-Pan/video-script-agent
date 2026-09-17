/**
 * 阿里云百炼连通性自检。
 *
 * 直接调用生产适配器（src/lib/ai/dashscope），不是另写一份实现，
 * 因此「自检通过」等价于「解析进程里的真实调用链路可用」。
 *
 * 用法：
 *   npm run check:ai                      # 三模型最小调用
 *   npm run check:ai -- --audio a.mp4     # 用你自己的含语音音频跑真实 ASR
 *   npm run check:ai -- --skip-asr        # 只验文本与视觉模型
 *
 * 说明：本脚本不受 AI_MODE 影响，可以在切到 dashscope 之前先验证密钥。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { cfg } from '../src/lib/config';
import { ORGANIZE_RULES } from '../src/lib/organize-rules';
import { FORM, FORM_LABEL } from '../src/lib/constants';
import { ffmpegPath } from '../src/lib/ffmpeg';
import {
  DashscopeAudioAdapter,
  DashscopeOrganizeAdapter,
  DashscopeVisionAdapter,
} from '../src/lib/ai/dashscope';
import { DashscopeRealtimeAudioAdapter } from '../src/lib/ai/dashscope/realtime-asr';
// 与生产共用同一套计价实现，避免自检显示的费用和落库口径不一致
import { estimateCost } from '../src/lib/ai/usage';

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const SKIP_ASR = argv.includes('--skip-asr');
const AUDIO_OVERRIDE = argValue('--audio');

let pass = 0;
let fail = 0;
let warn = 0;

function line(ok: 'PASS' | 'FAIL' | 'WARN' | 'INFO', name: string, detail = '') {
  const tag = ok === 'PASS' ? '  PASS' : ok === 'FAIL' ? '  FAIL' : ok === 'WARN' ? '  WARN' : '  ----';
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function mask(k: string): string {
  if (!k) return '(空)';
  if (k.length <= 10) return `${k.slice(0, 3)}****`;
  return `${k.slice(0, 6)}****${k.slice(-4)}（长度 ${k.length}）`;
}

function yuan(n: number): string {
  return `约 ¥${n.toFixed(6)}`;
}

async function generateToneWav(dest: string, seconds = 3): Promise<string> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await execFileAsync(ffmpegPath(), [
    '-y',
    '-v', 'error',
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${seconds}`,
    '-af', 'volume=0.3',
    '-ar', '16000',
    '-ac', '1',
    dest,
  ]);
  return dest;
}

async function generateSamplePng(dest: string): Promise<string> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await execFileAsync(ffmpegPath(), [
    '-y',
    '-v', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=#2b6cb0:s=320x240:d=1',
    '-frames:v', '1',
    dest,
  ]);
  return dest;
}

async function main() {
  console.log('\n=== 阿里云百炼连通性自检 ===\n');

  console.log('配置：');
  console.log(`  AI_MODE            = ${cfg.aiMode}${cfg.aiMode === 'mock' ? '  （注意：真实调用前需改为 dashscope 并重启解析进程）' : ''}`);
  console.log(`  DASHSCOPE_REGION   = ${cfg.dashscope.region}`);
  console.log(`  HOST               = ${cfg.dashscope.host}`);
  console.log(`  WS_HOST            = ${cfg.dashscope.wsHost}`);
  console.log(`  DASHSCOPE_API_KEY  = ${mask(cfg.dashscope.apiKey)}`);
  console.log(`  ASR_TRANSPORT      = ${cfg.dashscope.asrTransport}`);
  console.log(`  ASR_MODEL          = ${cfg.dashscope.asrModel}`);
  console.log(`  VISION_MODEL       = ${cfg.dashscope.visionModel}`);
  console.log(`  ORGANIZE_MODEL     = ${cfg.dashscope.organizeModel}`);
  console.log('');

  if (!cfg.dashscope.apiKey) {
    line('FAIL', '密钥未配置', '请在 .env 填写 DASHSCOPE_API_KEY（阿里云百炼控制台 → API-KEY 管理）');
    console.log('\n未发起任何请求。');
    process.exit(1);
  }

  const tmpDir = cfg.tmpDir;
  let spent = 0;

  // ---- 1. 文本整理模型 ----
  const organizeStart = Date.now();
  try {
    const out = await new DashscopeOrganizeAdapter().organize({
      durationMs: 6000,
      utterances: [
        { id: 'u1', text: '自检：这是一句用于验证模型连通性的测试语音。', startMs: 0, endMs: 3000 },
        { id: 'u2', text: '自检：这是第二句，用于确认多片段组织能力。', startMs: 3000, endMs: 6000 },
      ],
      visionFrames: [
        { timeMs: 1500, makeup: '深色上衣', scene: '室内白墙前', emotion: '平静', isAiGenerated: false },
      ],
      // 与 pipeline 传入的形态保持一致
      form: {
        category: FORM.REAL_PERSON,
        categoryLabel: FORM_LABEL[FORM.REAL_PERSON],
        evidence: '连通性自检（非真实识别结果）',
      },
      rules: ORGANIZE_RULES,
    });
    const { cost } = estimateCost('ORGANIZE', out.usage);
    const c = cost ?? 0;
    spent += c;
    const ok = out.segments.length > 0;
    ok ? pass++ : fail++;
    line(
      ok ? 'PASS' : 'FAIL',
      `${cfg.dashscope.organizeModel} 脚本整理`,
      `${((Date.now() - organizeStart) / 1000).toFixed(1)}s，输出 ${out.segments.length} 段，` +
        `输入 ${out.usage.inputTokens ?? '?'} / 输出 ${out.usage.outputTokens ?? '?'} tokens，${yuan(c)}`,
    );
    if (out.usage.usageMissing) {
      warn++;
      line('WARN', '用量未返回', '费用将记为「待核对」，不能当免费');
    }
  } catch (e) {
    fail++;
    line('FAIL', `${cfg.dashscope.organizeModel} 脚本整理`, (e as Error).message.replace(/\n/g, '\n        '));
  }

  // ---- 2. 画面理解模型 ----
  const visionStart = Date.now();
  try {
    const png = await generateSamplePng(path.join(tmpDir, 'check-vision.png'));
    const out = await new DashscopeVisionAdapter().analyze({
      durationMs: 6000,
      frames: [
        { path: png, timeMs: 1000 },
        { path: png, timeMs: 4000 },
      ],
    });
    const { cost } = estimateCost('VISION', out.usage);
    const c = cost ?? 0;
    spent += c;
    const ok = out.frames.length > 0;
    ok ? pass++ : fail++;
    line(
      ok ? 'PASS' : 'FAIL',
      `${cfg.dashscope.visionModel} 画面理解`,
      `${((Date.now() - visionStart) / 1000).toFixed(1)}s，返回 ${out.frames.length} 帧描述，` +
        `输入 ${out.usage.inputTokens ?? '?'} / 输出 ${out.usage.outputTokens ?? '?'} tokens，${yuan(c)}`,
    );
    if (!ok) {
      line('WARN', '画面模型返回空 frames', '可能是返回不是合法 JSON，需看原始响应');
    }
  } catch (e) {
    fail++;
    line('FAIL', `${cfg.dashscope.visionModel} 画面理解`, (e as Error).message.replace(/\n/g, '\n        '));
  }

  // ---- 3. 录音文件识别 ----
  if (SKIP_ASR) {
    line('INFO', `${cfg.dashscope.asrModel} 录音文件识别`, '已按 --skip-asr 跳过');
  } else {
    const asrStart = Date.now();
    const audioPath = AUDIO_OVERRIDE ? path.resolve(AUDIO_OVERRIDE) : path.join(tmpDir, 'check-asr.wav');
    try {
      let durationMs = 3000;
      if (AUDIO_OVERRIDE) {
        if (!fs.existsSync(audioPath)) throw new Error(`音频文件不存在：${audioPath}`);
        durationMs = 30_000; // 仅用于计费估算，真实时长由服务端返回
      } else {
        await generateToneWav(audioPath, 3);
      }

      // 与解析进程同一套选择逻辑，确保自检覆盖真正会跑的那条通道
      const adapter =
        cfg.dashscope.asrTransport === 'filetrans'
          ? new DashscopeAudioAdapter()
          : new DashscopeRealtimeAudioAdapter();

      const out = await adapter.recognize({
        audioPath,
        durationMs,
        language: 'zh',
        hasAudio: true,
      });
      const { cost } = estimateCost('ASR', out.usage);
      const c = cost ?? 0;
      spent += c;
      const realAudio = Boolean(AUDIO_OVERRIDE);
      // 正弦音不含语音，返回 0 段属预期；只有「通道未跑通」才算失败
      const ok = !out.issues.some((i) => i.severity === 'error');
      ok ? pass++ : fail++;
      line(
        ok ? 'PASS' : 'FAIL',
        `${cfg.dashscope.asrModel}（${cfg.dashscope.asrTransport}）音频识别`,
        `${((Date.now() - asrStart) / 1000).toFixed(1)}s，识别出 ${out.utterances.length} 段` +
          `${realAudio ? '' : '（测试音无语音，0 段属正常）'}，计费 ${out.usage.audioSeconds ?? '?'}s，${yuan(c)}`,
      );
      if (realAudio && out.utterances.length > 0) {
        console.log('       时间戳样例：');
        for (const u of out.utterances.slice(0, 5)) {
          console.log(`         [${u.startMs}ms - ${u.endMs}ms] ${u.text}`);
        }
      }
      if (realAudio && out.utterances.length === 0) {
        warn++;
        line('WARN', '真实音频未识别出任何语音', '请确认文件确实含人声且格式受支持');
      }
      if (!realAudio) {
        line('INFO', '建议', '用 --audio <你的视频或音频> 再跑一次，确认句级时间戳与识别效果');
      }
    } catch (e) {
      fail++;
      line('FAIL', `${cfg.dashscope.asrModel} 音频识别`, (e as Error).message.replace(/\n/g, '\n        '));
    }
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 / ${warn} 提醒，本轮约 ${yuan(spent)} ===`);
  if (fail === 0) {
    console.log('三模型链路可用。把 .env 的 AI_MODE 改为 dashscope，然后重启解析进程即可。');
  } else {
    console.log('存在失败项。常见原因：密钥与 DASHSCOPE_REGION 不匹配、业务空间未开通对应模型、账户欠费。');
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('自检异常：', e);
  process.exit(1);
});
