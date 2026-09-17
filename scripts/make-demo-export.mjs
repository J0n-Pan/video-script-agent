/**
 * 生成一份演示导出文件：提交两条自备测试素材 → 等待串行解析 → 标记复核 → 导出为同一个 .xlsx（两个工作表）。
 * 用法：node scripts/make-demo-export.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { creds } from './_credentials.mjs';

const BASE = 'http://127.0.0.1:3939';
const jar = new Map();
const ch = () => Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

async function api(p, init = {}) {
  const res = await fetch(BASE + p, { ...init, headers: { ...(init.headers ?? {}), cookie: ch() } });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return res;
}
const json = async (p, init) => (await api(p, init)).json();

await json('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(creds.editor),
});

const samples = [
  { file: 'data/samples/sample_talk_60s.mp4', title: '演示素材：1 分钟真人讲述（自备测试素材）', note: '课堂记忆方法三步法' },
  { file: 'data/samples/sample_talk_12s.mp4', title: '演示素材：12 秒短片（自备测试素材）', note: '' },
];

const rows = [];
for (const [i, s] of samples.entries()) {
  const p = path.resolve(process.cwd(), s.file);
  if (!fs.existsSync(p)) throw new Error(`缺少测试素材 ${p}，请先运行 npm run make:test-media`);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(p)]), path.basename(p));
  const up = await json('/api/uploads', { method: 'POST', body: fd });
  rows.push({
    clientRowKey: `d${i}`,
    sourceType: 'LOCAL',
    stageId: up.data.stageId,
    fileName: path.basename(p),
    title: s.title,
    originalPath: `D:\\视频号素材\\${path.basename(p)}`,
  });
}

const sub = await json('/api/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ clientKey: `demo-${Date.now()}`, rows }),
});
const ids = sub.data.results.filter((r) => r.ok).map((r) => r.videoId);
console.log(`已提交 ${ids.length} 条，等待串行解析（全局同时只解析一条）…`);

for (const id of ids) {
  for (let i = 0; i < 240; i += 1) {
    const d = (await json(`/api/videos/${id}`)).data;
    if (d && !['QUEUED', 'PROCESSING', 'UPLOADING'].includes(d.status)) {
      console.log(`  ${d.titleDisplay}: ${d.statusLabel}，版本 v${d.current?.versionNo}，${d.current?.segments?.length ?? 0} 段，形式=${d.classification?.categoryLabel}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// 标记复核（存在问题标记时明确确认）
for (const id of ids) {
  const d = (await json(`/api/videos/${id}`)).data;
  if (!d?.current) continue;
  const r = await json(`/api/videos/${id}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revisionId: d.current.id, acknowledgeProblems: true }),
  });
  console.log(`  标记复核 ${d.titleDisplay}: ${r.ok ? '成功' : r.error}`);
}

const exp = await json('/api/exports', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items: ids.map((videoId) => ({ videoId })), confirm: true }),
});
if (exp.data?.stage !== 'DONE') throw new Error(`导出失败：${JSON.stringify(exp)}`);
console.log(`\n导出完成：${exp.data.fileName}（${exp.data.itemCount} 个工作表）`);
console.log(`下载地址：${BASE}/api/exports/${exp.data.exportId}/download`);
