'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prepareScanner, scanPrepared, type BannedHit, type BannedWordEntry } from '@/lib/rewrite/banned';

/**
 * 个性化文案生成与比较编辑页（需求文档 §4.1 / §4.2）。
 *
 * 三条界面上的硬规则：
 * 1. 参考稿列**始终可见**，生成稿与参考稿逐段对照 —— 严格结构是否守住，编导一眼能看出来；
 * 2. 编辑只能改段内表达，段数与顺序在这里就是**只读**的（后端也会再判一次，前端不做唯一防线）；
 * 3. 「选定」只能选已保存的修订；界面上有未保存改动时不允许选定，避免把没保存的内容用于成片（A12）。
 */

/** 当前生效的违禁词表（用于界面实时高亮；没上传时为 configured=false） */
type BannedWords = {
  configured: boolean;
  versionNo: number | null;
  title: string;
  entries: BannedWordEntry[];
};

type RefSeg = {
  orderIndex: number;
  tag: string;
  copyText: string;
  startMs?: number | null;
  endMs?: number | null;
};

type VariantSeg = {
  orderIndex: number;
  sourceSegmentId: string | null;
  tag: string;
  copyText: string;
  factRefs: string[];
};

type Variant = {
  /** 候选稿主键：保存编辑的接口路径参数用的是它，不是 revisionId */
  id: string;
  variantNo: number;
  diffSummary: string;
  blockedReason: string;
  revisionId?: string;
  revisionNo?: number;
  revisionCount?: number;
  charCount: number;
  estimatedDurationMs: number;
  problemFlags: string[];
  segments: VariantSeg[];
};

type Problem = { code: string; message: string; severity: string; variantNo?: number; orderIndex?: number };

/** 数字人任务视图（仅页面用到的字段） */
type AvatarJobView = {
  id: string;
  status: string;
  statusLabel?: string;
  businessName: string;
  vendorJobId: string | null;
  textChars: number;
  /** 提交给平台的完整文案（不再截断成预览） */
  text: string;
  params: { avatarName: string; voiceName: string; language: string; speed: number; volume: number; subtitle: boolean; bgm: boolean };
  errorCode: string | null;
  errorMessage: string | null;
  reconcileNote: string;
  revisionMissing: boolean;
  /** 提交尝试次数：0 表示还没提交过，此时「核对平台记录」没有意义 */
  attemptCount: number;
  submittedAt: string | null;
  /** 当前适配器：mock 不会真的提交到平台 */
  adapter?: {
    mode: string;
    baseUrl: string;
    sessionConfigured: boolean;
    /** auto = 全自动提交；assist = 人工接手（只预填作品名与文案，其余在平台上自己选） */
    submitMode?: string;
    /** 适配器是否支持读平台作品列表 —— 不支持就不显示「绑定平台作品」入口 */
    supportsWorkBinding?: boolean;
  };
  avatarWorkerRunning?: boolean;
  source: { variantNo: number; revisionNo: number } | null;
  asset: {
    fileName: string;
    durationMs: number;
    sizeBytes: number;
    hasAudio: boolean;
    downloadUrl: string;
  } | null;
};

/** 进行中的状态需要轮询；终态不再打扰 */
const AVATAR_ACTIVE = ['QUEUED', 'SUBMITTING', 'VENDOR_RUNNING', 'FETCHING', 'NEEDS_LOGIN'];

/**
 * 平台「我的作品」列表里的一行（只读）。
 *
 * 编导在平台上改了作品名之后，这张列表是唯一能把任务和作品重新对上的线索：
 * 平台作品 ID 不随改名变化。
 */
type AvatarWorkView = {
  vendorJobId?: string;
  name: string;
  status: string;
  submittedAt?: string;
};

/** 允许「绑定平台作品」的任务状态（与服务端 bindAvatarJobWork 的前置校验保持一致） */
const AVATAR_BINDABLE = ['QUEUED', 'NEEDS_LOGIN', 'NEEDS_REVIEW', 'ASSIST_CANCELLED', 'FAILED', 'VENDOR_RUNNING'];

type JobSummary = {
  id: string;
  status: string;
  /** 服务端判定：长时间停在 RUNNING（生成请求被中途打断）——界面如实提示，不干挂 RUNNING */
  stalled?: boolean;
  variantCount: number;
  modelId: string;
  createdAt: string;
  finishedAt: string | null;
  variants: Array<{ variantNo: number; revisionId?: string; revisionNo?: number; revisionCount?: number; charCount: number; selected: boolean }>;
};

type Boot = {
  videoId: string;
  title: string;
  sourceTitle: string;
  durationMs: number | null;
  formLabel: string;
  status: string;
  platform: string;
  platformLabel: string;
  platforms: Array<{ value: string; label: string }>;
  variantCount: number;
  model: string;
  ipProfile: { id: string; versionNo: number; title: string; factCount: number } | null;
  jobs: JobSummary[];
  ready: boolean;
  blockedReason: string;
  preview: {
    sourceRevisionId: string;
    sourceRevisionVersionNo: number;
    ipProfileVersionNo: number;
    transcriptConsistent: boolean;
    transcriptNotice: string;
    insightAvailable: boolean;
    refs: RefSeg[];
  } | null;
};

type JobDetail = {
  id: string;
  status: string;
  stage: string | null;
  platform: string;
  platformLabel: string;
  variantCount: number;
  modelId: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  sourceVideo: { id: string; title: string | null; sourceTitle: string | null; durationMs: number | null } | null;
  sourceMissing: boolean;
  ipProfile: { id: string; versionNo: number; title: string } | null;
  refs: RefSeg[];
  transcriptConsistent: boolean;
  transcriptNotice: string;
  variants: Variant[];
  selection: { id: string; variantId: string; revisionId: string; createdAt: string } | null;
  /** 该任务最近一条数字人任务 id：刷新或重进页面后据此恢复任务卡片（没有则 null） */
  avatarJobId: string | null;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const j = await r.json().catch(() => ({ ok: false, error: '响应不是合法 JSON' }));
  if (!r.ok || !j.ok) throw new Error(j.error ?? `请求失败（${r.status}）`);
  return j.data as T;
}

function newClientKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function fmtTime(ms?: number | null) {
  if (ms == null) return '';
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 估算时长：明确写「秒」，与参考时间码的 mm:ss 形态区分开 */
function fmtEstimate(ms: number) {
  if (!ms || ms <= 0) return '—';
  return `约 ${Math.round(ms / 1000)} 秒`;
}

const SEVERITY_LABEL: Record<string, string> = { error: '错误', warn: '提示', info: '说明' };

/**
 * 段落里的违禁词命中提示（只标记 + 高亮，**不阻断**任何操作）。
 *
 * 为什么给一段只读预览而不是直接在输入框里高亮：正文是 textarea，里面做不了富文本。
 * 折中做法是把"哪里命中了"用切片渲染出来 —— 编导看着预览改上面的输入框。
 *
 * 口径已确认（2026-09-22）：违禁词必然有误报，所以这里只提示，
 * 「保存修改 / 选定本版 / 生成数字人视频」都不受命中影响。
 */
function BannedHitsRow({ text, hits }: { text: string; hits: BannedHit[] }) {
  const words = Array.from(new Set(hits.map((h) => h.word)));
  // 命中的词之间有重叠（如同时命中「最好」与「最好用」）时，区间会套在一起；
  // 按区间的起点顺序、跳过已被覆盖的部分，保证渲染不重复也不丢字。
  const parts: Array<{ t: string; hit: boolean }> = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.end <= cursor) continue;
    const start = Math.max(h.start, cursor);
    if (start > cursor) parts.push({ t: text.slice(cursor, start), hit: false });
    parts.push({ t: text.slice(start, h.end), hit: true });
    cursor = h.end;
  }
  if (cursor < text.length) parts.push({ t: text.slice(cursor), hit: false });

  return (
    <div style={{ fontSize: 12, marginTop: 4 }}>
      <div style={{ color: '#b26a00' }}>
        命中禁用表达：{words.map((w) => (
          <span key={w} className="chip warn" style={{ marginRight: 4 }}>
            {w}
          </span>
        ))}
        <span className="muted">（只提示，不影响保存与选定）</span>
      </div>
      <div className="muted" style={{ marginTop: 2, lineHeight: 1.5 }}>
        {parts.map((p, i) =>
          p.hit ? (
            <mark key={i} style={{ background: 'rgba(255,180,60,0.35)', color: 'inherit', padding: '0 1px' }}>
              {p.t}
            </mark>
          ) : (
            <span key={i}>{p.t}</span>
          ),
        )}
      </div>
    </div>
  );
}

export default function RewriteClient({ videoId }: { videoId: string }) {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [platform, setPlatform] = useState('');
  const [variantCount, setVariantCount] = useState(3);
  /**
   * 生效的违禁词表：拉下来在**浏览器里**逐段重扫。
   *
   * 为什么不在生成时把命中结果写死到稿子上：命中必须按**当前正文**算 ——
   * 编导改掉命中词之后标记要立刻消失。写死的标记做不到这一点（它记的是生成那一刻的正文）。
   * 服务端在生成/重新生成时也会扫一遍并写进问题清单，两处同源（都调 scanBannedWords）。
   */
  const [bannedWords, setBannedWords] = useState<BannedWords | null>(null);

  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'danger'; text: string } | null>(null);

  /** 数字人任务：一次点击一个幂等键，双击不会产生第二次提交 */
  const [avatarJobId, setAvatarJobId] = useState<string | null>(null);
  const [avatarJob, setAvatarJob] = useState<AvatarJobView | null>(null);
  const [avatarKey, setAvatarKey] = useState(newClientKey);
  /** 绑定平台作品：手填的「作品 ID 或作品名」、以及按需拉取的平台最近作品列表 */
  const [bindKey, setBindKey] = useState('');
  const [bindWorks, setBindWorks] = useState<AvatarWorkView[] | null>(null);

  /** 草稿：key = revisionId，值 = 编辑后的分段。只存有改动的版本 */
  const [drafts, setDrafts] = useState<Record<string, VariantSeg[]>>({});
  const [selBusy, setSelBusy] = useState(false);

  /** 幂等键：页面加载生成一次；一次生成成功后换新键，使「再生成一次」是新任务而双击不会重复计费 */
  const [clientKey, setClientKey] = useState(newClientKey);
  const firstLoad = useRef(true);

  const loadBoot = useCallback(async () => {    const b = await api<Boot>(`/api/videos/${videoId}/rewrites`);
    setBoot(b);
    setPlatform(b.platform);
    setVariantCount(b.variantCount);
    if (firstLoad.current) {
      firstLoad.current = false;
      if (b.jobs.length) setJobId(b.jobs[0].id);
    }
    return b;
  }, [videoId]);

  /**
   * 违禁词表单独拉一次：与改写任务无关，只影响界面标记。
   * 取不到时按"没有配置"处理（不阻断页面）—— 高亮属于辅助提示，不该拖垮主流程。
   */
  const loadBannedWords = useCallback(async () => {
    try {
      const r = await api<BannedWords>('/api/banned-words');
      setBannedWords(r);
    } catch {
      setBannedWords({ configured: false, versionNo: null, title: '', entries: [] });
    }
  }, []);

  /**
   * 词表只归一化一次。
   * 编辑时每次按键都会把每个段落重扫一遍；若每段都重新归一化 800 个词，
   * 一次输入就是上万次正则替换 —— 输入会明显发卡。
   */
  const bannedScanner = useMemo(
    () => (bannedWords?.configured && bannedWords.entries.length ? prepareScanner(bannedWords.entries) : null),
    [bannedWords],
  );

  const loadJob = useCallback(async (id: string) => {
    const j = await api<JobDetail>(`/api/rewrites/${id}`);
    setJob(j);
    setDrafts({});
    setProblems([]);
    /**
     * 数字人卡片跟着**任务**走：换任务时先收回，再按服务端给的那条恢复。
     * 这样刷新/重进页面仍能看到任务状态、对账说明与成品，
     * 而不是「点完那一瞬间才有、一刷新就没了」。
     */
    setAvatarJobId(j.avatarJobId ?? null);
    setAvatarJob((prev) => (prev && prev.id === j.avatarJobId ? prev : null));
    return j;
  }, []);

  useEffect(() => {
    loadBoot().catch((e) => setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) }));
    loadBannedWords();
  }, [loadBoot, loadBannedWords]);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return;
    }
    loadJob(jobId).catch((e) => setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) }));
  }, [jobId, loadJob]);

  /** 数字人任务轮询：只在进行中的状态轮询，到终态就停，不无休止打接口 */
  useEffect(() => {
    if (!avatarJobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const j = await api<AvatarJobView>(`/api/avatar-jobs/${avatarJobId}`);
        if (stopped) return;
        setAvatarJob(j);
        if (AVATAR_ACTIVE.includes(j.status)) timer = setTimeout(tick, 5000);
      } catch (e) {
        if (!stopped) setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
      }
    };
    tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [avatarJobId]);

  const dirtyRevisionIds = useMemo(() => new Set(Object.keys(drafts)), [drafts]);

  /** 生成新任务 */
  async function generate() {
    setBusy('generate');
    setMsg(null);
    try {
      const r = await api<{ jobId?: string; variants: Variant[]; problems: Problem[]; model: string; estimatedCost: number | null }>(
        `/api/videos/${videoId}/rewrites`,
        {
          method: 'POST',
          body: JSON.stringify({ platform, variantCount, clientKey }),
        },
      );
      setProblems(r.problems ?? []);
      setClientKey(newClientKey());
      await loadBoot();
      if (r.jobId) {
        setJobId(r.jobId);
        await loadJob(r.jobId);
      }
      const usable = (r.variants ?? []).filter((v) => !v.blockedReason).length;
      setMsg({
        kind: usable === 0 ? 'danger' : usable < variantCount ? 'warn' : 'ok',
        text:
          usable === 0
            ? '生成失败：没有任何版本通过结构校验，请查看问题项'
            : `已生成 ${usable} 个可用版本（模型 ${r.model}${r.estimatedCost == null ? '' : `，约 ¥${r.estimatedCost.toFixed(4)}`}）`,
      });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  /** 重新生成：只重跑指定版本，旧稿保留为历史修订 */
  async function regenerate(variantNos: number[]) {
    if (!job) return;
    if (!confirm(`重新生成${variantNos.length ? `第 ${variantNos.join('、')} 版` : '全部版本'}？\n旧稿会作为历史修订保留，可追溯；本次会产生新的模型费用。`)) return;
    setBusy(`regen-${variantNos.join(',') || 'all'}`);
    setMsg(null);
    try {
      const r = await api<{ variants: Variant[]; problems: Problem[]; regeneratedVariantNos: number[]; estimatedCost: number | null }>(
        `/api/rewrites/${job.id}/regenerate`,
        { method: 'POST', body: JSON.stringify({ variantNos }) },
      );
      setProblems(r.problems ?? []);
      await loadJob(job.id);
      await loadBoot();
      setMsg({
        kind: 'ok',
        text: `已重新生成第 ${r.regeneratedVariantNos.join('、')} 版${r.estimatedCost == null ? '' : `（约 ¥${r.estimatedCost.toFixed(4)}）`}`,
      });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  /**
   * 保存编辑：带基准修订做乐观锁，冲突时不覆盖别人的修改。
   *
   * 路径参数是**候选稿 id**（服务端按 variantId 查候选稿，再比对 currentRevisionId），
   * body 里的 baseRevisionId 才是修订 id —— 两者不能混用（2026-09-21 修）。
   */
  async function saveVariant(v: Variant) {
    const segs = drafts[v.revisionId!];
    // id 为空 = 干跑产物，库里没有这条候选稿，不能保存
    if (!segs || !v.revisionId || !v.id) return;
    setBusy(`save-${v.variantNo}`);
    setMsg(null);
    try {
      const r = await api<{ revisionId: string; revisionNo: number; changedSegments: number[] }>(
        `/api/rewrite-variants/${v.id}/revisions`,
        {
          method: 'POST',
          body: JSON.stringify({
            baseRevisionId: v.revisionId,
            segments: segs.map((s) => ({ orderIndex: s.orderIndex, tag: s.tag, copyText: s.copyText })),
          }),
        },
      );
      await loadJob(job!.id);
      setMsg({ kind: 'ok', text: `已保存为修订 ${r.revisionNo}（改动第 ${r.changedSegments.join('、')} 段）` });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  /** 选定：选定后可作为数字人任务提交依据 */
  async function selectVariant(v: Variant) {
    if (!job || !v.revisionId) return;
    setSelBusy(true);
    setMsg(null);
    try {
      await api(`/api/rewrites/${job.id}/select`, { method: 'POST', body: JSON.stringify({ revisionId: v.revisionId }) });
      await loadJob(job.id);
      await loadBoot();
      setMsg({ kind: 'ok', text: `已选定第 ${v.variantNo} 版（修订 ${v.revisionNo}）` });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSelBusy(false);
    }
  }

  /** 导出：走既有导出接口的 REWRITE 类型，独立文件不影响原两种导出 */
  async function exportVariant(v: Variant) {
    if (!v.revisionId) return;
    setBusy(`export-${v.variantNo}`);
    setMsg(null);
    try {
      const r = await api<{ fileName: string; downloadUrl: string }>('/api/exports', {
        method: 'POST',
        body: JSON.stringify({ kind: 'REWRITE', confirm: true, items: [{ rewriteRevisionId: v.revisionId }] }),
      });
      // 下载走 blob，避免直链在部分浏览器里变成新标签打开
      const res = await fetch(r.downloadUrl);
      if (!res.ok) throw new Error(`下载失败（${res.status}）`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg({ kind: 'ok', text: `已导出：${r.fileName}` });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  /**
   * 提交数字人视频。
   * 只提交**已选定且已保存**的修订（后端也会再判一次）；同一个幂等键双击只创建一个任务。
   */
  async function createAvatar(v: Variant) {
    if (!v.revisionId) return;
    setBusy(`avatar-${v.variantNo}`);
    setMsg(null);
    try {
      const r = await api<{ jobId: string; replayed: boolean; adapter?: { mode: string; submitMode?: string } }>(
        '/api/avatar-jobs',
        {
          method: 'POST',
          body: JSON.stringify({ revisionId: v.revisionId, idempotencyKey: avatarKey }),
        },
      );
      setAvatarKey(newClientKey());
      setAvatarJobId(r.jobId);
      // Mock 适配器不会真的提交到平台，提示语不能说得像已经提交了
      const isMock = r.adapter?.mode === 'mock';
      const isAssist = r.adapter?.submitMode === 'assist';
      setMsg({
        kind: isMock ? 'warn' : 'ok',
        text: r.replayed
          ? '同一次点击已存在提交任务，直接复用（未重复提交）'
          : isMock
            ? '已创建数字人任务（Mock 适配器：只在本地产出桩成品，不会提交到鲲之益）。要真实出片请配置 AVATAR_ADAPTER="playwright" 并启动 npm run worker:avatar。'
            : isAssist
              ? '已创建数字人任务：数字人解析进程会打开平台创建页并预填作品名与文案，请在浏览器窗口里选好形象与各项参数，自己点「生成视频」。完成后回到本页刷新即可。'
              : '已创建数字人任务：后台会提交到平台并等待生成，可离开本页，回来仍能看到进度',
      });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  /** 重新核对平台记录 —— 不重新提交，避免重复计费 */
  async function reconcileAvatar() {
    if (!avatarJobId) return;
    setBusy('reconcile');
    setMsg(null);
    try {
      const r = await api<{ status: string; message: string; notSubmitted?: boolean }>(
        `/api/avatar-jobs/${avatarJobId}/reconcile`,
        { method: 'POST' },
      );
      const j = await api<AvatarJobView>(`/api/avatar-jobs/${avatarJobId}`);
      setAvatarJob(j);
      setMsg({ kind: r.notSubmitted ? 'warn' : 'ok', text: `${r.notSubmitted ? '' : '核对结果：'}${r.message}` });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  /**
   * 拉平台最近作品（真实访问平台读列表）。
   *
   * 为什么要这个入口：作品在平台上被改名之后，我们存着的唯一作品名就再也匹配不上了，
   * 编导只能靠「平台作品 ID」把任务接回去 —— 而 ID 得让他能看见、点得着。
   */
  async function loadPlatformWorks() {
    setBusy('load-works');
    setMsg(null);
    try {
      const r = await api<{ works: AvatarWorkView[] }>('/api/avatar-works?limit=15');
      setBindWorks(r.works);
      if (r.works.length === 0) setMsg({ kind: 'warn', text: '平台作品列表是空的（该账号下还没有作品）。' });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  /** 把平台上的某条作品绑定到当前任务（按平台作品 ID 跟踪，改名不再影响） */
  async function bindWork(ref: { workId?: string; workName?: string }) {
    if (!avatarJobId) return;
    setBusy('bind');
    setMsg(null);
    try {
      const r = await api<{ message: string }>(`/api/avatar-jobs/${avatarJobId}/bind`, {
        method: 'POST',
        body: JSON.stringify(ref),
      });
      const j = await api<AvatarJobView>(`/api/avatar-jobs/${avatarJobId}`);
      setAvatarJob(j);
      setBindKey('');
      setMsg({ kind: 'ok', text: r.message });
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  function updateSeg(revisionId: string, orderIndex: number, copyText: string, base: VariantSeg[]) {    setDrafts((prev) => {
      const cur = prev[revisionId] ?? base.map((s) => ({ ...s }));
      return { ...prev, [revisionId]: cur.map((s) => (s.orderIndex === orderIndex ? { ...s, copyText } : s)) };
    });
  }

  function resetDraft(revisionId: string) {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[revisionId];
      return next;
    });
  }

  if (!boot) {
    return (
      <div className="card" style={{ padding: 16 }}>
        <span className="muted">加载中…</span>
      </div>
    );
  }

  const refs = job?.refs?.length ? job.refs : boot.preview?.refs ?? [];

  /**
   * 「还没提交过」＝ 没有平台作品 ID 且一次提交尝试都没有。
   * 此时核对平台必然查不到，把结论说成「结果待核对」会把人带偏（2026-09-21 的 bug）。
   *
   * ⚠️ 「人工接手已取消」**必须排除**：它同样是「没 ID + attemptCount=0」（取消时特意清零以便重来），
   * 但结论恰好相反 —— 那是**查过平台作品列表之后**确认没提交，再套「尚未提交（排队中）」
   * 那块提示就会让人去查数字人进程为什么不起，而真因是没在平台窗口里点「生成视频」。
   */
  const assistCancelled = avatarJob?.status === 'ASSIST_CANCELLED';
  const neverSubmitted = !!avatarJob && !assistCancelled && !avatarJob.vendorJobId && (avatarJob.attemptCount ?? 0) === 0;
  const mockMode = avatarJob?.adapter?.mode === 'mock';
  const assistMode = avatarJob?.adapter?.submitMode === 'assist';

  /**
   * 「绑定平台作品」入口的显示条件。
   *
   * 只在「还没有平台作品 ID 且当前没有成品」时才显示：已经有 ID 或已经取回成品的任务
   * 根本不需要绑定，摆一个入口在那儿只会让编导以为要重复操作。
   * （服务端还会再判一次状态与归属，界面这层只管别把没用的东西摆出来。）
   */
  const bindable =
    !!avatarJob &&
    !avatarJob.vendorJobId &&
    !avatarJob.asset &&
    AVATAR_BINDABLE.includes(avatarJob.status) &&
    avatarJob.adapter?.supportsWorkBinding !== false;

  return (
    <>
      <div className="row" style={{ marginBottom: 10, alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>个性化文案生成</h2>
        <span className="spacer" style={{ flex: 1 }} />
        <Link href={`/tasks/${videoId}`} style={{ fontSize: 13 }}>
          返回任务详情
        </Link>
      </div>

      {msg && <div className={`banner ${msg.kind}`}>{msg.text}</div>}

      {/* ---------- 生成条件 ---------- */}
      <div className="card" style={{ padding: 12 }}>
        <div className="kv" style={{ marginBottom: 10 }}>
          <div className="k">参考视频</div>
          <div>
            {boot.title?.trim() || boot.sourceTitle?.trim() || '未提供'}
            <span className="muted">（{boot.formLabel}，{boot.durationMs ? `${Math.round(boot.durationMs / 1000)} 秒` : '时长未知'}）</span>
          </div>
        </div>
        <div className="kv">
          <div className="k">IP 资料包</div>
          <div>
            {boot.ipProfile ? (
              <>
                《{boot.ipProfile.title}》 v{boot.ipProfile.versionNo}
                <span className="muted">（{boot.ipProfile.factCount} 条可引用事实）</span>
              </>
            ) : (
              <span className="muted">
                尚未导入资料包 — 没有资料包时无法生成（事实只能来自资料包，不允许编造）。
                <Link href="/settings/ip-profile" style={{ marginLeft: 6 }}>
                  去导入
                </Link>
              </span>
            )}
          </div>
        </div>
        {boot.preview && !boot.preview.transcriptConsistent && (
          <div className="banner warn" style={{ marginTop: 8 }}>
            {boot.preview.transcriptNotice}（本次以分段为准，不会自动改写源数据）
          </div>
        )}

        <div className="kv">
          <div className="k">违禁词资料包</div>
          <div>
            {bannedWords == null ? (
              <span className="muted">加载中…</span>
            ) : bannedWords.configured ? (
              <>
                《{bannedWords.title}》 v{bannedWords.versionNo}
                <span className="muted">（{bannedWords.entries.length} 条禁用表达；生成时作为红线，命中处会在稿件里标出）</span>
              </>
            ) : (
              <span className="muted">
                未启用 — 生成不受禁用表达约束。可选：
                <Link href="/settings/ip-profile" style={{ marginLeft: 6 }}>
                  去上传违禁词资料包
                </Link>
              </span>
            )}
          </div>
        </div>

        <div className="row" style={{ marginTop: 10, gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>平台</label>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {boot.platforms.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>生成版本数</label>
            <input
              type="number"
              min={1}
              max={10}
              value={variantCount}
              onChange={(e) => setVariantCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
              style={{ width: 80 }}
            />
          </div>
          <button className="primary" disabled={!boot.ready || busy === 'generate'} onClick={generate}>
            {busy === 'generate' ? '生成中（可能需要 1~3 分钟）…' : '生成文案'}
          </button>
          {!boot.ready && <span className="muted">暂不可生成：{boot.blockedReason}</span>}
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          生成模型：{boot.model}。
        </div>
      </div>

      {/* ---------- 历史任务 ---------- */}
      {boot.jobs.length > 0 && (
        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>生成任务</h2>
            <span className="spacer" style={{ flex: 1 }} />
            <button className="small" disabled={!!busy} onClick={() => regenerate([])}>
              重新生成全部版本
            </button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="script">
              <thead>
                <tr>
                  <th>创建时间</th>
                  <th>状态</th>
                  <th>平台</th>
                  <th>版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {boot.jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="a">{new Date(j.createdAt).toLocaleString('zh-CN')}</td>
                    <td className="a">
                      {j.stalled ? '已中断' : j.status}
                      {j.status === 'PARTIAL' && <span className="chip warn">部分成功</span>}
                      {j.status === 'FAILED' && <span className="chip danger">失败</span>}
                      {j.stalled && (
                        <span className="chip warn" title="生成请求被中途打断，任务不会自行恢复；重新生成一次即可">
                          可能已中断
                        </span>
                      )}
                    </td>
                    <td className="a">{j.modelId}</td>
                    <td className="a">
                      {j.variants.map((v) => (
                        <span key={v.variantNo} className={`chip ${v.selected ? 'ok' : ''}`} style={{ marginRight: 4 }}>
                          第{v.variantNo}版 {v.charCount}字{v.revisionCount && v.revisionCount > 1 ? ` ·${v.revisionCount}修订` : ''}
                          {v.selected ? ' · 已选定' : ''}
                        </span>
                      ))}
                    </td>
                    <td className="a">
                      <button className="small" onClick={() => setJobId(j.id)} disabled={jobId === j.id}>
                        {jobId === j.id ? '查看中' : '查看'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------- 问题项 ---------- */}
      {problems.length > 0 && (
        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <h2 style={{ marginTop: 0 }}>生成问题项</h2>
          <table className="script">
            <thead>
              <tr>
                <th>级别</th>
                <th>编号</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((p, i) => (
                <tr key={`${p.code}-${i}`}>
                  <td className="a">
                    <span className={`chip ${p.severity === 'error' ? 'danger' : p.severity === 'warn' ? 'warn' : 'info'}`}>
                      {SEVERITY_LABEL[p.severity] ?? p.severity}
                    </span>
                  </td>
                  <td className="a mono">{p.code}</td>
                  <td>{p.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- 逐段对照 ---------- */}
      {job && (
        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0 }}>逐段对照与编辑</h2>
            <span className="muted">
              参考版本 v{boot.preview?.sourceRevisionVersionNo ?? '?'}（{refs.length} 段）
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            {job.selection && <span className="chip ok">已选定稿件</span>}
            {job.sourceMissing && <span className="chip warn">来源视频已删除，稿件仍保留</span>}
          </div>

          <div style={{ display: 'flex', gap: 12, overflowX: 'auto', alignItems: 'flex-start' }}>
            {/* 参考稿列 */}
            {/*
              参考稿列曾用背景 `#f7f9fc`（近白）—— 界面是深色主题（--bg #0d1117 / --text #e6edf3），
              于是这一栏是「浅色卡片 + 浅色文字」，几乎看不清，也和右侧版本列不是一套样式。
              现在统一走 .card 的 --bg-elev，并把正文放进**只读 textarea**，
              与右侧可编辑列同字号、同底色、同边框；只读而不是隐藏，是为了让人一眼看出它不可改。
            */}
            <div style={{ minWidth: 300, flex: '0 0 300px' }}>
              <div className="card" style={{ padding: 10 }}>
                <div className="row" style={{ marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
                  <strong>参考稿（结构基准）</strong>
                  <span className="chip">不可编辑</span>
                </div>
                {refs.map((r) => (
                  <div key={r.orderIndex} style={{ marginBottom: 10 }}>
                    <div className="row" style={{ fontSize: 12, gap: 6 }}>
                      <span className="muted">
                        [{r.orderIndex}] {r.tag}
                      </span>
                      <span className="spacer" style={{ flex: 1 }} />
                      {r.startMs != null && (
                        <span className="muted mono">
                          {fmtTime(r.startMs)}–{fmtTime(r.endMs)}
                        </span>
                      )}
                    </div>
                    <textarea
                      readOnly
                      className="ref-copy"
                      value={r.copyText}
                      rows={Math.max(2, Math.ceil(r.copyText.length / 22))}
                      style={{ width: '100%', fontSize: 13, resize: 'none' }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* 各版本列 */}
            {job.variants.map((v) => {
              const segs = drafts[v.revisionId ?? ''] ?? v.segments;
              const dirty = !!v.revisionId && dirtyRevisionIds.has(v.revisionId);
              const isSelected = !!job.selection && job.selection.revisionId === v.revisionId;
              const curChars = segs.reduce((a, s) => a + s.copyText.replace(/\s+/g, '').length, 0);

              return (
                <div key={v.variantNo} style={{ minWidth: 340, flex: '0 0 340px' }}>
                  <div className="card" style={{ padding: 10 }}>
                    <div className="row" style={{ marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
                      <strong>第 {v.variantNo} 版</strong>
                      {v.revisionNo != null && <span className="chip">修订 {v.revisionNo}</span>}
                      {isSelected && <span className="chip ok">已选定</span>}
                      {dirty && <span className="chip warn">未保存</span>}
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                      {curChars} 字 · 预计口播 {fmtEstimate(v.estimatedDurationMs)}
                      {v.revisionCount && v.revisionCount > 1 ? ` · 共 ${v.revisionCount} 个修订` : ''}
                    </div>
                    {v.diffSummary && <div style={{ fontSize: 12, marginBottom: 8 }}>差异：{v.diffSummary}</div>}

                    {v.blockedReason ? (
                      <div className="banner warn">未生成：{v.blockedReason}</div>
                    ) : (
                      <>
                        {segs.map((s) => {
                          const ref = refs.find((r) => r.orderIndex === s.orderIndex);
                          const len = s.copyText.replace(/\s+/g, '').length;
                          const refLen = ref?.copyText.replace(/\s+/g, '').length ?? 0;
                          const off = refLen >= 8 && (len / refLen > 1.8 || len / refLen < 0.5);
                          // 按**当前输入框里的正文**实时重扫：改掉命中词标记就立刻消失
                          const hits = bannedScanner ? scanPrepared(s.copyText, bannedScanner) : [];
                          return (
                            <div key={s.orderIndex} style={{ marginBottom: 10 }}>
                              <div className="row" style={{ fontSize: 12, gap: 6 }}>
                                <span className="muted">
                                  [{s.orderIndex}] {s.tag}
                                </span>
                                <span className="spacer" style={{ flex: 1 }} />
                                <span className={off ? '' : 'muted'} style={off ? { color: '#b26a00' } : undefined}>
                                  {len} 字{refLen ? ` / 参考 ${refLen}` : ''}
                                </span>
                              </div>
                              <textarea
                                value={s.copyText}
                                rows={Math.max(2, Math.ceil(s.copyText.length / 30))}
                                style={{ width: '100%', fontSize: 13 }}
                                onChange={(e) => v.revisionId && updateSeg(v.revisionId, s.orderIndex, e.target.value, v.segments)}
                              />
                              {hits.length > 0 && <BannedHitsRow text={s.copyText} hits={hits} />}
                            </div>
                          );
                        })}

                        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                          <button
                            className="small primary"
                            disabled={!dirty || busy === `save-${v.variantNo}`}
                            onClick={() => saveVariant(v)}
                          >
                            {busy === `save-${v.variantNo}` ? '保存中…' : '保存修改'}
                          </button>
                          <button className="small" disabled={!dirty} onClick={() => v.revisionId && resetDraft(v.revisionId)}>
                            撤销改动
                          </button>
                          <button className="small" disabled={!!busy} onClick={() => regenerate([v.variantNo])}>
                            重新生成本版
                          </button>
                          <button
                            className="small"
                            disabled={selBusy || dirty || isSelected}
                            title={dirty ? '请先保存修改再选定' : ''}
                            onClick={() => selectVariant(v)}
                          >
                            {isSelected ? '已选定' : '选定本版'}
                          </button>
                          <button className="small" disabled={!!busy} onClick={() => exportVariant(v)}>
                            {busy === `export-${v.variantNo}` ? '导出中…' : '导出本版'}
                          </button>
                          {isSelected && (
                            <button className="small primary" disabled={!!busy} onClick={() => createAvatar(v)}>
                              {busy === `avatar-${v.variantNo}` ? '提交中…' : '生成数字人视频'}
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ---------- 数字人任务 ---------- */}
      {avatarJob && (
        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0 }}>数字人视频任务</h2>
            <span className="chip">{avatarJob.statusLabel ?? avatarJob.status}</span>
            {avatarJob.source && (
              <span className="muted">
                来源：第 {avatarJob.source.variantNo} 版 · 修订 {avatarJob.source.revisionNo}
              </span>
            )}
            {avatarJob.revisionMissing && <span className="chip warn">来源稿件已删除，任务与成品仍保留</span>}
            {mockMode && <span className="chip warn">Mock 适配器（不会提交到平台）</span>}
            {!mockMode && assistMode && <span className="chip">人工接手模式（形象与参数由你选）</span>}
            {avatarJob.adapter && !mockMode && (
              <span className="chip">{avatarJob.adapter.sessionConfigured ? '真实适配器 · 会话已配置' : '真实适配器 · 缺登录会话'}</span>
            )}
            {!avatarJob.avatarWorkerRunning && <span className="chip danger">数字人进程未运行</span>}
            <span className="spacer" style={{ flex: 1 }} />
            <button
              className="small"
              disabled={!!busy || neverSubmitted || assistCancelled}
              title={
                assistCancelled
                  ? '该任务人工接手未提交（已核对过平台作品列表），无需核对'
                  : neverSubmitted
                    ? '该任务还没提交到平台，核对没有意义'
                    : ''
              }
              onClick={reconcileAvatar}
            >
              {busy === 'reconcile' ? '核对中…' : '重新核对平台记录'}
            </button>
          </div>

          {/*
            「提交文本」展示**送给平台的原文全文**（不再截断、不再附「N 字（各段正文按序拼接…）」那行说明）。
            长文用滚动容器承载：内容一字不少，但不会把整张卡片撑成几屏高。
          */}
          <div className="kv">
            <div className="k">提交文本</div>
            <div>
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  fontSize: 13,
                  lineHeight: 1.6,
                  maxHeight: 260,
                  overflowY: 'auto',
                }}
              >
                {avatarJob.text}
              </div>
            </div>
          </div>
          <div className="kv">
            <div className="k">生成参数</div>
            <div>
              形象 {avatarJob.params.avatarName} · 音色 {avatarJob.params.voiceName} · {avatarJob.params.language} · 语速{' '}
              {avatarJob.params.speed} · 音量 {avatarJob.params.volume} · 字幕 {avatarJob.params.subtitle ? '开' : '关'} · 背景音乐{' '}
              {avatarJob.params.bgm ? '开' : '关'}
            </div>
          </div>
          <div className="kv">
            <div className="k">作品名</div>
            <div className="mono" style={{ fontSize: 12 }}>{avatarJob.businessName}</div>
          </div>
          {avatarJob.vendorJobId && (
            <div className="kv">
              <div className="k">平台作品 ID</div>
              <div className="mono" style={{ fontSize: 12 }}>{avatarJob.vendorJobId}</div>
            </div>
          )}

          {avatarJob.reconcileNote && (
            <div className="banner warn">
              {neverSubmitted && !avatarJob.vendorJobId ? '说明：' : '待核对说明：'}
              {avatarJob.reconcileNote}
            </div>
          )}
          {/* 「已取消」有专门的引导横幅，原因也放在那儿，这里不再叠一个红色失败样式 */}
          {avatarJob.errorMessage && !assistCancelled && <div className="banner danger">{avatarJob.errorMessage}</div>}

          {/*
            没提交过就不该显示「提交流程」的提示：这里换成真实状态 ——
            mock 适配器不会提交、以及数字人进程没起就会一直排队。
          */}
          {neverSubmitted && (
            <div className="banner warn">
              该任务<strong>尚未提交到平台</strong>（排队中）。
              {mockMode ? (
                <>
                  当前是 <strong>Mock 适配器</strong>：只在本地产出桩成品，<strong>不会提交到鲲之益</strong>。
                  要真实出片需配置 <span className="mono">AVATAR_ADAPTER=&quot;playwright&quot;</span> 并重启数字人解析进程。
                </>
              ) : !avatarJob.avatarWorkerRunning ? (
                <>
                  数字人解析进程未运行，没人把任务提交给平台：请让维护人员启动工作台
                  （数字人进程已随工作台一起启动，正常双击启动脚本即会包含）。
                </>
              ) : (
                <>数字人解析进程已运行，正在处理，稍后刷新即可。</>
              )}
            </div>
          )}

          {avatarJob.status === 'NEEDS_LOGIN' && (
            <div className="banner warn">
              数字人平台会话已失效：刷新页面后会自动弹出「连接数字人平台」窗口，输入鲲之益的账号和密码即可重新连接
              （任何编导都可以连接，连接一次全团队共用）。不会因为会话失效而重复提交任务。
            </div>
          )}
          {avatarJob.status === 'NEEDS_REVIEW' && !neverSubmitted && (
            <div className="banner warn">
              结果不明：不会自动重新提交（避免重复计费）。请点「重新核对平台记录」按作品名 / 作品 ID 查平台现状。
            </div>
          )}

          {/*
            人工接手模式（AVATAR_SUBMIT_MODE=assist）：
            队列被数字人进程取走后会在**服务器那台机器的桌面上**弹出一个真实浏览器窗口，
            编导要在那儿选形象、选参数、点「生成视频」。本页此刻只能等，说清「去哪点」比转圈有用。
          */}
          {assistMode && (avatarJob.status === 'QUEUED' || avatarJob.status === 'SUBMITTING') && (
            <div className="banner warn">
              人工接手模式：数字人解析进程会打开平台创建页，并<strong>预填作品名与文案</strong>。
              请在弹出的浏览器窗口里选好数字人形象与各项参数，自己点「生成视频」——
              提交前本任务一直停在「提交中」，你点完生成后本页会自动更新。
            </div>
          )}

          {/*
            取消是**确定**结论（按唯一作品名查过平台作品列表，没查到），不是「结果不明」。
            因为取消时已把 submittedAt 清零，这里可以直接重发起 —— 提示语必须给出这条出路，
            否则编导会以为任务卡死了。
          */}
          {assistCancelled && (
            <div className="banner warn">
              人工接手已取消：本次<strong>没有提交到平台</strong>（已核对平台作品列表，确认没有这条作品名），
              因此不会产生任何费用，也无需再核对。
              如需出片，直接在已选定的那一版上重新点<strong>「生成数字人视频」</strong>即可再次发起。
              {avatarJob.errorMessage && (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  取消原因：{avatarJob.errorMessage}
                </div>
              )}
            </div>
          )}

          {/*
            「绑定平台作品」——作品在平台上被改名之后的正规出路（2026-09-22）。
            平台作品 ID 不随改名变化，所以只要把 ID 补给任务，后续查询与取回就能一直对上。
          */}
          {bindable && (
            <div className="banner warn" style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 6 }}>
                <strong>作品名对不上？</strong>{' '}
                平台会给作品名追加 <span className="mono">_序号</span>，也允许整条改名 ——
                一旦改名，按「作品名」就再也找不到那条作品了。而<strong>平台作品 ID 不随改名变化</strong>：
                把平台上的作品 ID（或现在的作品名）绑定到本任务，之后一律按 ID 跟踪。
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  value={bindKey}
                  onChange={(e) => setBindKey(e.target.value)}
                  placeholder="平台作品 ID（如 12857）或当前作品名"
                  style={{ minWidth: 260, flex: 1 }}
                  disabled={!!busy}
                />
                <button
                  className="small primary"
                  disabled={!!busy || !bindKey.trim()}
                  onClick={() => bindWork({ workId: bindKey.trim(), workName: bindKey.trim() })}
                >
                  {busy === 'bind' ? '绑定中…' : '绑定平台作品'}
                </button>
                <button className="small" disabled={!!busy} onClick={loadPlatformWorks}>
                  {busy === 'load-works' ? '读取中…' : bindWorks ? '刷新最近作品' : '从最近作品中点选'}
                </button>
              </div>
              {bindWorks && (
                <div
                  style={{
                    marginTop: 6,
                    maxHeight: 200,
                    overflowY: 'auto',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    background: 'var(--bg)',
                    fontSize: 12,
                  }}
                >
                  {bindWorks.length === 0 && <div className="muted" style={{ padding: '6px 8px' }}>平台作品列表为空。</div>}
                  {bindWorks.map((w) => (
                    <div
                      key={`${w.vendorJobId ?? ''}-${w.name}`}
                      className="row"
                      style={{ gap: 8, padding: '5px 8px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}
                    >
                      <span className="mono" style={{ minWidth: 56 }}>{w.vendorJobId ?? '—'}</span>
                      <span style={{ flex: 1, wordBreak: 'break-all' }}>{w.name}</span>
                      <span className="muted">{w.status}</span>
                      <span className="muted">{w.submittedAt ?? ''}</span>
                      <button
                        className="small"
                        disabled={!!busy}
                        onClick={() => bindWork({ workId: w.vendorJobId, workName: w.name })}
                      >
                        绑定
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {avatarJob.asset ? (
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                {avatarJob.asset.fileName} · {Math.round(avatarJob.asset.durationMs / 1000)} 秒 ·{' '}
                {(avatarJob.asset.sizeBytes / 1024 / 1024).toFixed(1)} MB · {avatarJob.asset.hasAudio ? '含音轨' : '无音轨（异常）'}
              </div>
              <video src={avatarJob.asset.downloadUrl} controls style={{ maxWidth: 420, width: '100%' }} />
              <div className="row" style={{ marginTop: 6 }}>
                <a href={`${avatarJob.asset.downloadUrl}?download=1`} download>
                  <button className="small">下载成品</button>
                </a>
              </div>
            </div>
          ) : assistCancelled ? (
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              本次没有产出成品。重新发起后，平台生成通常需要十几分钟，本页会自动刷新状态。
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              平台生成可能需要十几分钟，本页会自动刷新状态（离开再回来也能继续看到）。
            </div>
          )}
        </div>
      )}

      {!job && boot.jobs.length === 0 && (
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <span className="muted">还没有生成任务。上面的条件确认后点「生成文案」即可。</span>
        </div>
      )}
    </>
  );
}
