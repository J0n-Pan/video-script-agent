'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

type Row = {
  id: string;
  title: string | null;
  fileName: string | null;
  status: string;
  statusLabel: string;
  reviewStatusLabel: string | null;
  versionNo: number | null;
  form: string | null;
  sourceUrl: string | null;
};

type Blocked = { videoId: string; title: string; reason: string };

type ExportKind = 'SCRIPT' | 'LIBRARY';

type DoneResult = { exportId: string; fileName: string; itemCount: number; kind: ExportKind; downloadUrl: string };

type HistoryRow = {
  id: string;
  fileName: string;
  itemCount: number;
  createdAt: string;
  downloadUrl: string;
};

/**
 * 两个导出入口的按钮文案。
 *
 * 2026-09-22 按需求删掉了这里的 `brief` 字段：按钮下方那两行「表头是什么、一行代表什么」的
 * 说明是给实现者看的规格，不是给编导看的操作提示 —— 编导只要知道点哪个按钮、导出的是哪一版文案。
 */
const KIND_TEXT: Record<ExportKind, { button: string }> = {
  SCRIPT: { button: '导出信息流脚本' },
  LIBRARY: { button: '导出信息流素材库' },
};

export default function ExportClient() {
  const sp = useSearchParams();
  const ids = (sp.get('ids') ?? '').split(',').filter(Boolean);
  const [rows, setRows] = useState<Row[]>([]);
  const [order, setOrder] = useState<string[]>(ids);
  const [blocked, setBlocked] = useState<Blocked[]>([]);
  const [stage, setStage] = useState<'idle' | 'validate' | 'done'>('idle');
  const [pendingKind, setPendingKind] = useState<ExportKind | null>(null);
  const [result, setResult] = useState<DoneResult | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState('');
  const [busyKind, setBusyKind] = useState<ExportKind | 'download' | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/tasks', { cache: 'no-store' });
    const j = await res.json();
    if (j.ok) setRows(j.data.rows);
  }, []);

  /** 最近导出记录：即使页面状态丢失，也能从这里重新下载 */
  const loadHistory = useCallback(async () => {
    const res = await fetch('/api/exports', { cache: 'no-store' });
    const j = await res.json();
    if (j.ok) setHistory((j.data.rows ?? []).slice(0, 8));
  }, []);

  useEffect(() => {
    load();
    loadHistory();
  }, [load, loadHistory]);

  const chosen = order.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as Row[];

  function move(id: string, dir: -1 | 1) {
    setOrder((o) => {
      const i = o.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= o.length) return o;
      const c = [...o];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  }

  async function postExport(confirm: boolean, kind: ExportKind) {
    const res = await fetch('/api/exports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: order.map((id) => ({ videoId: id })), confirm, kind }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    return j.data as {
      stage: 'VALIDATE' | 'BLOCKED' | 'DONE';
      blocked?: Blocked[];
      exportId?: string;
      fileName?: string;
      itemCount?: number;
      downloadUrl?: string;
    };
  }

  /** 先校验再导出；有阻塞项时停下等用户明确移除，绝不静默少导出 */
  async function run(kind: ExportKind) {
    setBusyKind(kind);
    setError('');
    setResult(null);
    try {
      const v = await postExport(false, kind);
      if (v.stage !== 'VALIDATE') throw new Error(`校验阶段返回异常（stage=${v.stage}）`);
      setBlocked(v.blocked ?? []);
      setStage('validate');
      if ((v.blocked ?? []).length > 0) {
        setPendingKind(kind);
        return;
      }
      await create(kind);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKind(null);
    }
  }

  async function create(kind: ExportKind) {
    const r = await postExport(true, kind);
    if (r.stage === 'BLOCKED') {
      setBlocked(r.blocked ?? []);
      setPendingKind(kind);
      return;
    }
    // 只有 DONE 才代表文件已生成；其它 stage 一律当作失败，避免拼出 undefined 的下载地址
    if (r.stage !== 'DONE' || !r.exportId || !r.downloadUrl) {
      throw new Error(`服务端未返回导出结果（stage=${r.stage}），请重试`);
    }
    setResult({
      exportId: r.exportId,
      fileName: r.fileName ?? '',
      itemCount: r.itemCount ?? 0,
      kind,
      downloadUrl: r.downloadUrl,
    });
    setStage('done');
    setPendingKind(null);
    void loadHistory();
  }

  /** 下载走 fetch，失败时把服务端原因显示在页面上，而不是把浏览器导航到一段 JSON */
  async function download(url: string, fileName?: string) {
    setBusyKind('download');
    setError('');
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? `下载失败（HTTP ${res.status}）`);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName || 'export.xlsx';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      // 锚点不能立刻移除：部分浏览器会把「点击后马上移除」当成取消下载
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(a.href);
      }, 5000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <>
      <div className="card">
        <h2>导出确认</h2>
        <div className="mute2" style={{ marginBottom: 12 }}>
          注意：此处导出的是原视频文案！如需导出改写文案，请在改写文案下方点击「导出本版」。
        </div>

        {chosen.length === 0 ? (
          <div className="banner warn">
            未选择任何视频。请返回<Link href="/tasks"> 任务列表 </Link>勾选后再导出。
          </div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 48 }}>顺序</th>
                <th>标题</th>
                <th style={{ width: 150 }}>原文件名</th>
                <th style={{ width: 90 }}>状态</th>
                <th style={{ width: 90 }}>复核</th>
                <th style={{ width: 70 }}>版本</th>
                <th style={{ width: 130 }}>调整</th>
              </tr>
            </thead>
            <tbody>
              {order.map((id, i) => {
                const r = rows.find((x) => x.id === id);
                return (
                  <tr key={id}>
                    <td className="mono">{i + 1}</td>
                    <td>{r ? r.title?.trim() || '未提供' : `（已不在当前列表：${id.slice(0, 8)}…）`}</td>
                    <td className="mute2">{r?.fileName ?? '—'}</td>
                    <td>{r?.statusLabel ?? '—'}</td>
                    <td>{r?.reviewStatusLabel ?? '—'}</td>
                    <td className="mono">{r?.versionNo != null ? `v${r.versionNo}` : '—'}</td>
                    <td>
                      <div className="seg-actions">
                        <button className="small" onClick={() => move(id, -1)} disabled={i === 0}>
                          上移
                        </button>
                        <button className="small" onClick={() => move(id, 1)} disabled={i === order.length - 1}>
                          下移
                        </button>
                        <button
                          className="small danger"
                          onClick={() => setOrder((o) => o.filter((x) => x !== id))}
                        >
                          移除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 16 }}>
          <div className="row">
            {(Object.keys(KIND_TEXT) as ExportKind[]).map((k) => (
              <button
                key={k}
                className="primary"
                onClick={() => run(k)}
                disabled={busyKind !== null || chosen.length === 0}
              >
                {busyKind === k ? '处理中…' : KIND_TEXT[k].button}
              </button>
            ))}
            <Link href="/tasks">
              <button>返回任务列表</button>
            </Link>
          </div>
        </div>
      </div>

      {stage !== 'idle' && blocked.length > 0 && (
        <div className="card">
          <h2>不可导出的项（需明确移除后继续）</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>标题</th>
                <th>原因</th>
                <th style={{ width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {blocked.map((b, i) => (
                <tr key={i}>
                  <td>{b.title || '（未知）'}</td>
                  <td className="mute2">{b.reason}</td>
                  <td>
                    <button className="small" onClick={() => setOrder((o) => o.filter((x) => x !== b.videoId))}>
                      移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="primary"
              disabled={busyKind !== null}
              onClick={() => {
                setBlocked([]);
                if (pendingKind) create(pendingKind).catch((e) => setError((e as Error).message));
              }}
            >
              已知悉，移除后继续导出
            </button>
            <span className="mute2">
              将继续导出：{pendingKind ? KIND_TEXT[pendingKind].button.replace('导出', '') : '—'}
            </span>
          </div>
        </div>
      )}

      {result && (
        <div className="card">
          <h2>导出完成</h2>
          <div className="banner ok">
            已生成 {result.fileName}（{KIND_TEXT[result.kind].button.replace('导出', '')}），包含 {result.itemCount} 个工作表
            （一个视频一个工作表）。
          </div>
          <div className="row">
            <button
              className="primary"
              onClick={() => download(result.downloadUrl, result.fileName)}
              disabled={busyKind !== null}
            >
              {busyKind === 'download' ? '下载中…' : '下载 Excel'}
            </button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="card">
          <h2>最近导出</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>文件名</th>
                <th style={{ width: 90 }}>工作表数</th>
                <th style={{ width: 170 }}>生成时间</th>
                <th style={{ width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="mono">{h.fileName}</td>
                  <td className="mono">{h.itemCount}</td>
                  <td className="mute2">{new Date(h.createdAt).toLocaleString()}</td>
                  <td>
                    <button
                      className="small"
                      onClick={() => download(h.downloadUrl, h.fileName)}
                      disabled={busyKind !== null}
                    >
                      下载
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <div className="banner danger">{error}</div>}
    </>
  );
}
