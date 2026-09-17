/**
 * 生成可合法使用的自备测试素材（PRD 13.1：研发先使用自行准备的测试素材验证流程）。
 * 不是任何真实素材的替代品，仅用于打通上传 → 队列 → 解析 → 复核 → 导出。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const ffmpeg = (ffmpegStatic as unknown as string) || 'ffmpeg';

const outDir = path.resolve(process.cwd(), 'data', 'samples');
fs.mkdirSync(outDir, { recursive: true });

const jobs: Array<{ name: string; seconds: number; desc: string }> = [
  { name: 'sample_talk_60s.mp4', seconds: 60, desc: '1 分钟普通话口播形态素材（用于 A01/A03/A04 流程验证）' },
  { name: 'sample_talk_12s.mp4', seconds: 12, desc: '12 秒短片（用于快速回归与截图分支验证）' },
];

async function main() {
  for (const j of jobs) {
    const out = path.join(outDir, j.name);
    if (fs.existsSync(out)) {
      console.log(`已存在，跳过：${out}`);
      continue;
    }
    // 画面：带时钟与序号的变化画面（保证有时间轴与场景变化可供取帧）；
    // 音轨：440Hz + 880Hz 交替正弦（保证有音轨，Mock ASR 走完整分支）
    const args = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=1280x720:rate=25:duration=${j.seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=16000:duration=${j.seconds}`,
      '-shortest',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      out,
    ];
    console.log(`生成 ${j.name} …（${j.desc}）`);
    await execFileAsync(ffmpeg, args, { maxBuffer: 32 * 1024 * 1024 });
    console.log(`  完成：${out}`);
  }
  console.log(`\n测试素材目录：${outDir}`);
  console.log('在「新建任务」页选择这些文件即可跑通全链路（AI_MODE=mock 时不产生模型费用）。');
}

main().catch((e) => {
  console.error('生成测试素材失败：', e.message);
  process.exit(1);
});
