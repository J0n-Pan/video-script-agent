'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Row = {
  id: string;
  seq: number | null;
  title: string | null;
  fileName: string | null;
  sourceType: string;
  sourceUrl: string | null;
  durationMs: number | null;
  status: string;
  statusLabel: string;
  currentStageLabel: string | null;
  form: string | null;
  manualOverride: boolean;
  aiRatio: number | null;
  ratioEstimated: boolean;
  reviewStatus: string | null;
  reviewStatusLabel: string | null;
  versionNo: number | null;
  currentRevisionId: string | null;
  problemFlags: Array<{ code: string; count: number }>;
  createdAt: string;
  queuePosition: number | null;
  originalPath: string | null;
};

const SELECTED_KEY = 'vsa.selected.videos';

function chipClass(status: string) {
  if (status === 'COMPLETED') return 'chip ok';
  if (status === 'PARTIAL') return 'chip warn';
  if (status === 'FAILED') return 'chip danger';
  if (status === 'UNSUPPORTED') return 'chip info';
  return 'chip';
}

function fmtDuration(ms: number | null) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function TaskListClient() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [review, setReview] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const supplementFor = useRef<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SELECTED_KEY);
      if (raw) setSelected(JSON.parse(raw));
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(SELECTED_KEY, JSON.stringify(selected));
  }, [selected]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      if (review) params.set('review', review);
      const res = await fetch(`/api/tasks?${params.toString()}`, { cache: 'no-store' });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        // 请求失败保留现有列表并支持重试
        setError(j.error ?? '加载失败');
        return;
      }
      setRows(j.data.rows);
      setError('');
    } catch (e) {
      setError(`请求失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [q, status, review]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const selectedRows = useMemo(() => rows.filter((r) => selected.includes(r.id)), [rows, selected]);
  const missingSelected = selected.filter((id) => !rows.some((r) => r.id === id));

  async function act(id: string, action: 'retry' | 'reparse' | 'cancel') {
    const res = await fetch(`/api/videos/${id}/attempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const j = await res.json();
    setNotice(j.ok ? '操作已提交，任务已排到队尾' : `操作失败：${j.error}`);
    load();
  }

  async function del(row: Row) {
    const okConfirm = window.confirm(
      `确认删除任务「${row.title ?? row.fileName ?? '未提供'}」？\n将清理该视频的所有脚本版本、截图与主机视频副本；包含该视频的已生成合并导出文件会同步失效。`,
    );
    if (!okConfirm) return;
    const res = await fetch(`/api/videos/${row.id}`, { method: 'DELETE' });
    const j = await res.json();
    setNotice(j.ok ? `已删除（失效导出文件 ${j.data.invalidatedExports} 个）` : `删除失败：${j.error}`);
    setSelected((s) => s.filter((x) => x !== row.id));
    load();
  }

  function pickSupplement(id: string) {
    supplementFor.current = id;
    fileRef.current?.click();
  }

  async function onSupplementFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    const id = supplementFor.current;
    e.target.value = '';
    if (!f || !id) return;
    const fd = new FormData();
    fd.append('file', f);
    const res = await fetch(`/api/videos/${id}/supplement`, { method: 'POST', body: fd });
    const j = await res.json();
    setNotice(j.ok ? '补传成功，已排到队尾重新解析' : `补传失败：${j.error}`);
    load();
  }

  return (
    <>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onSupplementFile} />

      <div className="toolbar">
        <input
          className="grow"
          placeholder="按标题或文件名搜索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 320 }}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 150 }}>
          <option value="">全部处理状态</option>
          <option value="UPLOADING">上传中</option>
          <option value="QUEUED">排队中</option>
          <option value="PROCESSING">处理中</option>
          <option value="COMPLETED">已完成</option>
          <option value="PARTIAL">部分完成</option>
          <option value="FAILED">失败</option>
          <option value="UNSUPPORTED">暂不支持</option>
          <option value="CANCELLED">已取消</option>
        </select>
        <select value={review} onChange={(e) => setReview(e.target.value)} style={{ width: 130 }}>
          <option value="">全部复核状态</option>
          <option value="NOT_REVIEWED">未复核</option>
          <option value="REVIEWED">已复核</option>
        </select>
        <button onClick={load}>刷新</button>
        {(q || status || review) && (
          <button
            onClick={() => {
              setQ('');
              setStatus('');
              setReview('');
            }}
          >
            清除筛选
          </button>
        )}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 12 }}>
          已选 {selected.length} 条{missingSelected.length ? `（其中 ${missingSelected.length} 条不在当前筛选结果中）` : ''}
        </span>
        <button
          className="primary"
          disabled={selected.length === 0}
          onClick={() => router.push(`/export?ids=${selected.join(',')}`)}
        >
          导出所选
        </button>
        <Link href="/tasks/new">
          <button className="primary">新建任务</button>
        </Link>
      </div>

      {notice && (
        <div className="banner" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}
      {error && <div className="banner danger">{error}（现有列表已保留，可点击「刷新」重试）</div>}

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 34 }}></th>
              <th style={{ width: 60 }}>序号</th>
              <th>标题</th>
              <th style={{ width: 150 }}>原文件名</th>
              <th style={{ width: 62 }}>时长</th>
              <th style={{ width: 82 }}>来源方式</th>
              <th style={{ width: 92 }}>处理状态</th>
              <th style={{ width: 110 }}>当前阶段</th>
              <th style={{ width: 120 }}>形式</th>
              <th style={{ width: 86 }}>复核状态</th>
              <th style={{ width: 150 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={selected.includes(r.id)}
                    onChange={(e) =>
                      setSelected((s) => (e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id)))
                    }
                  />
                </td>
                <td className="mono">{r.seq ?? '—'}</td>
                <td>
                  <Link href={`/tasks/${r.id}`}>{r.title?.trim() || '未提供'}</Link>
                  {r.problemFlags.length > 0 && (
                    <span className="chip warn" style={{ marginLeft: 6 }}>
                      有缺失
                    </span>
                  )}
                  {r.manualOverride && (
                    <span className="chip info" style={{ marginLeft: 6 }}>
                      形式人工覆盖
                    </span>
                  )}
                  <div className="mute2">{r.sourceUrl || (r.sourceType === 'LOCAL' ? '本地文件' : '未提供')}</div>
                </td>
                <td className="mute2">{r.fileName || '—'}</td>
                <td className="mono">{fmtDuration(r.durationMs)}</td>
                <td>
                  <span className="chip">{r.sourceType === 'LOCAL' ? '本地上传' : '腾讯妙思'}</span>
                </td>
                <td>
                  <span className={chipClass(r.status)}>{r.statusLabel}</span>
                </td>
                <td className="mute2">
                  {r.currentStageLabel ?? '—'}
                  {r.queuePosition != null && <div>排队第 {r.queuePosition} 位</div>}
                </td>
                <td className="mute2">
                  {r.form ?? '—'}
                  {r.aiRatio != null && r.ratioEstimated && (
                    <div className="mute2">AI 占比 {(r.aiRatio * 100).toFixed(0)}%</div>
                  )}
                  {r.aiRatio != null && !r.ratioEstimated && <div className="mute2">AI 占比未估计</div>}
                </td>
                <td>
                  {r.reviewStatusLabel ? (
                    <span className={r.reviewStatus === 'REVIEWED' ? 'chip ok' : 'chip'}>{r.reviewStatusLabel}</span>
                  ) : (
                    <span className="mute2">—</span>
                  )}
                  {r.versionNo != null && <div className="mute2">v{r.versionNo}</div>}
                </td>
                <td>
                  <div className="seg-actions">
                    <Link href={`/tasks/${r.id}`}>
                      <button className="small">查看</button>
                    </Link>
                    {r.status === 'QUEUED' && (
                      <button className="small" onClick={() => act(r.id, 'cancel')}>
                        取消排队
                      </button>
                    )}
                    {(r.status === 'FAILED' || r.status === 'PARTIAL') && (
                      <>
                        <button className="small" onClick={() => act(r.id, 'retry')}>
                          重试
                        </button>
                        <button className="small" onClick={() => pickSupplement(r.id)}>
                          补传
                        </button>
                      </>
                    )}
                    {(r.status === 'COMPLETED' || r.status === 'UNSUPPORTED' || r.status === 'PARTIAL') && (
                      <button className="small" onClick={() => act(r.id, 'reparse')}>
                        重新解析
                      </button>
                    )}
                    <button className="small danger" onClick={() => del(r)}>
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={11} style={{ padding: 26, textAlign: 'center' }} className="muted">
                  {q || status || review ? (
                    <>
                      搜索无结果，可
                      <button
                        className="small"
                        style={{ margin: '0 6px' }}
                        onClick={() => {
                          setQ('');
                          setStatus('');
                          setReview('');
                        }}
                      >
                        清除筛选
                      </button>
                    </>
                  ) : (
                    <Link href="/tasks/new">还没有任务，去新建第一个批量任务</Link>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedRows.length > 0 && (
        <div className="mute2" style={{ marginTop: 8 }}>
          本次导出顺序：{selectedRows.map((r) => r.title?.trim() || '未提供').join(' → ')}
        </div>
      )}
    </>
  );
}
