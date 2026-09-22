'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 登录工作台后**自动检测鲲之益（数字人平台）连接状态，未连接就自动弹出连接窗口**
 * （2026-09-22 需求迭代）。
 *
 * ## 行为约定（与需求方确认过）
 *
 * 1. 会话**全体共用一份**（平台形象/音色/额度公司统一配置），所以任何登录用户
 *    都可以发起连接；后扫的人保存的会话会覆盖之前的（同一天内通常是同一个人配置）。
 * 2. 连接方式是**账号密码自动登录**：弹窗里输入鲲之益的账号和密码，
 *    服务器端自动完成登录（2026-09-22 探针实测登录页无图形验证码）。
 * 3. 一次登录只自动检查一次（sessionStorage 按用户记忆），可「稍后再说」跳过、
 *    不阻断工作台任何功能；生成数字人视频时若发现未连接，页面会再提示。
 *
 * ## 与妙思自动弹码（MuseAutoLogin）的关系
 *
 * 两套并立：那个管腾讯妙思（一人一份、扫码），这个管鲲之益（全体一份、账密）。
 * 结构刻意保持同构，包括同一个坑的规避 —— dev 下 reactStrictMode 会把 effect
 * 双调用，「只查一次」的守卫必须挂 Promise（bootRef）而不是布尔标记 + cleanup 取消，
 * 否则第一次执行被 cleanup 杀掉、第二次被标记挡住，自动检查一次都不会跑。
 */

type Health = {
  status: 'VALID' | 'EXPIRED' | 'MISSING' | 'UNKNOWN';
  checkedAt: string | null;
  message: string;
  cookieCount: number;
};

type SessionResp = {
  health: Health;
  stale: boolean;
  needsAttention: boolean;
  workerRunning: boolean;
  viewer?: { id: string; displayName: string };
};

type LoginStatus = {
  phase: 'IDLE' | 'STARTING' | 'LOGGING_IN' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  message: string;
};

type LoginResp = {
  status: LoginStatus;
  workerRunning: boolean;
};

const SETTLE_TIMEOUT_MS = 30_000;
const POLL_MS = 1500;

/** QA 逃生口：验收脚本置此标记后不自动弹窗（真人浏览器不受影响） */
function autoLoginDisabled(): boolean {
  try {
    return localStorage.getItem('avatarAutoLoginDisabled') === '1';
  } catch {
    return false;
  }
}

export default function AvatarAutoLogin() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState<SessionResp | null>(null);
  const [login, setLogin] = useState<LoginResp | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  /** 与 MuseAutoLogin 同理由：StrictMode 双挂载下只跑一次必须挂 Promise */
  const bootRef = useRef<Promise<void> | null>(null);

  const loadLogin = useCallback(async (): Promise<LoginResp | null> => {
    try {
      const res = await fetch('/api/avatar/login', { cache: 'no-store' });
      if (!res.ok) return null;
      const j = await res.json();
      if (!j?.ok) return null;
      setLogin(j.data as LoginResp);
      return j.data as LoginResp;
    } catch {
      return null;
    }
  }, []);

  const loadSession = useCallback(async (): Promise<SessionResp | null> => {
    try {
      const res = await fetch('/api/avatar/session', { cache: 'no-store' });
      if (!res.ok) return null;
      const j = await res.json();
      if (!j?.ok) return null;
      setSession(j.data as SessionResp);
      return j.data as SessionResp;
    } catch {
      return null;
    }
  }, []);

  /** 用网页里输入的账号密码发起连接 */
  const startLogin = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/avatar/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', username, password }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) {
        setError(j?.error ?? `发起连接失败（HTTP ${res.status}）`);
        return;
      }
      void loadLogin();
    } catch (e) {
      setError(`发起连接失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [username, password, loadLogin]);

  /** 登录工作台后的那一次自动检查 */
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = (async () => {
      if (autoLoginDisabled()) return;

      const first = await loadSession();
      if (!first) return;
      const viewerId = first.viewer?.id ?? '';
      const key = `avatarAutoCheck:${viewerId}`;

      let done = false;
      try {
        done = sessionStorage.getItem(key) === '1';
      } catch {
        /* 隐私模式下退化为每次都检查（可接受） */
      }
      if (done) return;

      const markDone = () => {
        try {
          sessionStorage.setItem(key, '1');
        } catch {
          /* 忽略 */
        }
      };

      // 已连接：这就算检查过了
      if (first.health.status === 'VALID') {
        markDone();
        return;
      }

      // 结论还没出来（正在探测）：等到结论落地再看
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      let latest = first;
      while (latest.health.checkedAt === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const next = await loadSession();
        if (next) latest = next;
      }

      if (!latest.needsAttention) {
        markDone();
        return;
      }

      markDone();
      setOpen(true);
      void loadLogin();
    })();
  }, [loadSession, loadLogin]);

  // 弹窗打开且登录进行中：每 2.5 秒拉一次进度；SUCCESS 自动关窗
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => void loadLogin(), 2500);
    return () => clearInterval(t);
  }, [open, loadLogin]);

  useEffect(() => {
    if (open && login?.status.phase === 'SUCCESS') {
      const t = setTimeout(() => setOpen(false), 2000);
      return () => clearTimeout(t);
    }
  }, [open, login?.status.phase]);

  const phase = login?.status.phase ?? 'IDLE';
  const running = phase === 'STARTING' || phase === 'LOGGING_IN';
  const missing = session?.health.status === 'MISSING';

  if (!open) return null;

  return (
    <div className="muse-modal-mask" role="dialog" aria-modal="true" aria-label="连接鲲之益数字人平台">
      <div className="muse-modal">
        <div className="mm-head">
          <div className="mm-title">
            连接数字人平台
            <span className="chip warn" style={{ marginLeft: 8 }}>
              {missing ? '还没有连接过' : '连接已失效'}
            </span>
          </div>
          <div className="mm-sub">
            生成数字人视频需要<strong>鲲之益平台</strong>的账号。请输入鲲之益的账号和密码，
            系统会自动完成连接，全程约 10~30 秒。账号由公司统一分配；连接一次后
            全团队共用，失效时任何人都可重新连接。
          </div>
        </div>

        <div className="mm-body">
          <div className="mm-side" style={{ width: '100%' }}>
            {running ? (
              <div className="banner warn" style={{ margin: '0 0 12px' }}>
                {login?.status.message || '正在连接…'}（可点「取消」中止）
              </div>
            ) : phase === 'FAILED' ? (
              <div className="banner danger" style={{ margin: '0 0 12px' }}>
                {login?.status.message || '连接失败'}
              </div>
            ) : phase === 'SUCCESS' ? (
              <div className="banner ok" style={{ margin: '0 0 12px' }}>连接成功，本窗口将自动关闭。</div>
            ) : null}

            <div className="field">
              <label>鲲之益账号</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                placeholder="请输入鲲之益平台的账号"
              />
            </div>
            <div className="field">
              <label>鲲之益密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                placeholder="请输入鲲之益平台的密码"
              />
            </div>

            <div className="mm-notes">
              <div>· 密码只用于本次连接，连接完成后立即从服务器内存与临时文件中清除，不做保存。</div>
              <div>· 连接失败时请先确认账号密码；若平台开启了短信验证码，请联系维护人员处理。</div>
            </div>
            {error ? (
              <div className="banner danger" style={{ fontSize: 12, margin: '8px 0 0' }}>{error}</div>
            ) : null}
            {session && !session.workerRunning ? (
              <div className="banner warn" style={{ fontSize: 12, margin: '8px 0 0' }}>
                数字人解析进程未运行，暂时无法连接。请让维护人员启动工作台。
              </div>
            ) : null}
          </div>
        </div>

        <div className="mm-actions">
          <span className="muted" style={{ fontSize: 12, marginRight: 'auto' }}>
            今天不用数字人功能？可以跳过，其它功能照常使用。
          </span>
          {running ? (
            <button
              onClick={async () => {
                await fetch('/api/avatar/login', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ action: 'cancel' }),
                }).catch(() => null);
                setTimeout(() => void loadLogin(), 600);
              }}
              disabled={busy}
            >
              取消
            </button>
          ) : (
            <button className="primary" onClick={() => void startLogin()} disabled={busy || !username || !password}>
              {busy ? '发起中…' : phase === 'FAILED' ? '重试连接' : '连接'}
            </button>
          )}
          <button onClick={() => setOpen(false)}>稍后再说</button>
        </div>
      </div>
    </div>
  );
}
