'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 资料包管理（需求文档 §6；2026-09-22 第七轮扩为两类共用）。
 *
 * 两类资料（IP 事实 / 违禁词）的**版本管理逻辑完全相同**，所以共用一个组件：
 * 换文档 = 新增版本、不覆盖历史、同内容重复导入被拒、历史版本可重新置为生效。
 * 差别只在文案与"内容是什么"：
 * - IP 资料包：改写稿的**唯一事实来源**（可以说什么），走模型结构化；
 * - 违禁词资料包：改写稿中**绝对不能出现**的词/表达（不许说什么），纯本地解析。
 *
 * 违禁词资料包多一个「解析预览」按钮：解析方向（哪个是分类、哪个是词条）
 * 需要编导肉眼核对一遍再落库，预览不落库、不花钱。
 *
 * 关键约定：**换文档 = 新增版本，不覆盖历史**。
 * 已生成的稿件按其任务快照锁定的版本取事实，所以补一份新资料不会回头改动任何旧稿（A11）；
 * 同样地，把某个历史版本重新置为生效，也只改「接下来生成用哪一版」，不动已有稿件。
 */

type Section = { key: string; label: string };

type Row = {
  id: string;
  versionNo: number;
  title: string;
  status: string;
  sourceFileName: string | null;
  note: string;
  createdAt: string;
  factCount: number;
  entryCount: number;
  sectionCounts: Record<string, number>;
};

type PreviewSample = { text: string; category: string };

type Preview = {
  entryCount: number;
  categoryCounts?: Record<string, number>;
  parseWarnings?: string[];
  sample?: PreviewSample[];
};

export type ProfilePackKind = 'IP' | 'BANNED';

type Props = {
  kind: ProfilePackKind;
  /** 块标题（页面上是「IP 资料包」/「违禁词资料包」） */
  heading: string;
  /** 用途说明（写清这一类资料在改写里扮演什么角色） */
  intro: React.ReactNode;
  /** 导入按钮下方的一句补充说明 */
  hint?: React.ReactNode;
};

export default function ProfilePackClient({ kind, heading, intro, hint }: Props) {
  const isBanned = kind === 'BANNED';
  const [sections, setSections] = useState<Section[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/ip-profiles?kind=${kind}`);
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error ?? '加载失败');
    setSections(j.data.sections ?? []);
    setRows(j.data.rows ?? []);
  }, [kind]);

  useEffect(() => {
    load()
      .catch((e) => setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setLoading(false));
  }, [load]);

  function pickedFile(): File | null {
    const f = fileRef.current?.files?.[0];
    if (!f) {
      setMsg({ kind: 'warn', text: '请先选择资料文件（.docx 推荐，也支持 .txt / .md）' });
      return null;
    }
    return f;
  }

  /** 解析预览（仅违禁词资料包有：不落库、不花钱，只为了先看清解析出的分类与词条） */
  async function runPreview(e: React.FormEvent) {
    e.preventDefault();
    const f = pickedFile();
    if (!f) return;
    setBusy('preview');
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('kind', kind);
      fd.append('preview', '1');
      const r = await fetch('/api/ip-profiles', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? '解析失败');
      const d = j.data as Preview;
      setPreview(d);
      setMsg({
        kind: d.entryCount > 0 ? 'ok' : 'warn',
        text: `解析出 ${d.entryCount} 条词条。下面列的是前 ${d.sample?.length ?? 0} 条，请核对分类与词条有没有被认反；确认无误再导入。`,
      });
    } catch (e2) {
      setMsg({ kind: 'danger', text: e2 instanceof Error ? e2.message : String(e2) });
    } finally {
      setBusy('');
    }
  }

  /** 导入新版本：换文档就走这里，历史版本保留 */
  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const f = pickedFile();
    if (!f) return;
    const cost = isBanned ? '本地解析，不调模型、不产生费用' : '会调用模型整理资料（约 30~60 秒），并产生一次模型费用';
    if (!confirm(`导入《${f.name}》为${heading}新版本？\n${cost}；现有版本会保留为历史版本。`)) return;

    setBusy('upload');
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('kind', kind);
      if (title.trim()) fd.append('title', title.trim());
      if (note.trim()) fd.append('note', note.trim());

      const r = await fetch('/api/ip-profiles', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? '导入失败');
      const d = j.data as { versionNo: number; factCount?: number; entryCount?: number };
      setMsg({
        kind: 'ok',
        text:
          `已导入${heading} v${d.versionNo}，共 ${isBanned ? `${d.entryCount ?? 0} 条词条` : `${d.factCount ?? 0} 条可引用事实`}。` +
          '已生成的历史稿件不受影响。',
      });
      if (fileRef.current) fileRef.current.value = '';
      setTitle('');
      setNote('');
      setPreview(null);
      await load();
    } catch (e2) {
      setMsg({ kind: 'danger', text: e2 instanceof Error ? e2.message : String(e2) });
    } finally {
      setBusy('');
    }
  }

  /** 把历史版本重新置为生效（换回旧版 / 回滚） */
  async function activate(id: string, versionNo: number) {
    if (!confirm(`把 v${versionNo} 重新设为生效版本？\n之后的生成会用这一版资料；已生成的稿件不变（各自锁定导入时的版本）。`)) return;
    setBusy(`activate-${id}`);
    setMsg(null);
    try {
      const r = await fetch(`/api/ip-profiles/${id}/activate`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? '操作失败');
      setMsg({ kind: 'ok', text: `v${versionNo} 已设为生效版本` });
      await load();
    } catch (e) {
      setMsg({ kind: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card" style={{ padding: 12 }}>
      <h2 style={{ marginTop: 0 }}>{heading}</h2>
      {msg && <div className={`banner ${msg.kind}`}>{msg.text}</div>}

      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{intro}</div>

      <form onSubmit={upload}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>资料文件</label>
            <input ref={fileRef} type="file" accept=".docx,.dotx,.txt,.md,.markdown" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>版本标题（选填）</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isBanned ? '例如：广告法禁用语 + 平台敏感词' : '例如：李威老师 9.20 直播话术'}
              style={{ width: 240 }}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>备注（选填）</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={isBanned ? '例如：新增直播违规词 12 条' : '例如：补充了秋季班权益'}
              style={{ width: 220 }}
            />
          </div>
          {isBanned && (
            <button type="button" onClick={runPreview} disabled={busy !== ''}>
              {busy === 'preview' ? '解析中…' : '解析预览（不落库）'}
            </button>
          )}
          <button className="primary" type="submit" disabled={busy !== ''}>
            {busy === 'upload'
              ? isBanned
                ? '导入中…'
                : '整理中（约 30~60 秒）…'
              : '导入为新版本'}
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          支持 .docx（推荐）、.txt、.md；老式 .doc / .wps 请先用 WPS 或 Word 另存为 .docx。
          同一份文件重复导入会被拒绝（内容完全相同没有必要再建一版）。
          {hint}
        </div>
      </form>

      {preview && <PreviewBox preview={preview} />}

      <div style={{ marginTop: 12 }}>
        <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>版本历史</h3>
        {loading ? (
          <span className="muted">加载中…</span>
        ) : rows.length === 0 ? (
          <span className="muted">还没有版本。上面导入第一份文档即可。</span>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="script">
              <colgroup>
                <col style={{ width: 70 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 240 }} />
                <col style={{ width: 180 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 260 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>版本</th>
                  <th>状态</th>
                  <th>标题</th>
                  <th>来源文件</th>
                  <th>{isBanned ? '词条数' : '事实数'}</th>
                  <th>导入时间</th>
                  <th>{isBanned ? '分类明细' : '板块明细'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="a">v{r.versionNo}</td>
                    <td className="a">
                      {r.status === 'ACTIVE' ? <span className="chip ok">生效中</span> : <span className="chip">历史版本</span>}
                    </td>
                    <td>
                      {r.title}
                      {r.note && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {r.note}
                        </div>
                      )}
                      {r.status !== 'ACTIVE' && (
                        <button
                          className="small"
                          style={{ marginTop: 4 }}
                          disabled={!!busy}
                          onClick={() => activate(r.id, r.versionNo)}
                        >
                          {busy === `activate-${r.id}` ? '切换中…' : '设为生效版本'}
                        </button>
                      )}
                    </td>
                    <td className="a" style={{ fontSize: 12 }}>
                      {r.sourceFileName ?? '—'}
                    </td>
                    <td className="a">{isBanned ? r.entryCount : r.factCount}</td>
                    <td className="a" style={{ fontSize: 12 }}>
                      {new Date(r.createdAt).toLocaleString('zh-CN')}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {isBanned
                        ? Object.entries(r.sectionCounts)
                            .map(([c, n]) => `${c} ${n}`)
                            .join(' / ') || '—'
                        : sections.map((s) => `${s.label} ${r.sectionCounts[s.label] ?? 0}`).join(' / ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** 解析预览结果：把"程序是怎么读这份文档的"直接摊开给编导看 */
function PreviewBox({ preview }: { preview: Preview }) {
  return (
    <div className="card" style={{ padding: 10, marginTop: 10, background: 'rgba(255,255,255,0.03)' }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        解析预览（未落库）：共 {preview.entryCount} 条词条
        {preview.categoryCounts
          ? `，分类：${Object.entries(preview.categoryCounts)
              .map(([c, n]) => `${c}(${n})`)
              .join('、')}`
          : ''}
      </div>
      {preview.parseWarnings && preview.parseWarnings.length > 0 && (
        <div className="banner warn" style={{ fontSize: 12 }}>
          {preview.parseWarnings.join(' ')}
        </div>
      )}
      {preview.sample && preview.sample.length > 0 && (
        <div style={{ fontSize: 12, maxHeight: 180, overflowY: 'auto' }}>
          {preview.sample.map((s, i) => (
            <div key={i}>
              <span className="chip">{s.category}</span> <span className="mono">{s.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
