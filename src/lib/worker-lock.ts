import fs from 'node:fs';
import path from 'node:path';

/**
 * 常驻进程存活判定（按锁文件）。
 *
 * 用途：拿浏览器 / 长等待的活儿都在常驻进程里做，界面上必须先说清「进程在不在」——
 * 否则用户点了按钮却一直停在等待，会以为是页面坏了。
 *
 * 两个锁文件、两个进程：
 *   - `data/worker.lock`    视频分析 + 妙思会话（Chromium 单一所有者）
 *   - `data/avatar-worker.lock` 数字人出片（长等待，独立进程，见 src/worker/avatar.ts）
 */

function lockPath(name: string): string {
  return path.join(process.cwd(), 'data', name);
}

export function workerLockPath(): string {
  return lockPath('worker.lock');
}

export function avatarWorkerLockPath(): string {
  return lockPath('avatar-worker.lock');
}

export function readPidFrom(lockFile: string): number | null {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function readWorkerPid(): number | null {
  return readPidFrom(workerLockPath());
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 说明进程存在但当前用户无权发信号 —— 仍算活着；ESRCH 才是真的没了
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function alive(lockFile: string): boolean {
  const pid = readPidFrom(lockFile);
  return pid !== null && isPidAlive(pid);
}

export function isWorkerRunning(): boolean {
  return alive(workerLockPath());
}

/** 数字人解析进程：不起它，数字人任务会一直停在「排队中」，没人提交给平台 */
export function isAvatarWorkerRunning(): boolean {
  return alive(avatarWorkerLockPath());
}
