'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtLocalFull } from '@/lib/datetime';

/**
 * 我的妙思会话页（2026-09-20 需求迭代；2026-09-22 改为**每人一份**）。
 *
 * 用户点提示栏的「去扫码登录」跳到这里，点了按钮就能在网页里扫码，
 * 不用回终端执行 npm run muse:login。
 *
 * 分工（与提示栏一致）：
 *   - 本页只发请求、显示二维码与进度；
 *   - 真正开浏览器、拿二维码、保存会话的是 worker（Chromium 单一所有者）。
 *
 * 一个必须说清的事实：扫码发生在 worker 的无头浏览器里，本页只是把二维码「图」显示出来。
 * 所以用户扫完后，会话是落进 worker 里**该用户自己**的会话文件 ——
 * 这正是不需要重启解析进程的原因。
 *
 * 2026-09-22：会话不再全站共用 —— 每个编导扫自己的腾讯妙思账号，
 * 所以本页展示与操作的都只是「当前登录者自己的」那一份；
 * 权限从「仅维护人员」放开为「任何登录用户（操作自己的）」。
 */

type Health = {
  status: 'VALID' | 'EXPIRED' | 'MISSING' | 'UNKNOWN';
  checkedAt: string | null;
  source: string;
  message: string;
  sessionMtime: string | null;
  cookieCount: number;
  /** 会话 cookie 里最晚的到期时间：零成本判据的来源，也是最有用的预告 */
  sessionExpiresAt?: string | null;
  costMs?: number;
};

type LoginStatus = {
  phase: 'IDLE' | 'STARTING' | 'WAITING_SCAN' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  startedAt: string | null;
  updatedAt: string | null;
  qrAt: string | null;
  message: string;
  qrExpiresAt: string | null;
  startedBy?: string;
};

type LoginResp = {
  status: LoginStatus;
  health: Health;
  workerRunning: boolean;
  canOperate: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  VALID: '登录态有效',
  EXPIRED: '登录态已失效',
  MISSING: '尚无登录会话',
  UNKNOWN: '状态未知',
};

const PHASE_LABEL: Record<string, string> = {
  IDLE: '未开始',
  STARTING: '正在打开登录页',
  WAITING_SCAN: '等待扫码',
  SUCCESS: '登录成功',
  FAILED: '登录失败',
  CANCELLED: '已取消',
};

function fmt(iso: string | null): string {
  return fmtLocalFull(iso);
}

function clock(iso: string | null, now: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const left = Math.round((t - now) / 1000);
  if (left <= 0) return '已过期，正在换新码';
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function MuseSessionClient() {
  const [data, setData] = useState<LoginResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [qrTick, setQrTick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/muse/login', { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (j?.ok) setData(j.data as LoginResp);
      return j?.data as LoginResp;
    } catch {
      return undefined;
    }
  }, []);

  // 进入页面即查一次；等待扫码期间每 2.5 秒轮询（这是唯一需要高频的场景）
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const phase = data?.status.phase ?? 'IDLE';
  const running = phase === 'STARTING' || phase === 'WAITING_SCAN';

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!running) return;
    timerRef.current = setInterval(() => void load(), 2500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [running, load]);

  // 二维码换了就换一张图（用 qrAt 破浏览器缓存）
  useEffect(() => {
    setQrTick((v) => v + 1);
  }, [data?.status.qrAt]);

  const act = useCallback(
    async (action: 'start' | 'cancel', opts?: { force?: boolean }) => {
      setBusy(true);
      setError('');
      try {
        const res = await fetch('/api/muse/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, force: opts?.force === true }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) {
          setError(j?.error ?? `操作失败（HTTP ${res.status}）`);
        } else if (j.data?.status) {
          setData((d) => (d ? { ...d, status: j.data.status } : d));
        }
      } catch (e) {
        setError(`操作失败：${(e as Error).message}`);
      } finally {
        setBusy(false);
        // 等一下让 worker 写出首帧状态，再拉一次
        setTimeout(() => void load(), 600);
      }
    },
    [load],
  );

  const h = data?.health;
  const st = data?.status;
  const qrUrl = `/api/muse/login/qr?t=${encodeURIComponent(st?.qrAt ?? '')}&n=${qrTick}`;

  return (
    <>
      <div className="card" style={{ padding: '18px 20px', marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>我的妙思会话</h2>

        <div className="kv" style={{ marginBottom: 14 }}>
          <div className="k">当前状态</div>
          <div>
            {h ? (
              <span
                className={`chip ${
                  h.status === 'VALID' ? 'ok' : h.status === 'EXPIRED' || h.status === 'MISSING' ? 'danger' : 'warn'
                }`}
              >
                {STATUS_LABEL[h.status] ?? h.status}
              </span>
            ) : (
              '—'
            )}
            {h?.message ? <span className="muted" style={{ marginLeft: 8, fontSize: 12.5 }}>{h.message}</span> : null}
          </div>
        </div>

        <div className="kv" style={{ marginBottom: 14 }}>
          <div className="k">上次检测</div>
          <div>
            {fmt(h?.checkedAt ?? null)}
            {h?.checkedAt ? <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>（{h.source}）</span> : null}
            {h?.costMs ? (
              <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>探测耗时 {(h.costMs / 1000).toFixed(1)}s</span>
            ) : null}
          </div>
        </div>

        <div className="kv" style={{ marginBottom: 14 }}>
          <div className="k">会话文件</div>
          <div>
            更新于 {fmt(h?.sessionMtime ?? null)}
            {h && h.cookieCount > 0 ? <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{h.cookieCount} 条 cookie</span> : null}
          </div>
        </div>

        <div className="kv" style={{ marginBottom: 14 }}>
          <div className="k">会话到期</div>
          <div>
            {h?.sessionExpiresAt ? (
              <>
                {fmt(h.sessionExpiresAt)}
                {Date.parse(h.sessionExpiresAt) < now ? (
                  <span className="chip danger" style={{ marginLeft: 8 }}>已过期</span>
                ) : (
                  <span className="chip warn" style={{ marginLeft: 8 }}>未到期</span>
                )}
                <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  （取自会话 cookie 自带的到期时间，无需开浏览器即可判定过期）
                </span>
              </>
            ) : (
              <span className="muted" style={{ fontSize: 12.5 }}>
                会话 cookie 未带到期时间（会话级），只能靠实际探测判定。
              </span>
            )}
          </div>
        </div>

        <div className="kv" style={{ marginBottom: 14 }}>
          <div className="k">解析进程</div>
          <div>
            {data ? (
              data.workerRunning ? (
                <span className="chip ok">运行中</span>
              ) : (
                <span className="chip danger">未运行</span>
              )
            ) : (
              '—'
            )}
            {data && !data.workerRunning ? (
              <span className="muted" style={{ marginLeft: 8, fontSize: 12.5 }}>
                扫码登录与探测都由解析进程执行，请先启动工作台（start-workbench.bat 或 npm run dev）。
              </span>
            ) : null}
          </div>
        </div>

        {/*
          2026-09-22：不再有「编导不能扫码」的限制 —— 会话一人一份，
          这里展示与操作的只是当前登录者自己的那份，所以没有角色分支。
        */}
      </div>

      <div className="card" style={{ padding: '18px 20px' }}>
        <h2 style={{ marginTop: 0 }}>扫码登录</h2>

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 320px', minWidth: 280 }}>
            <div className="kv" style={{ marginBottom: 12 }}>
              <div className="k">进度</div>
              <div>
                <span className="chip info">{PHASE_LABEL[phase] ?? phase}</span>
                {st?.message ? <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>{st.message}</div> : null}
                {st?.startedBy && running ? (
                  <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>发起人：{st.startedBy}</div>
                ) : null}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="primary"
                onClick={() => void act('start')}
                disabled={busy || running || !data?.workerRunning}
              >
                {running ? '登录进行中…' : '开始扫码登录'}
              </button>
              {/*
                已登录状态下导航里没有「登录/注册」入口，点不出二维码，
                所以换账号必须强制（不带本地登录态启动）。
              */}
              <button
                onClick={() => void act('start', { force: true })}
                disabled={busy || running || !data?.workerRunning}
                title="不带本地登录态启动，用于更换绑定的微信号"
              >
                更换账号登录
              </button>
              <button onClick={() => void act('cancel')} disabled={busy || !running}>
                取消
              </button>
              <button onClick={() => void load()} disabled={busy}>
                刷新状态
              </button>
            </div>

            <div className="muted" style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.7 }}>
              <div>· 用微信扫描右侧二维码即可，无需在终端执行任何命令。</div>
              <div>· 扫码成功后会话立即写入，工作台提示栏会自动消失，<strong>不需要重启解析进程</strong>。</div>
              <div>· 二维码约 4 分钟换一次，超时这里会自动刷新。</div>
              <div>· 当前已是登录态、想换一个微信号时点「更换账号登录」—— 直接点「开始扫码登录」会被自动跳过（因为没有登录入口）。</div>
            </div>

            {error ? (
              <div className="banner danger" style={{ marginTop: 12, marginBottom: 0 }}>
                {error}
              </div>
            ) : null}
          </div>

          <div style={{ flex: '0 1 300px', textAlign: 'center' }}>
            {running ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrUrl}
                  alt="腾讯妙思登录二维码"
                  width={240}
                  height={240}
                  style={{ background: '#fff', borderRadius: 8, padding: 8, border: '1px solid var(--border)' }}
                />
                <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
                  二维码剩余有效时间 {clock(st?.qrExpiresAt ?? null, now)}
                </div>
                <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                  已扫码但页面没反应？点「取消」后重新开始，会换一张新码。
                </div>
              </>
            ) : (
              <div
                className="muted"
                style={{
                  width: 256,
                  height: 256,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1px dashed var(--border)',
                  borderRadius: 8,
                  fontSize: 12.5,
                  margin: '0 auto',
                }}
              >
                点「开始扫码登录」后这里显示二维码
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
