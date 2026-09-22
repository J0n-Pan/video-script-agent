import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from '../config';

/**
 * 妙思会话的**按用户目录布局**（2026-09-22 需求迭代）。
 *
 * ## 为什么要有这个模块
 *
 * 改动前：全机器只有**一份**妙思会话（`data/muse-session/state.json`），
 * 由维护人员扫一次码，所有人共用。配套的 `health.json` / `control.json` /
 * `login-status.json` / `qr.jpg` 也都是单份，路径散落在 muse-health 里各处拼。
 *
 * 改动后：每个编导用**自己的腾讯妙思账号**，会话必须一人一份，否则
 * 「A 扫码把 B 的账号顶掉、B 的抓取用了 A 的身份」这类问题无法避免。
 * 于是引入本模块作为**唯一的路径真相来源**：
 *
 *   data/muse-session/
 *     state.json            ← 改动前的老会话，保留作存档（迁移脚本会复制走，见下）
 *     users/
 *       <userId>/
 *         state.json         ← 该用户的登录态（Playwright storageState）
 *         health.json        ← 该用户的登录态结论
 *         control.json       ← web 写请求 / worker 读取（每人一条通道）
 *         login-status.json  ← 该用户扫码登录的进度
 *         qr.jpg             ← 该用户的二维码图片
 *
 * ## 为什么按 userId 而不是用户名
 *
 * 用户名可改（`PATCH` 用户资料），改完会话就找不到了。userId 是主键、不变。
 * 界面上要显示的是显示名，那是各页面自己查库的事，不该混进路径。
 *
 * ## 为什么目录名还要消毒
 *
 * userId 目前是 cuid（天然安全），但路径拼接**不能依赖上游的善良**：
 * 一旦有人把 `../../` 或 `..\\` 传进来，会话文件就会被写到项目外。
 * 所以只放行 `[A-Za-z0-9_-]`，其余情况退化为 sha1 摘要（仍然稳定可复现）。
 */

/** 用户会话子目录名（放在 data/muse-session/ 下） */
export const MUSE_USERS_DIRNAME = 'users';

/** 允许直接作为目录名的字符；不满足就走摘要 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function safeSegment(id: string): string {
  const raw = String(id ?? '').trim();
  if (SAFE_ID_RE.test(raw)) return raw;
  return `u_${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 32)}`;
}

/**
 * 妙思会话根目录。
 *
 * 注意是从 `cfg.muse.storageState` 的**父目录**推导，而不是另起一个环境变量：
 * 这样 `MUSE_STORAGE_STATE` 一改（测试、多实例部署），整套目录跟着挪，不会一半新一半旧。
 */
export function museSessionRoot(): string {
  return path.dirname(cfg.muse.storageState);
}

/** 改动前的全局会话文件（存档用） */
export function museLegacyStatePath(): string {
  return path.resolve(cfg.muse.storageState);
}

/** 某用户的会话目录 */
export function museUserDir(userId: string): string {
  return path.join(museSessionRoot(), MUSE_USERS_DIRNAME, safeSegment(userId));
}

/** 某用户的登录态文件（Playwright storageState） */
export function museStatePath(userId: string): string {
  return path.join(museUserDir(userId), 'state.json');
}

/** 某用户的登录态结论 */
export function museHealthPath(userId: string): string {
  return path.join(museUserDir(userId), 'health.json');
}

/** 某用户的控制文件（web 写、worker 读，单向） */
export function museControlPath(userId: string): string {
  return path.join(museUserDir(userId), 'control.json');
}

/** 某用户扫码登录的进度 */
export function museLoginStatusPath(userId: string): string {
  return path.join(museUserDir(userId), 'login-status.json');
}

/** 某用户的二维码图片（worker 写，web 读并发给浏览器） */
export function museQrPath(userId: string): string {
  return path.join(museUserDir(userId), 'qr.jpg');
}

/** 该用户是否已经有会话文件（登录过） */
export function museHasState(userId: string): boolean {
  try {
    return fs.existsSync(museStatePath(userId));
  } catch {
    return false;
  }
}

/**
 * 列出所有「有过会话痕迹」的用户目录。
 *
 * worker 靠它发现待处理的请求：每个用户一条 control.json，
 * worker 无法预知有哪些用户，只能扫目录（不查库 —— worker 里查库要为每个用户
 * 建一套 join，而目录本身就够用，且天然只在有人真正用过之后才出现）。
 */
export function listMuseUserIds(): string[] {
  const root = path.join(museSessionRoot(), MUSE_USERS_DIRNAME);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      try {
        return fs.statSync(path.join(root, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** 会话目录下还有一个「当前正在扫码的是谁」的占位文件，用于给排队的人解释原因 */
export function museLoginOwnerPath(): string {
  return path.join(museSessionRoot(), 'login-owner.json');
}
