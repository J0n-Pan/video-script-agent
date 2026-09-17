import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { cfg, ensureDirs } from './config';

export function mediaDirFor(videoId: string) {
  ensureDirs();
  const dir = path.join(cfg.mediaDir, videoId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 画面理解取样帧目录（2026-09-17 由 screenshotDirFor 改名）：
 * 截图能力已全量下线，这里只保存每次解析临时取样的 VLM 帧（frames/sample），不再产出截图。
 */
export function framesDirFor(videoId: string) {
  const dir = path.join(mediaDirFor(videoId), 'frames');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function audioDirFor(videoId: string) {
  const dir = path.join(mediaDirFor(videoId), 'audio');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cachePathFor(videoId: string, ext: string) {
  return path.join(mediaDirFor(videoId), `source${ext}`);
}

export function safeExt(name: string) {
  const e = path.extname(name || '').toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(e) ? e : '';
}

/** 原文件名（含扩展名）单独保存，不参与拼接，避免路径穿越 */
export function baseFileName(name: string) {
  return path.basename(name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 255);
}

export async function sha256File(p: string) {
  return new Promise<string>((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

export function fileExists(p?: string | null) {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function fileSize(p: string) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** 删除视频关联主机媒体（PRD 11.1：删除时清理版本与媒体） */
export function removeVideoMedia(videoId: string) {
  const dir = path.join(cfg.mediaDir, videoId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略：媒体可能已被手工清理
  }
}

export function removeFile(p?: string | null) {
  if (!p) return;
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // 忽略
  }
}
