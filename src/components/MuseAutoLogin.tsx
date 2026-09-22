'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { museAutoCheckKey } from '@/lib/muse-ui';

/**
 * 登录工作台后**自动检查妙思登录态，失效就弹二维码扫码**（2026-09-22 需求迭代）。
 *
 * ## 需求背景
 *
 * 妙思会话从「全机器一份、由维护人员统一登录」改成一**人一份**（每个编导扫自己的
 * 腾讯妙思账号）。既然不再有人替全站兜着登录态，就必须保证「编导一登录工作台，
 * 自己的妙思连接状态就是已知的」——这段逻辑就是干这个的。
 *
 * ## 已定的两个行为约定（与需求方确认过）
 *
 * 1. **自动查 + 自动弹二维码，但可跳过**：失效/未登录时不等编导自己点，
 *    直接发起扫码并把二维码弹出来（大多数人这时候正要扫码）。
 *    但弹窗上有「稍后再说」——今天只想传本地视频、不碰妙思链接的编导不该被堵住，
 *    且**不阻断**工作台任何功能。
 * 2. **一次登录只自动检查一次**：靠 sessionStorage 记忆（按用户区分）。
 *    刷新、跳页、来回切菜单都不会反复弹，否则每次都弹会立刻变成噪音。
 *    登录成功时登录页会清掉这条记忆，所以「下次登录工作台」必然重新检查一遍。
 *
 * ## 为什么挂在这里而不是妙思会话页
 *
 * 它必须出现在**登录后的第一个页面**（任务是 /tasks，可能是别的入口），
 * 所以挂在 AppHeader 里，与页面无关。
 *
 * ## 与顶部提示栏的分工
 *
 * 本组件只负责「登录后那一次」；漏掉的、当场没扫的、用着用着过期的，
 * 由 MuseSessionBanner 长期挂着提醒（它不弹窗、可收起）。两者读同一份结论文件，
 * 不会出现口径不一致。
 */

type Health = {
  status: 'VALID' | 'EXPIRED' | 'MISSING' | 'UNKNOWN';
  checkedAt: string | null;
  message: string;
  cookieCount: number;
  sessionExpiresAt?: string | null;
};

type SessionResp = {
  health: Health;
  stale: boolean;
  needsAttention: boolean;
  workerRunning: boolean;
  viewer?: { id: string; displayName: string };
};

type LoginStatus = {
  phase: 'IDLE' | 'STARTING' | 'WAITING_SCAN' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  qrAt: string | null;
  message: string;
  qrExpiresAt: string | null;
  queuedBehind?: string;
};

type LoginResp = {
  status: LoginStatus;
  health: Health;
  workerRunning: boolean;
};

/** 等探测结论出来的总时长上限：探测本体约 10 秒，给足余量但别让人干等 */
const SETTLE_TIMEOUT_MS = 30_000;
const POLL_MS = 1500;

/**
 * 自动弹窗的**总开关**（浏览器本地记忆）。
 *
 * 为什么要有它：验收脚本会**故意**把登录态结论写成「已失效」来测提示栏，
 * 如果不关掉，脚本一打开页面就会真的发起一次扫码登录 ——
 * worker 会开 Chromium 等扫码，最长 10 分钟，期间不领新任务，整个验收队列被堵死。
 * 所以所有浏览器验收脚本都会先置这个标记；真人浏览器不会有它，行为不变。
 */
function autoLoginDisabled(): boolean {
  try {
    return localStorage.getItem('museAutoLoginDisabled') === '1';
  } catch {
    return false;
  }
}

export default function MuseAutoLogin() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState<SessionResp | null>(null);
  const [login, setLogin] = useState<LoginResp | null>(null);
  const [qrTick, setQrTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  /**
   * 「一次登录只查一次」的守卫必须挂 Promise 而不是布尔标记 + cleanup 取消。
   * 踩过的坑：dev 下 reactStrictMode 开启（next.config.mjs），React 18 会把 effect
   * 跑成「挂载 → 清理 → 再挂载」——旧写法里第一次的异步检查被 cleanup 的
   * cancelled=true 半路杀掉，第二次又被布尔标记挡住，结果自动检查在 dev 下
   * **一次都不会执行**（生产构建不双调用，所以真机上又看似正常，极难发现）。
   * 挂 Promise 则两次挂载共享同一次执行，天然幂等。
   */
  const bootRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadLogin = useCallback(async (): Promise<LoginResp | null> => {
    try {
      const res = await fetch('/api/muse/login', { cache: 'no-store' });
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
      const res = await fetch('/api/muse/session', { cache: 'no-store' });
      if (!res.ok) return null;
      const j = await res.json();
      if (!j?.ok) return null;
      setSession(j.data as SessionResp);
      return j.data as SessionResp;
    } catch {
      return null;
    }
  }, []);

  /** 发起一次扫码登录（自动弹窗与弹窗上的「重新发起」共用） */
  const startLogin = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/muse/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) {
        setError(j?.error ?? `发起扫码失败（HTTP ${res.status}）`);
        return;
      }
      if (j.data?.status) setLogin((v) => (v ? { ...v, status: j.data.status } : v));
      // worker 要开浏览器、取码，给它一点时间再拉状态
      setTimeout(() => void loadLogin(), 800);
    } catch (e) {
      setError(`发起扫码失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [loadLogin]);

  /** 登录工作台后的那一次自动检查（幂等：StrictMode 双挂载也只跑一次） */
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = (async () => {
      if (autoLoginDisabled()) return;

      // 先拿一次结论（顺带知道「我是谁」，用于按人区分记忆键）
      const first = await loadSession();
      if (!first) return;
      const viewerId = first.viewer?.id ?? '';
      const key = museAutoCheckKey(viewerId);

      let done = false;
      try {
        done = sessionStorage.getItem(key) === '1';
      } catch {
        /* 隐私模式下不可用：退化为每次都检查（可接受） */
      }
      if (done) return;

      const markDone = () => {
        try {
          sessionStorage.setItem(key, '1');
        } catch {
          /* 忽略 */
        }
      };

      // 已经是有效会话：这就算检查过了，不必弹窗
      if (first.health.status === 'VALID') {
        markDone();
        return;
      }

      // 结论还没出来（worker 正在探测）：等到结论落地再看
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      let latest = first;
      while (latest.health.checkedAt === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const next = await loadSession();
        if (next) latest = next;
      }

      // 无需人工处理（有效，或状态未知不武断打扰）→ 只记已检查
      if (!latest.needsAttention) {
        markDone();
        return;
      }

      // 该扫码了：自动发起并把二维码弹出来
      markDone();
      setOpen(true);
      // 解析进程没在跑时**不**自动发起（发了也会 409）：
      // 此时 worker 无法执行登录，弹窗只用来把原因讲清楚，等人把工作台启动好再点
      if (latest.workerRunning) await startLogin();
      void loadLogin();
    })();
  }, [loadLogin, loadSession, startLogin]);

  // 弹窗打开期间：倒计时每秒走、状态每 2.5 秒拉一次
  useEffect(() => {
    if (!open) return;
    const t1 = setInterval(() => setNow(Date.now()), 1000);
    const t2 = setInterval(() => void loadLogin(), 2500);
    timerRef.current = t2;
    return () => {
      clearInterval(t1);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [open, loadLogin]);

  // 二维码换了就换张图（破浏览器缓存）
  useEffect(() => {
    setQrTick((v) => v + 1);
  }, [login?.status.qrAt]);

  const phase = login?.status.phase ?? 'IDLE';
  const running = phase === 'STARTING' || phase === 'WAITING_SCAN';

  // 扫成功后自动关掉弹窗，别让人手动关一个已经没用的窗口
  useEffect(() => {
    if (open && phase === 'SUCCESS') {
      const t = setTimeout(() => setOpen(false), 2500);
      return () => clearTimeout(t);
    }
  }, [open, phase]);

  // 跳过一次就整个浏览器会话都别再弹（提示栏仍在，故障不会被吞）
  const skip = useCallback(() => {
    setOpen(false);
  }, []);

  if (!open) return null;

  const h = session?.health;
  const qrUrl = `/api/muse/login/qr?t=${encodeURIComponent(login?.status.qrAt ?? '')}&n=${qrTick}`;
  const leftMs = login?.status.qrExpiresAt ? Date.parse(login.status.qrExpiresAt) - now : null;

  return (
    <div className="muse-modal-mask" role="dialog" aria-modal="true" aria-label="腾讯妙思扫码登录">
      <div className="muse-modal">
        <div className="mm-head">
          <div className="mm-title">
            登录腾讯妙思
            <span className="chip info" style={{ marginLeft: 8 }}>
              {h?.status === 'MISSING' ? '你还没有登录过' : '你的登录态已失效'}
            </span>
          </div>
          <div className="mm-sub">
            妙思链接需要<strong>你自己的</strong>腾讯妙思登录会话才能取回视频本体。扫一次码即可，
            会话只保存在本机、只属于你，不入库、不随代码提交。
          </div>
        </div>

        <div className="mm-body">
          <div className="mm-qr">
            {running ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrUrl}
                  alt="腾讯妙思登录二维码"
                  width={220}
                  height={220}
                  style={{ background: '#fff', borderRadius: 8, padding: 8 }}
                />
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  {leftMs !== null && leftMs > 0
                    ? `二维码剩余 ${Math.floor(leftMs / 60000)}:${String(Math.floor((leftMs % 60000) / 1000)).padStart(2, '0')}`
                    : '二维码约 4 分钟换一次，超时会自动刷新'}
                </div>
              </>
            ) : (
              <div className="mm-qr-empty">
                {phase === 'FAILED' ? '二维码获取失败' : '正在获取二维码…'}
              </div>
            )}
          </div>

          <div className="mm-side">
            <div className="mm-state">
              {login?.status.queuedBehind ? (
                <span className="chip warn">排队中</span>
              ) : phase === 'SUCCESS' ? (
                <span className="chip ok">登录成功</span>
              ) : phase === 'FAILED' ? (
                <span className="chip danger">登录失败</span>
              ) : (
                <span className="chip info">{running ? '等待扫码' : '准备中'}</span>
              )}
            </div>
            {login?.status.message ? (
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>{login.status.message}</div>
            ) : null}
            {h?.message ? (
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>结论：{h.message}</div>
            ) : null}
            {session && !session.workerRunning ? (
              <div className="banner warn" style={{ fontSize: 12, margin: '8px 0 0' }}>
                解析进程未运行，扫码登录与抓取都不可用。请先启动工作台（start-workbench.bat 或 npm run dev）。
              </div>
            ) : null}
            {error ? (
              <div className="banner danger" style={{ fontSize: 12, margin: '8px 0 0' }}>{error}</div>
            ) : null}

            <div className="mm-notes">
              <div>· 用微信扫描左侧二维码，无需在终端执行任何命令。</div>
              <div>· 扫码成功后会话立即写入，本窗口自动关闭，<strong>不需要重启解析进程</strong>。</div>
              <div>· 想换成另一个微信号，去「我的妙思会话」页点「更换账号登录」。</div>
            </div>
          </div>
        </div>

        <div className="mm-actions">
          <span className="muted" style={{ fontSize: 12, marginRight: 'auto' }}>
            今天不抓妙思链接？可以跳过，工作台其它功能照常使用。
          </span>
          {!running ? (
            <button onClick={() => void startLogin()} disabled={busy}>
              {busy ? '发起中…' : '重新获取二维码'}
            </button>
          ) : (
            <button
              onClick={async () => {
                await fetch('/api/muse/login', {
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
          )}
          <button className="primary" onClick={skip}>
            稍后再说
          </button>
        </div>
      </div>
    </div>
  );
}
