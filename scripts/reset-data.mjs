import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

const p = new PrismaClient();
const videos = await p.video.findMany({ select: { id: true, title: true } });
console.log('清理现有任务：', videos.length);
const exports_ = await p.exportRecord.findMany();
for (const e of exports_) {
  if (e.filePath && fs.existsSync(e.filePath)) fs.rmSync(e.filePath, { force: true });
}
await p.exportRecord.deleteMany();
for (const v of videos) {
  await p.video.delete({ where: { id: v.id } });
}
const mediaDir = path.resolve(process.cwd(), 'data/media');
if (fs.existsSync(mediaDir)) fs.rmSync(mediaDir, { recursive: true, force: true });
const expDir = path.resolve(process.cwd(), 'data/exports');
if (fs.existsSync(expDir)) fs.rmSync(expDir, { recursive: true, force: true });
console.log('已清理任务、导出文件与媒体缓存');
await p.$disconnect();
