import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { cfg } from './config';

const execFileAsync = promisify(execFile);

/** ffmpeg / ffprobe 二进制由随项目安装的静态包提供，不要求主机预装 FFmpeg */
export function ffmpegPath(): string {
  const p = (ffmpegStatic as unknown as string) || 'ffmpeg';
  return p;
}

export function ffprobePath(): string {
  const p = (ffprobeStatic as unknown as { path?: string })?.path || 'ffprobe';
  return p;
}

export type MediaProbe = {
  durationMs: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  formatName?: string;
};

/** 媒体可读性校验：时长、分辨率、是否含音轨、编解码格式 */
export async function probeMedia(file: string): Promise<MediaProbe> {
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ];
  const { stdout } = await execFileAsync(ffprobePath(), args, { maxBuffer: 32 * 1024 * 1024 });
  const info = JSON.parse(stdout || '{}') as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<Record<string, unknown>>;
  };
  const streams = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const durationSec = Number(info.format?.duration ?? (v?.duration as string) ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('媒体时长无法读取，文件可能损坏或格式不受支持');
  }
  return {
    durationMs: Math.round(durationSec * 1000),
    width: v ? Number(v.width) : undefined,
    height: v ? Number(v.height) : undefined,
    hasAudio: Boolean(a),
    videoCodec: v ? String(v.codec_name) : undefined,
    audioCodec: a ? String(a.codec_name) : undefined,
    formatName: info.format?.format_name,
  };
}

/** 取某一时刻的单帧（PNG）。timeMs 为毫秒，保留原始宽高比，不做裁切。 */
export async function extractFrame(file: string, timeMs: number, outPath: string) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const args = [
    '-y',
    '-ss',
    (Math.max(0, timeMs) / 1000).toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-an',
    '-f',
    'image2',
    '-pix_fmt',
    'rgb24',
    outPath,
  ];
  await execFileAsync(ffmpegPath(), args, { maxBuffer: 16 * 1024 * 1024 });
  if (!fs.existsSync(outPath)) throw new Error(`取帧失败：${timeMs}ms`);
  return outPath;
}

/** 画面转场检测：用 ffmpeg 场景分数筛出明显变化点，覆盖整条时间轴 */
export async function detectSceneChanges(file: string, threshold = cfg.sceneChangeThreshold): Promise<number[]> {
  const args = [
    '-v',
    'info',
    '-i',
    file,
    '-filter:v',
    `select='gt(scene,${threshold})',showinfo`,
    '-fps_mode',
    'vfr',
    '-f',
    'null',
    '-',
  ];
  try {
    const { stderr } = await execFileAsync(ffmpegPath(), args, { maxBuffer: 64 * 1024 * 1024 });
    const times: number[] = [];
    const re = /pts_time:([0-9.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr)) !== null) {
      times.push(Math.round(Number(m[1]) * 1000));
    }
    return times.filter((t) => t > 0);
  } catch {
    // 场景检测失败不致命：退回均匀取样
    return [];
  }
}

/** 均匀取样帧：用于形式判断，必须覆盖时间轴（不依赖少量导出截图） */
export async function extractSampledFrames(
  file: string,
  durationMs: number,
  outDir: string,
  count = cfg.visionSampleCount,
): Promise<Array<{ timeMs: number; path: string }>> {
  fs.mkdirSync(outDir, { recursive: true });
  const n = Math.max(2, Math.min(24, count));
  const step = durationMs / (n + 1);
  const out: Array<{ timeMs: number; path: string }> = [];
  for (let i = 1; i <= n; i += 1) {
    const t = Math.round(step * i);
    const p = path.join(outDir, `sample_${String(i).padStart(2, '0')}_${t}.png`);
    try {
      await extractFrame(file, t, p);
      out.push({ timeMs: t, path: p });
    } catch {
      // 单帧失败不影响整体取样
    }
  }
  return out;
}

/** 提取音轨供语音识别使用（16kHz 单声道，统一为供应商可接受的上传格式） */
export async function extractAudio(file: string, outPath: string) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // 编码固定为 mp3，容器由扩展名推断：扩展名不是 .mp3 时 ffmpeg 会报
  // 「Could not find tag for codec mp3 in stream #0」，这里提前给出可读的错误。
  if (!/\.mp3$/i.test(outPath)) {
    throw new Error(`音轨输出必须是 .mp3 扩展名（当前：${path.basename(outPath)}），否则 ffmpeg 无法写入 mp3 编码`);
  }
  const args = ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', outPath];
  await execFileAsync(ffmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 });
  if (!fs.existsSync(outPath)) throw new Error('音轨提取失败');
  return outPath;
}

/** 检测黑帧，用于避开黑帧和转场中间帧挑选「开头清晰有效画面」 */
export async function detectBlackFrames(file: string): Promise<Array<{ startMs: number; endMs: number }>> {
  const args = ['-v', 'info', '-i', file, '-vf', 'blackdetect=d=0.1:pic_th=0.98', '-an', '-f', 'null', '-'];
  try {
    const { stderr } = await execFileAsync(ffmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 });
    const out: Array<{ startMs: number; endMs: number }> = [];
    const re = /black_start:([0-9.]+)\s+black_end:([0-9.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr)) !== null) {
      out.push({ startMs: Math.round(Number(m[1]) * 1000), endMs: Math.round(Number(m[2]) * 1000) });
    }
    return out;
  } catch {
    return [];
  }
}
