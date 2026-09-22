import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';

/**
 * 鲲之益（数字人平台）连接状态（2026-09-22 需求迭代）。
 *
 * ## 与妙思的区别：**全体共用一份**
 *
 * 妙思会话 2026-09-22 起按编导一人一份；鲲之益不同 —— 平台的形象/音色/额度
 * 是公司统一配置的，会话全局只有一份（data/avatar-session/）。因此这里的
 * 函数**不带 userId**，读写都是同一份文件。
 *
 * ## 文件协议（与妙思同构）
 *
 *   - state.json        平台登录会话（storageState，avatar:login 早已在用）
 *   - health.json       连接结论（worker 探测后写、web 只读）
 *   - control.json      web → worker 的请求通道（探测/登录请求 + 登录凭据）
 *   - login-status.json worker → web 的登录进度（弹窗轮询用）
 *
 * ## 凭据安全（重要）
 *
 * 「未连接自动配置连接」靠**账号密码自动登录**（2026-09-22 探针实测：登录页
 * 默认就是账密表单、无图形验证码）。编导在网页输入的账号密码经 web 写进
 * control.json，worker 读到的**第一件事就是清掉这两个字段再写回**——
 * 凭据只在该文件里短暂存在，不入库、不进 git（data/ 已 ignore）、
 * 不出现在任何日志与 login-status 里。
 */

export type AvatarHealthStatus = 'VALID' | 'EXPIRED' | 'MISSING' | 'UNKNOWN';

export type AvatarHealth = {
  status: AvatarHealthStatus;
  checkedAt: string | null;
  /** PROBE=真实浏览器探测；JOB_OK=最近一次数字人任务提交成功；NONE=文件判定 */
  source: 'PROBE' | 'JOB_OK' | 'NONE';
  message: string;
  /** state.json 更新时间 */
  sessionMtime: string | null;
  cookieCount: number;
  /** 探测耗时（毫秒），仅 source=PROBE 有 */
  costMs?: number;
};

export type AvatarControl = {
  probeRequestedAt?: string;
  ackedProbeAt?: string;
  loginRequestedAt?: string;
  loginRequestedBy?: string;
  /** 登录凭据：worker 读取后立即清除，绝不长期落盘 */
  loginUsername?: string;
  loginPassword?: string;
  loginCancelAt?: string;
};

export type AvatarLoginPhase =
  | 'IDLE'
  | 'STARTING'
  | 'LOGGING_IN'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED';

export type AvatarLoginStatus = {
  phase: AvatarLoginPhase;
  message: string;
  startedAt: string | null;
  startedBy?: string;
  updatedAt?: string;
};

const IDLE_LOGIN: AvatarLoginStatus = {
  phase: 'IDLE',
  message: '',
  startedAt: null,
};

/** 目录：与 storageState 同目录（data/avatar-session/） */
function sessionDir(): string {
  return path.dirname(cfg.avatar.storageState);
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// ───────── health ─────────

export function avatarHealthPath(): string {
  return path.join(sessionDir(), 'health.json');
}

const EMPTY_HEALTH: AvatarHealth = {
  status: 'UNKNOWN',
  checkedAt: null,
  source: 'NONE',
  message: '还没有检测过连接状态。',
  sessionMtime: null,
  cookieCount: 0,
};

export function readAvatarHealth(): AvatarHealth {
  const h = readJson<AvatarHealth>(avatarHealthPath());
  if (!h || typeof h.status !== 'string') return { ...EMPTY_HEALTH };
  return h;
}

export function writeAvatarHealth(patch: Partial<AvatarHealth>): AvatarHealth {
  const next: AvatarHealth = { ...readAvatarHealth(), ...patch };
  writeJsonAtomic(avatarHealthPath(), next);
  return next;
}

/** 会话文件零成本判定：文件不存在时不必开浏览器就能定罪 */
export function checkAvatarSessionFile(): Pick<AvatarHealth, 'status' | 'sessionMtime' | 'cookieCount'> {
  try {
    if (!fs.existsSync(cfg.avatar.storageState)) {
      return { status: 'MISSING', sessionMtime: null, cookieCount: 0 };
    }
    const raw = readJson<{ cookies?: unknown[] }>(cfg.avatar.storageState);
    const cookies = Array.isArray(raw?.cookies) ? raw.cookies.length : 0;
    return {
      status: 'UNKNOWN',
      sessionMtime: fs.statSync(cfg.avatar.storageState).mtime.toISOString(),
      cookieCount: cookies,
    };
  } catch {
    return { status: 'UNKNOWN', sessionMtime: null, cookieCount: 0 };
  }
}

/** 结论 TTL：与妙思一致 15 分钟，避免页面之间来回点就反复开浏览器 */
export function avatarHealthTtlMs(): number {
  return 15 * 60 * 1000;
}

export function isAvatarHealthStale(h: AvatarHealth): boolean {
  if (h.status === 'MISSING') return false; // 没有会话文件是确定事实，不需要重测
  if (!h.checkedAt) return true;
  const t = Date.parse(h.checkedAt);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > avatarHealthTtlMs();
}

export function avatarNeedsAttention(h: AvatarHealth): boolean {
  return h.status !== 'VALID';
}

// ───────── control（web → worker）─────────

export function avatarControlPath(): string {
  return path.join(sessionDir(), 'control.json');
}

export function readAvatarControl(): AvatarControl {
  return readJson<AvatarControl>(avatarControlPath()) ?? {};
}

export function writeAvatarControl(patch: AvatarControl): AvatarControl {
  const next: AvatarControl = { ...readAvatarControl(), ...patch };
  // undefined 的字段要真正删掉（JSON.stringify 会丢弃 undefined，但显式处理更稳）
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) delete (next as Record<string, unknown>)[k];
  }
  writeJsonAtomic(avatarControlPath(), next);
  return next;
}

/**
 * 清除凭据字段：worker 登录流程拿到凭据后的第一个动作。
 * 无论登录成败，control.json 里都不能残留密码。
 */
export function clearAvatarCredentials(): void {
  writeAvatarControl({ loginUsername: undefined, loginPassword: undefined });
}

// ───────── login-status（worker → web）─────────

export function avatarLoginStatusPath(): string {
  return path.join(sessionDir(), 'login-status.json');
}

export function readAvatarLoginStatus(): AvatarLoginStatus {
  const s = readJson<AvatarLoginStatus>(avatarLoginStatusPath());
  if (!s || typeof s.phase !== 'string') return { ...IDLE_LOGIN };
  return { ...IDLE_LOGIN, ...s };
}

export function writeAvatarLoginStatus(patch: Partial<AvatarLoginStatus>): AvatarLoginStatus {
  const next: AvatarLoginStatus = { ...readAvatarLoginStatus(), ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(avatarLoginStatusPath(), next);
  return next;
}

/** worker 启动时调用：把上次进程中断留下的「进行中」状态归位，避免 UI 永远显示登录中 */
export function resetStaleAvatarLoginStatus(): void {
  const s = readAvatarLoginStatus();
  if (s.phase === 'STARTING' || s.phase === 'LOGGING_IN') {
    writeAvatarLoginStatus({ phase: 'CANCELLED', message: '解析进程重启，上次登录已中断，可重新发起。' });
  }
}
