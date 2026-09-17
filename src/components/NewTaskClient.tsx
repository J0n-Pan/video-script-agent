'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Mode = 'LOCAL' | 'TENCENT_MUSE';

type RowDraft = {
  key: string;
  mode: Mode;
  file: File | null;
  linkText: string;
  title: string;
  originalPath: string;
};

let seq = 0;
function newRow(mode: Mode = 'LOCAL'): RowDraft {
  seq += 1;
  return { key: `r${Date.now()}_${seq}`, mode, file: null, linkText: '', title: '', originalPath: '' };
}

export default function NewTaskClient() {
  const router = useRouter();
  const [rows, setRows] = useState<RowDraft[]>([newRow()]);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  // 同一次提交的幂等标识：重复点击不创建重复任务；提交成功后重新生成，主动再次提交可新建
  const clientKey = useRef<string>(crypto.randomUUID());

  function update(key: string, patch: Partial<RowDraft>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function move(key: string, dir: -1 | 1) {
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const copy = [...rs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  /** 整段粘贴腾讯链接：一行一条，来源入口相同不等于视频内容不同 */
  function pasteLinks(text: string) {
    const links = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (links.length === 0) return;
    setRows((rs) => [...rs, ...links.map((l) => ({ ...newRow('TENCENT_MUSE'), linkText: l }))]);
  }

  async function submit() {
    setBusy(true);
    setError('');
    const logs: string[] = [];
    try {
      const payloadRows: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        if (r.mode === 'LOCAL') {
          if (!r.file) {
            logs.push(`跳过一行：未选择本地文件（${r.title || '未填写标题'}）`);
            continue;
          }
          const fd = new FormData();
          fd.append('file', r.file);
          const up = await fetch('/api/uploads', { method: 'POST', body: fd });
          const uj = await up.json();
          if (!uj.ok) {
            throw new Error(`上传「${r.file.name}」失败：${uj.error}`);
          }
          logs.push(`已完整保存到主机：${uj.data.fileName}（${(uj.data.sizeBytes / 1024 / 1024).toFixed(1)}MB）`);
          payloadRows.push({
            clientRowKey: r.key,
            sourceType: 'LOCAL',
            stageId: uj.data.stageId,
            fileName: uj.data.fileName,
            title: r.title,
            originalPath: r.originalPath,
          });
        } else {
          if (!r.linkText.trim()) {
            logs.push('跳过一行：未填写素材链接');
            continue;
          }
          payloadRows.push({
            clientRowKey: r.key,
            sourceType: 'TENCENT_MUSE',
            sourceUrl: r.linkText.trim(),
            title: r.title,
          });
        }
      }

      if (payloadRows.length === 0) throw new Error('没有可提交的行');

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: clientKey.current, rows: payloadRows }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      const okCount = j.data.results.filter((x: { ok: boolean }) => x.ok).length;
      const failCount = j.data.results.length - okCount;
      logs.push(`提交完成：成功 ${okCount} 条${j.data.duplicated ? '（识别为同一次重复提交，未重复创建）' : ''}`);
      if (failCount > 0) {
        logs.push('未通过校验的行（不占解析槽位）：');
        j.data.results
          .filter((x: { ok: boolean }) => !x.ok)
          .forEach((x: { clientRowKey: string; error: string }) => {
            const row = rows.find((r) => r.key === x.clientRowKey);
            logs.push(`· ${row?.title || row?.file?.name || row?.linkText || x.clientRowKey}：${x.error}`);
          });
      }
      setLog(logs);
      if (okCount > 0) {
        clientKey.current = crypto.randomUUID();
        setTimeout(() => router.push('/tasks'), 900);
      }
    } catch (e) {
      setError((e as Error).message);
      setLog(logs);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <h2>批量清单</h2>
        <div className="mute2" style={{ marginBottom: 12 }}>
          每行是一条视频，可在提交前移除和调整顺序。标题、来源链接、本地原文件路径均为选填；缺失会显示「未提供」。
          浏览器无法自动获取本地文件的绝对路径，如需要请手工填写。
        </div>

        <div className="row" style={{ marginBottom: 12 }}>
          <button onClick={() => setRows((rs) => [...rs, newRow('LOCAL')])}>+ 添加本地视频行</button>
          <button onClick={() => setRows((rs) => [...rs, newRow('TENCENT_MUSE')])}>+ 添加腾讯素材链接行</button>
          <span className="grow" />
          <textarea
            placeholder="批量粘贴腾讯妙思单条素材链接，每行一条，粘贴后自动追加为链接行"
            style={{ maxWidth: 420, minHeight: 38 }}
            onPaste={(e) => {
              const t = e.clipboardData.getData('text');
              if (t.includes('\n')) {
                e.preventDefault();
                pasteLinks(t);
              }
            }}
          />
        </div>

        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 44 }}>#</th>
              <th style={{ width: 120 }}>来源</th>
              <th style={{ width: 260 }}>视频文件 / 素材链接</th>
              <th style={{ width: 200 }}>视频标题（选填）</th>
              <th>本地原文件路径（选填）</th>
              <th style={{ width: 132 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key}>
                <td className="mono">{i + 1}</td>
                <td>
                  <select
                    value={r.mode}
                    onChange={(e) =>
                      update(r.key, { mode: e.target.value as Mode, file: null, linkText: '' })
                    }
                  >
                    <option value="LOCAL">本地视频</option>
                    <option value="TENCENT_MUSE">腾讯素材链接</option>
                  </select>
                </td>
                <td>
                  {r.mode === 'LOCAL' ? (
                    <input
                      type="file"
                      accept="video/*,audio/*"
                      onChange={(e) => update(r.key, { file: e.target.files?.[0] ?? null })}
                    />
                  ) : (
                    <input
                      placeholder="https://admuse.qq.com/#/idea?...&id=..."
                      value={r.linkText}
                      onChange={(e) => update(r.key, { linkText: e.target.value })}
                    />
                  )}
                </td>
                <td>
                  <input value={r.title} onChange={(e) => update(r.key, { title: e.target.value })} placeholder="未提供" />
                </td>
                <td>
                  <input
                    value={r.originalPath}
                    onChange={(e) => update(r.key, { originalPath: e.target.value })}
                    placeholder="例如 D:\素材\xxx.mp4（缺失为未提供）"
                  />
                </td>
                <td>
                  <div className="seg-actions">
                    <button className="small" onClick={() => move(r.key, -1)} disabled={i === 0}>
                      上移
                    </button>
                    <button className="small" onClick={() => move(r.key, 1)} disabled={i === rows.length - 1}>
                      下移
                    </button>
                    <button
                      className="small danger"
                      onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : rs))}
                    >
                      移除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? '提交中…' : '提交并进入队列'}
          </button>
          <Link href="/tasks">
            <button>返回任务列表</button>
          </Link>
          <span className="mute2">
            所有账号共用一条持久化串行队列，全局同时最多解析一条视频；关闭网页不会取消已提交任务。
          </span>
        </div>
      </div>

      {error && <div className="banner danger">{error}</div>}
      {log.length > 0 && (
        <div className="card">
          <h2>提交明细</h2>
          {log.map((l, i) => (
            <div key={i} className="mute2" style={{ fontSize: 12.5 }}>
              {l}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
