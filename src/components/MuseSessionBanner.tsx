'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { agoText, fmtLocal } from '@/lib/datetime';
import { museBannerCollapseKey } from '@/lib/muse-ui';

/**
 * 妙思登录态提示栏（2026-09-20 需求迭代；2026-09-22 改为**只看自己的会话**）。
 *
 * 需求约定：
 *   - 每次打开工作台主动查询妙思登录态；失效则出现提示栏，**长期保留**直到修好
 *   - **只反映当前登录者自己的**会话（会话已一人一份，别人的过期不该弹到你头上）
 *   - 「重新扫码登录」**人人可点** —— 不再有「统一登录」这回事，每个人都给自己扫
 *   - 可以临时收起；收起状态按浏览器会话 + **按人**记忆，换浏览器/换账号又会出现
 *
 * 实现要点：状态来自服务端文件（worker 写、API 读），不落地到 localStorage ——
 * 所以刷新、跳页都不会让提示消失，只有真正修好（状态变 VALID）才消失。
 *
 * 「收起」的语义（2026-09-20 验收发现并修正）：只对**当下这一段失效**有效。
 * 一旦状态发生过任何变化（哪怕又变回同一个值，例如修好过又再次过期），
 * 收起记忆立刻作废、提示栏重新出现 —— 否则一次收起会让下一次故障永远看不见。
 *
 * 与 MuseAutoLogin 的分工：那个只管「刚登录工作台那一次」自动查 + 弹码；
 * 本提示栏负责之后所有时候（漏查的、当场跳过的、用着用着过期的）。
 */

type Health = {
  status: 'VALID' | 'EXPIRED' | 'MISSING' | 'UNKNOWN';
  checkedAt: string | null;
  source: string;
  message: string;
  sessionMtime: string | null;
  cookieCount: number;
  /** 会话 cookie 自带的到期时间：零成本判据的来源 */
  sessionExpiresAt?: string | null;
  costMs?: number;
};

type SessionResp = {
  health: Health;
  stale: boolean;
  probePending: boolean;
  workerRunning: boolean;
  needsAttention: boolean;
  canOperate: boolean;
  viewer?: { id: string; displayName: string };
};

const SOURCE_LABEL: Record<string, string> = {
  PROBE: '主动检测',
  FETCH_OK: '最近一次抓取成功',
  FETCH_FAIL: '最近一次抓取失败',
  NONE: '会话文件判定',
};

/** 收起记忆的键：按人区分（会话已一人一份，不能把 A 的收起继承给 B） */
const collapseKey = (viewerId: string) => museBannerCollapseKey(viewerId || 'anonymous');

export default function MuseSessionBanner() {
  const [data, setData] = useState<SessionResp | null>(null);
  const [collapsed, setCollapsed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const waitRef = useRef<{ timer: ReturnType<typeof setInterval> | null; until: number }>({
    timer: null,
    until: 0,
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/muse/session', { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (j?.ok) setData(j.data as SessionResp);
    } catch {
      /* 网络抖动不改变提示栏状态，等下一轮 */
    }
  }, []);

  useEffect(() => {
    void load();
    // 只看本地状态文件、不触发探测，所以轮询很便宜：
    // 这样抓取失败（免费信号）能在一分钟内反映到提示栏
    const t = setInterval(() => void load(), 60_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const viewerId = data?.viewer?.id ?? '';

  // 收起记忆按人读：viewer 到手（或换了账号）时重新取一次
  useEffect(() => {
    try {
      setCollapsed(sessionStorage.getItem(collapseKey(viewerId)));
    } catch {
      /* 隐私模式下不可用：收起记忆丢失，提示栏照常出现 */
    }
  }, [viewerId]);

  // 状态一变，之前那次「收起」就作废（详见文件头注释）
  useEffect(() => {
    const s = data?.health.status ?? null;
    if (!s || !viewerId) return;
    let cur: string | null = null;
    try {
      cur = sessionStorage.getItem(collapseKey(viewerId));
    } catch {
      return;
    }
    if (cur === s) return;
    if (cur !== null) {
      sessionStorage.removeItem(collapseKey(viewerId));
      setCollapsed(null);
    }
  }, [data, viewerId]);

  // 相对时间每分钟刷新一次
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    return () => {
      if (waitRef.current.timer) clearInterval(waitRef.current.timer);
    };
  }, []);

  /** 手动重新检测：投递探测请求后短轮询，直到 checkedAt 变新或超时 */
  const recheck = useCallback(async () => {
    setBusy(true);
    const before = data?.health.checkedAt ?? null;
    try {
      const res = await fetch('/api/muse/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'probe' }),
      });
      const j = await res.json().catch(() => null);
      if (j?.ok && j.data?.refreshRequested === false) {
        // 解析进程没起来等情况：直接展示原因，不做无效等待
        await load();
        setBusy(false);
        return;
      }
    } catch {
      /* 落到下面的轮询 */
    }

    const until = Date.now() + 45_000;
    if (waitRef.current.timer) clearInterval(waitRef.current.timer);
    waitRef.current.until = until;
    waitRef.current.timer = setInterval(async () => {
      const res = await fetch('/api/muse/session', { cache: 'no-store' }).catch(() => null);
      const j = res?.ok ? await res.json().catch(() => null) : null;
      const h: Health | undefined = j?.data?.health;
      if ((h && h.checkedAt !== before) || Date.now() > waitRef.current.until) {
        if (waitRef.current.timer) clearInterval(waitRef.current.timer);
        waitRef.current.timer = null;
        if (j?.ok) setData(j.data as SessionResp);
        setBusy(false);
      }
    }, 3000);
  }, [data, load]);

  const h = data?.health;
  const show = Boolean(data?.needsAttention);
  if (!show || !h || !data) return null;
  if (collapsed === h.status) return null;

  const danger = h.status === 'EXPIRED';
  const waitProbe = data.probePending || busy;

  return (
    <div className={`banner muse-banner ${danger ? 'danger' : 'warn'}`}>
      <div className="mb-row">
        <div className="mb-main">
          <div className="mb-title">
            你的腾讯妙思登录态{danger ? '已失效' : '未就绪'}，妙思链接会在抓取阶段失败
          </div>
          <div className="mb-body">
            脚本文字与来源信息<strong>不受影响</strong> —— 失败的只是视频本体副本。
            可重新登录后重试该链接，或对这条任务使用本地补传。
          </div>
          <div className="mb-meta">
            判定依据：{SOURCE_LABEL[h.source] ?? h.source} · 上次检测 {agoText(h.checkedAt)}
            {h.sessionExpiresAt ? ` · 会话到期 ${fmtLocal(h.sessionExpiresAt)}` : ''}
            {h.cookieCount > 0 ? ` · 会话 ${h.cookieCount} 条 cookie` : ''}
            {h.costMs ? ` · 耗时 ${(h.costMs / 1000).toFixed(1)}s` : ''}
            {waitProbe ? ' · 正在检测…' : ''}
            {!data.workerRunning ? ' · 解析进程未运行' : ''}
            <span data-tick={tick} style={{ display: 'none' }} />
          </div>
        </div>

        <div className="mb-actions">
          <Link href="/settings/muse-session">
            <button className="primary" disabled={busy}>
              去扫码登录
            </button>
          </Link>
          <button onClick={() => void recheck()} disabled={busy}>
            {busy ? '检测中…' : '重新检测'}
          </button>
          <button
            onClick={() => {
              const s = data?.health.status ?? '';
              try {
                sessionStorage.setItem(collapseKey(viewerId), s);
              } catch {
                /* 不可用时只是不记忆收起 */
              }
              setCollapsed(s);
            }}
            title="收起后本浏览器不再显示；登录态一旦变化（修好或再次失效）会重新出现"
          >
            收起
          </button>
        </div>
      </div>
    </div>
  );
}
