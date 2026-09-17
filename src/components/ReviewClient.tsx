'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FORM_OPTIONS, orderCreativeTags } from '@/lib/constants';

type Segment = {
  id: string;
  orderIndex: number;
  startMs: number;
  endMs: number;
  copyText: string;
  /** 唯一标签：人设 / 痛点 / 干货（解决方案）/ 营销内容（产品介绍）/ 福利 / 其他 */
  tag: string;
  makeup: string;
  emotion: string;
  timeUncertain: boolean;
  problemFlags: string[];
};

/** 原网页板块（人群分析 / 分镜或高光时序 title / 创意标签） */
type Insight = {
  fetched: boolean;
  gender: string[];
  age: string[];
  shotTitles: string[];
  shotTitleSource: 'video_script_summary' | 'click_time_series' | 'none';
  creativeTags: Array<{ key: string; label: string; values: string[] }>;
  note: string;
} | null;

type Detail = {
  id: string;
  seq: number | null;
  title: string | null;
  titleDisplay: string;
  titleSource: string;
  /** 原视频标题：本地导入 = 原文件名；链接导入 = 网页标题 */
  sourceTitle: string | null;
  sourceTitleDisplay: string;
  sourceType: string;
  sourceUrl: string | null;
  fileName: string | null;
  originalPath: string | null;
  durationMs: number | null;
  status: string;
  statusLabel: string;
  currentStage: string | null;
  currentStageLabel: string | null;
  problemFlags: Array<{ code: string; count: number }>;
  classification: {
    category: string;
    categoryLabel: string;
    aiRatio: number;
    aiUnionMs: number;
    ratioEstimated: boolean;
    uncertain: boolean;
    manualOverride: boolean;
    evidence: string;
    modelVersion: string | null;
    overriddenBy: string | null;
    overriddenAt: string | null;
  } | null;
  mediaAvailable: boolean;
  mediaHasAudio: boolean | null;
  attempts: Array<{
    id: string;
    queueSeq: number;
    kind: string;
    status: string;
    stageLabel: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    retryIndex: number;
  }>;
  revisions: Array<{
    id: string;
    versionNo: number;
    isCurrent: boolean;
    reviewStatusLabel: string;
    savedAt: string;
    createdBy: string;
    problems: Array<{ code: string; message: string; severity: string }>;
    segmentCount: number;
  }>;
  current:
    | {
        id: string;
        versionNo: number;
        isCurrent: boolean;
        reviewStatus: string;
        savedAt: string;
        createdBy: string;
        problems: Array<{ code: string; message: string; severity: string; segmentIndex?: number }>;
        /** 「视频分析」栏的画面场景：整条视频一次的概览 */
        sceneOverview: string;
        /** 「脚本文案」栏：音频转写模型输出的整段原文（人工可改） */
        transcriptText: string;
        segments: Segment[];
      }
    | null;
  /** 原网页板块；取不到时为 null，导出按空值处理 */
  insight: Insight;
  cost: { estimatedTotal: number; currency: string; priceVersion: string; usagePending: number; calls: number };
  adapters: { mode: string; audio: string; vision: string; organize: string };
};

/** 标签列，顺序与导出一致；每段只能选一个（「场景」已删除，不再对文案做场景类处理） */
const TAGS = ['人设', '痛点', '干货（解决方案）', '营销内容（产品介绍）', '福利', '其他'];

function sec(ms: number) {
  return Math.round(ms / 100) / 10;
}
function fmt(ms: number) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${base}` : base;
}

export default function ReviewClient({ videoId }: { videoId: string }) {
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  /** 「视频分析」栏的画面场景：整条视频一次的概览，不属于任何段落 */
  const [sceneOverview, setSceneOverview] = useState('');
  /** 「脚本文案」栏：音频转写模型输出的整段原文，可人工修订 */
  const [transcriptText, setTranscriptText] = useState('');
  /** 「任务信息」标题：可人工修改，保存后来源标记为「人工填写」 */
  const [titleInput, setTitleInput] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const caret = useRef<Record<string, number>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  /** 轮询时用它判断「本地有未保存修改」，避免闭包读到旧值 */
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  /**
   * keepEdits=true（轮询用）：只刷新任务状态与尝试进度，
   * 不覆盖段落 / 画面场景 / 脚本文案这些可编辑字段，避免把编导未保存的修改冲掉。
   */
  const load = useCallback(async (opts?: { keepEdits?: boolean }) => {
    const res = await fetch(`/api/videos/${videoId}`, { cache: 'no-store' });
    const j = await res.json();
    if (!j.ok) {
      setError(j.error);
      return;
    }
    setD(j.data as Detail);
    if (opts?.keepEdits && dirtyRef.current) return;
    setSegments(j.data.current?.segments ?? []);
    setSceneOverview(j.data.current?.sceneOverview ?? '');
    setTranscriptText(j.data.current?.transcriptText ?? '');
    setTitleInput(j.data.title ?? '');
    setDirty(false);
    setError('');
  }, [videoId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => {
      // 处理中/排队中时轮询状态；本地有未保存修改时不覆盖可编辑字段
      if (!d || ['QUEUED', 'PROCESSING', 'UPLOADING'].includes(d.status)) load({ keepEdits: true });
    }, 5000);
    return () => clearInterval(t);
  }, [d, load]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const problems = d?.current?.problems ?? [];
  const hardProblems = useMemo(() => problems.filter((p) => p.severity !== 'info'), [problems]);

  function patch(i: number, p: Partial<Segment>) {
    setSegments((s) => s.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
    setDirty(true);
  }

  /** 形式为混剪：妆造 / 画面场景 / 情绪留空，不做重复标注 */
  const isMixedCut = d?.classification?.category === '混剪';

  /** 视频分析里的妆造 / 情绪：取首个非「同上」的完整描述（导出只取这一处） */
  function firstFull(key: 'makeup' | 'emotion') {
    for (const s of segments) {
      const v = (s[key] ?? '').trim();
      if (v && v !== '同上') return v;
    }
    return '';
  }

  /** 统一设置描述字段：整条视频只导出该字段的一处描述，故在视频分析里统一维护 */
  function setAllField(key: 'makeup' | 'emotion', value: string) {
    setSegments((list) => list.map((x) => ({ ...x, [key]: value })));
    setDirty(true);
  }

  function splitAt(i: number) {
    const s = segments[i];
    const pos = caret.current[s.id] ?? Math.floor(s.copyText.length / 2);
    if (pos <= 0 || pos >= s.copyText.length) {
      setNotice('请先把光标放在该段文案中要拆分的位置，再点击「按光标拆分」。');
      return;
    }
    const ratio = pos / s.copyText.length;
    const midMs = Math.round(s.startMs + (s.endMs - s.startMs) * ratio);
    const left: Segment = { ...s, endMs: midMs, copyText: s.copyText.slice(0, pos) };
    const right: Segment = {
      ...s,
      id: `${s.id}_b${Date.now()}`,
      startMs: midMs,
      copyText: s.copyText.slice(pos),
      // 拆分后沿用同一标签，时间无法精确分配时标记待复核
      timeUncertain: true,
      problemFlags: [...s.problemFlags, 'split_needs_review'],
    };
    setSegments((list) => [...list.slice(0, i), left, right, ...list.slice(i + 1)].map((x, idx) => ({ ...x, orderIndex: idx + 1 })));
    setDirty(true);
    setNotice('已拆分。请检查时间与标签归属；无法自动精确分配的字段已标记待复核。');
  }

  function mergeWithNext(i: number) {
    if (i >= segments.length - 1) return;
    const a = segments[i];
    const b = segments[i + 1];
    const merged: Segment = {
      ...a,
      endMs: Math.max(a.endMs, b.endMs),
      copyText: a.copyText + b.copyText,
      // 合并后保留全部原文；标签沿用前一段
      problemFlags: [...a.problemFlags, ...b.problemFlags],
    };
    setSegments((list) =>
      [...list.slice(0, i), merged, ...list.slice(i + 2)].map((x, idx) => ({ ...x, orderIndex: idx + 1 })),
    );
    setDirty(true);
    setNotice(
      a.tag === b.tag
        ? '已合并相邻段落，原文已全部保留。'
        : `已合并相邻段落。两段标签不同（${a.tag} / ${b.tag}），已沿用前一段的「${a.tag}」，请确认。`,
    );
  }

  function addRow() {
    const last = segments[segments.length - 1];
    const start = last ? last.endMs : 0;
    setSegments((list) => [
      ...list,
      {
        id: `new_${Date.now()}`,
        orderIndex: list.length + 1,
        startMs: start,
        endMs: Math.min(d?.durationMs ?? start + 3000, start + 3000),
        copyText: '',
        tag: '其他',
        makeup: '无法辨认',
        emotion: '无法辨认',
        timeUncertain: true,
        problemFlags: ['manual_row'],
      },
    ]);
    setDirty(true);
  }

  function removeRow(i: number) {
    setSegments((list) => list.filter((_, idx) => idx !== i).map((x, idx) => ({ ...x, orderIndex: idx + 1 })));
    setDirty(true);
  }

  async function save() {
    if (!d?.current) return;
    setBusy(true);
    setNotice('');
    try {
      const res = await fetch(`/api/videos/${videoId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseRevisionId: d.current.id,
          sceneOverview,
          transcriptText,
          segments: segments.map((s) => ({
            startMs: s.startMs,
            endMs: s.endMs,
            copyText: s.copyText,
            tag: s.tag,
            makeup: s.makeup,
            emotion: s.emotion,
          })),
        }),
      });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error);
        return;
      }
      setNotice(
        `已保存为 v${j.data.versionNo}（保存时间已更新）。修改已复核内容后状态回到未复核。` +
          (j.data.problems?.length ? ` 校验提示 ${j.data.problems.length} 项，见下方问题列表。` : ''),
      );
      await load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function markReview() {
    if (!d?.current || dirty) return;
    setBusy(true);
    try {
      const needsAck = hardProblems.length > 0;
      if (needsAck) {
        const list = hardProblems.map((p) => `· ${p.message}`).join('\n');
        if (!window.confirm(`当前版本仍存在以下问题标记：\n${list}\n\n确认已知悉并标记为已复核？`)) {
          setBusy(false);
          return;
        }
      }
      const res = await fetch(`/api/videos/${videoId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionId: d.current.id, acknowledgeProblems: needsAck }),
      });
      const j = await res.json();
      setNotice(j.ok ? '已标记为已复核（识别缺失标记仍保留在字段上）' : `操作失败：${j.error}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setForm(category: string) {
    const res = await fetch(`/api/videos/${videoId}/classification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
    const j = await res.json();
    setNotice(j.ok ? `形式已人工纠正为「${category}」。仅修改标签不会自动启动解析，需要点击重新解析。` : `失败：${j.error}`);
    await load();
  }

  async function attempt(action: 'retry' | 'reparse' | 'cancel') {
    if (dirty && !window.confirm('存在未保存修改，重新解析不会包含这些修改。确定继续？')) return;
    const res = await fetch(`/api/videos/${videoId}/attempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const j = await res.json();
    setNotice(j.ok ? '操作已提交，新尝试排到队尾（旧版本保留）' : `失败：${j.error}`);
    await load();
  }

  /** 修改任务标题：人工填写优先，后续重新解析不会被自动获取的标题覆盖 */
  async function saveTitle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/videos/${videoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: titleInput }),
      });
      const j = await res.json();
      setNotice(j.ok ? '标题已保存（来源：人工填写，优先级高于自动获取的标题）' : `标题保存失败：${j.error}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function supplementFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    const res = await fetch(`/api/videos/${videoId}/supplement`, { method: 'POST', body: fd });
    const j = await res.json();
    setNotice(j.ok ? '补传成功，已排到队尾重新解析；原链接与已填信息保留' : `补传失败：${j.error}`);
    await load();
  }

  if (!d) {
    return (
      <div className="wrap">
        {error ? <div className="banner danger">{error}</div> : <div className="muted">加载中…</div>}
      </div>
    );
  }

  const formLabel = d.classification?.categoryLabel ?? '未识别';

  return (
    <>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={supplementFile} />

      <div className="toolbar">
        <Link href="/tasks">
          <button>返回列表</button>
        </Link>
        <span className={`chip ${
          d.status === 'COMPLETED' ? 'ok' : d.status === 'PARTIAL' ? 'warn' : d.status === 'FAILED' ? 'danger' : 'info'
        }`}>{d.statusLabel}</span>
        {d.currentStageLabel && <span className="muted">当前阶段：{d.currentStageLabel}</span>}
        {dirty && <span className="chip warn">有未保存修改</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <button className="primary" onClick={save} disabled={busy || !d.current}>
          {busy ? '处理中…' : '保存'}
        </button>
        <button onClick={markReview} disabled={busy || dirty || !d.current}>
          标记已复核
        </button>
        <button onClick={() => attempt('reparse')}>重新解析</button>
        {(d.status === 'FAILED' || d.status === 'PARTIAL') && (
          <>
            <button onClick={() => attempt('retry')}>重试</button>
            <button onClick={() => fileRef.current?.click()}>本地补传</button>
          </>
        )}
        {d.status === 'QUEUED' && <button onClick={() => attempt('cancel')}>取消排队</button>}
      </div>

      {notice && <div className="banner">{notice}</div>}
      {error && <div className="banner danger">{error}</div>}
      {d.adapters.mode === 'mock' && (
        <div className="banner warn">
          当前 AI 适配器为 <b>Mock</b> 模式：流程、页面与 Excel 导出均真实执行，但文案/妆造/场景/情绪内容是演示值，
          不是真实识别结果。配置 DASHSCOPE_API_KEY 并把 AI_MODE 改为 dashscope 后即为真实调用。
        </div>
      )}
      {d.classification?.manualOverride && (
        <div className="banner">
          形式已由 {d.classification.overriddenBy ?? '人工'} 覆盖为「{formLabel}
          」，覆盖优先于自动判断（原自动判断保留在依据中供追溯）。
        </div>
      )}
      {d.status === 'UNSUPPORTED' && (
        <div className="banner warn">
          自动判断为混剪，已生成「暂不支持解析此视频」提示记录（不生成截图）。若为误判，可在右侧「形式」处纠正后点击「重新解析」，新结果与旧结果分开保存。
        </div>
      )}

      <div className="review-layout">
        <div>
          <div className="card">
            <h2>视频</h2>
            {d.mediaAvailable ? (
              <div className="player-box">
                <video ref={videoRef} src={`/api/videos/${d.id}/media`} controls />
              </div>
            ) : (
              <div className="banner warn">
                主机视频副本不可用（尚未获取成功或被清理）。脚本文字与来源信息仍完整保留。
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="small" onClick={() => attempt('retry')}>
                    重新加载
                  </button>
                  <button className="small" onClick={() => fileRef.current?.click()}>
                    本地补传
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <h2>任务信息</h2>
            <div className="kv">
              <span className="k">标题</span>
              <span>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <input
                    value={titleInput}
                    placeholder="未提供"
                    maxLength={200}
                    style={{ width: 320 }}
                    onChange={(e) => setTitleInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveTitle();
                    }}
                  />
                  <button
                    className="small"
                    onClick={saveTitle}
                    disabled={busy || titleInput.trim() === (d.title ?? '').trim()}
                  >
                    保存标题
                  </button>
                </div>
                <div className="mute2" style={{ marginTop: 4 }}>
                  {d.titleSource === 'MANUAL'
                    ? '来源：人工填写（优先级最高，重新解析不会覆盖）'
                    : d.titleSource === 'FETCHED'
                      ? '来源：自动获取（人工修改后不会被覆盖）'
                      : '来源：未提供（可在此填写，也可由链接自动获取）'}
                  ；清空并保存即回到「未提供」。
                </div>
              </span>
              <span className="k">时长</span>
              <span className="mono">{d.durationMs ? fmt(d.durationMs) : '未提供'}</span>
              <span className="k">来源链接</span>
              <span>
                {d.sourceUrl ? (
                  /^https?:\/\//i.test(d.sourceUrl) ? (
                    <a href={d.sourceUrl} target="_blank" rel="noreferrer">
                      {d.sourceUrl}
                    </a>
                  ) : (
                    d.sourceUrl
                  )
                ) : (
                  '未提供'
                )}
              </span>
              <span className="k">原文件名</span>
              <span>{d.fileName || '未提供'}</span>
              <span className="k">本地原路径</span>
              <span className="mute2">{d.originalPath || '未提供（浏览器无法自动取得，由编导填写）'}</span>
              <span className="k">形式</span>
              <span>
                <select value={d.classification?.category ?? ''} onChange={(e) => setForm(e.target.value)} style={{ width: 190 }}>
                  <option value="">未识别</option>
                  {FORM_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
                {d.classification && (
                  <div className="mute2" style={{ marginTop: 4 }}>
                    {d.classification.ratioEstimated
                      ? `AI 画面区间并集 ${(d.classification.aiRatio * 100).toFixed(1)}%（${fmt(d.classification.aiUnionMs)}）`
                      : '无法可靠估计 AI 占比，未编造精确比例'}
                    <br />
                    依据：{d.classification.evidence}
                  </div>
                )}
              </span>
              <span className="k">处理结果</span>
              <span>
                {d.statusLabel}
                {(d.problemFlags.length > 0 ? '，有缺失' : '') +
                  `；当前版本 v${d.current?.versionNo ?? '—'}`}
              </span>
              <span className="k">复核状态</span>
              <span>
                {d.current?.reviewStatus === 'REVIEWED' ? '已复核' : '未复核'}
                {d.current && <span className="mute2">（保存于 {new Date(d.current.savedAt).toLocaleString()}）</span>}
              </span>
              <span className="k">模型费用</span>
              <span className="mute2">
                估算 {d.cost.estimatedTotal} 元（{d.cost.calls} 次调用，单价版本 {d.cost.priceVersion}）
                {d.cost.usagePending > 0 && `，其中 ${d.cost.usagePending} 次用量缺失，费用待核对`}
              </span>
            </div>
          </div>

          <div className="card">
            <h2>问题标记与识别缺失</h2>
            {problems.length === 0 ? (
              <div className="mute2">当前版本没有记录问题项。</div>
            ) : (
              problems.map((p, i) => (
                <div key={i} className={p.severity === 'error' ? 'banner danger' : p.severity === 'warn' ? 'banner warn' : 'banner'}>
                  {p.message}
                </div>
              ))
            )}
            <div className="mute2" style={{ marginTop: 8 }}>
              「有缺失」属于识别过程记录，与人工复核状态分别保存；点击「标记已复核」不会消除这些问题记录。
            </div>
          </div>

          <div className="card">
            <h2>历史版本与执行尝试</h2>
            <table className="grid">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>来源</th>
                  <th>复核</th>
                  <th>保存时间</th>
                </tr>
              </thead>
              <tbody>
                {d.revisions.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      v{r.versionNo}
                      {r.isCurrent && <span className="chip info" style={{ marginLeft: 6 }}>当前</span>}
                    </td>
                    <td>{r.createdBy === 'AI' ? '自动解析' : '人工编辑'}</td>
                    <td>{r.reviewStatusLabel}</td>
                    <td className="mute2">{new Date(r.savedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details className="raw" style={{ marginTop: 10 }}>
              <summary>执行尝试历史（{d.attempts.length}）</summary>
              <table className="grid" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>队列序号</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th>阶段</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  {d.attempts.map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{a.queueSeq}</td>
                      <td>{a.kind === 'INITIAL' ? '首次' : a.kind === 'RETRY' ? '重试/补传' : '重新解析'}</td>
                      <td>{a.status}</td>
                      <td className="mute2">{a.stageLabel ?? '—'}</td>
                      <td className="mute2">{a.errorMessage ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        </div>

        <div>
          {/* 视频分析：原网页板块 + 妆造/画面场景/情绪 + 形式 + 视频链接，导出时同一行 */}
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>视频分析</h2>
              <span className="spacer" style={{ flex: 1 }} />
              <span className="mute2">
                {isMixedCut ? '混剪：妆造 / 画面场景 / 情绪不标注' : '来自原网页与画面理解'}
              </span>
            </div>
            <table className="grid">
              <tbody>
                <tr>
                  <th style={{ width: 96 }}>原视频标题</th>
                  <td colSpan={3} style={{ wordBreak: 'break-all' }}>
                    {d.sourceTitle?.trim() ? (
                      d.sourceTitle
                    ) : (
                      <span className="mute2">
                        未提供（本地导入取原文件名，链接导入取网页标题；历史记录可能未采集）
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th style={{ width: 96 }}>性别特征</th>
                  <td>{d.insight?.gender?.length ? d.insight.gender.join('、') : <span className="mute2">空</span>}</td>
                  <th style={{ width: 96 }}>年龄特征</th>
                  <td>{d.insight?.age?.length ? d.insight.age.join('、') : <span className="mute2">空</span>}</td>
                </tr>
                <tr>
                  <th>分镜/高光 title</th>
                  <td colSpan={3}>
                    {d.insight?.shotTitles?.length ? (
                      <>
                        {d.insight.shotTitles.join('｜')}
                        <span className="mute2" style={{ marginLeft: 8 }}>
                          （来源：{d.insight.shotTitleSource === 'video_script_summary' ? '视频分镜分析' : '高光时序分析'}）
                        </span>
                      </>
                    ) : (
                      <span className="mute2">空</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>创意标签</th>
                  <td colSpan={3}>
                    {d.insight?.creativeTags?.length ? (
                      <div>
                        {orderCreativeTags(d.insight.creativeTags).map((t) => (
                          <div key={t.key}>
                            {t.label}：{t.values.join('、')}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="mute2">空</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>妆造</th>
                  <td>
                    {isMixedCut ? (
                      <span className="mute2">（混剪留空）</span>
                    ) : (
                      <input
                        value={firstFull('makeup')}
                        placeholder="看不清写「无法辨认」"
                        onChange={(e) => setAllField('makeup', e.target.value)}
                      />
                    )}
                  </td>
                  <th>画面场景</th>
                  <td>
                    {isMixedCut ? (
                      <span className="mute2">（混剪留空）</span>
                    ) : (
                      <input
                        value={sceneOverview}
                        placeholder="整条视频一次的概览：室内外、背景物品、人物位置"
                        onChange={(e) => {
                          setSceneOverview(e.target.value);
                          setDirty(true);
                        }}
                      />
                    )}
                  </td>
                </tr>
                <tr>
                  <th>情绪</th>
                  <td>
                    {isMixedCut ? (
                      <span className="mute2">（混剪留空）</span>
                    ) : (
                      <input
                        value={firstFull('emotion')}
                        placeholder="可观察的语速、语气、表情"
                        onChange={(e) => setAllField('emotion', e.target.value)}
                      />
                    )}
                  </td>
                  <th>形式</th>
                  <td>{formLabel}</td>
                </tr>
                <tr>
                  <th>视频链接</th>
                  <td colSpan={3} style={{ wordBreak: 'break-all' }}>
                    {d.sourceUrl || '未提供'}
                  </td>
                </tr>
                {d.insight && !d.insight.fetched && d.insight.note && (
                  <tr>
                    <th>板块说明</th>
                    <td colSpan={3} className="mute2">
                      {d.insight.note}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* 脚本文案：音频转写模型输出的整段原文，人工可直接修订；随版本一起保存 */}
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>脚本文案</h2>
              <span className="spacer" style={{ flex: 1 }} />
              <span className="mute2">
                共 {transcriptText.length} 字
                {d.current && !d.current.transcriptText ? '（该版本未保存转写原文）' : ''}
              </span>
            </div>
            <textarea
              value={transcriptText}
              rows={6}
              placeholder="音频转写模型输出的整段原文"
              style={{ width: '100%', resize: 'vertical', lineHeight: 1.6 }}
              onChange={(e) => {
                setTranscriptText(e.target.value);
                setDirty(true);
              }}
            />
          </div>

          <div className="card" style={{ padding: 12 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>脚本分段与标签</h2>
              <span className="spacer" style={{ flex: 1 }} />
              <button className="small" onClick={addRow}>
                + 增加段落
              </button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="script">
                <colgroup>
                  <col style={{ width: 96 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 520 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>序号 / 时间</th>
                    <th>标签</th>
                    <th>文案（转写原文，不改字）</th>
                  </tr>
                </thead>
                <tbody>
                  {segments.map((s, i) => (
                    <tr key={s.id}>
                      <td className="a">
                        {s.orderIndex}
                        {'\n'}
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            if (videoRef.current) {
                              videoRef.current.currentTime = s.startMs / 1000;
                              videoRef.current.play().catch(() => undefined);
                            }
                          }}
                        >
                          {fmt(s.startMs)}–{fmt(s.endMs)}
                        </a>
                        {s.timeUncertain && <div className="mute2">时间待复核</div>}
                        <div className="time-input">
                          <input
                            value={sec(s.startMs)}
                            onChange={(e) => patch(i, { startMs: Math.round(Number(e.target.value || 0) * 1000) })}
                            title="开始（秒）"
                          />
                          <span>–</span>
                          <input
                            value={sec(s.endMs)}
                            onChange={(e) => patch(i, { endMs: Math.round(Number(e.target.value || 0) * 1000) })}
                            title="结束（秒）"
                          />
                        </div>
                      </td>
                      <td>
                        <select value={s.tag} onChange={(e) => patch(i, { tag: e.target.value })}>
                          {TAGS.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <textarea
                          value={s.copyText}
                          style={{ minHeight: 92 }}
                          onSelect={(e) => {
                            caret.current[s.id] = (e.target as HTMLTextAreaElement).selectionStart;
                          }}
                          onChange={(e) => patch(i, { copyText: e.target.value })}
                        />
                        <div className="seg-actions">
                          <button className="small" onClick={() => splitAt(i)}>
                            按光标拆分
                          </button>
                          <button className="small" onClick={() => mergeWithNext(i)} disabled={i === segments.length - 1}>
                            与下段合并
                          </button>
                          <button className="small danger" onClick={() => removeRow(i)}>
                            删除本段
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {segments.length === 0 && (
                    <tr>
                      <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 22 }}>
                        还没有脚本内容。任务可能仍在排队或处理中；处理完成后会自动出现。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 导出预览：确认按标签聚合后的实际交付效果（对应「导出信息流素材库」） */}
          <div className="card" style={{ padding: 12, marginTop: 12 }}>
            <h2 style={{ marginTop: 0 }}>导出预览（按标签聚合，只读）</h2>
            <table className="grid">
              <tbody>
                {TAGS.map((t) => {
                  const text = segments
                    .filter((s) => s.tag === t)
                    .sort((a, b) => a.startMs - b.startMs)
                    .map((s) => s.copyText.trim())
                    .filter(Boolean)
                    .join('\n');
                  return (
                    <tr key={t}>
                      <th style={{ width: 170 }}>{t}</th>
                      <td style={{ whiteSpace: 'pre-wrap' }}>
                        {text || <span className="mute2">空</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
