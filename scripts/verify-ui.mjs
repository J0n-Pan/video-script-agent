import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { creds } from './_credentials.mjs';

const BASE = 'http://127.0.0.1:3939';
const jar = new Map();
const ch = () => Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

async function api(p, init = {}) {
  const res = await fetch(BASE + p, { ...init, headers: { ...(init.headers ?? {}), cookie: ch() }, redirect: 'manual' });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return res;
}

const out = [];
const check = (n, ok, d = '') => {
  out.push({ n, ok, d });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};

// 登录
await api('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(creds.editor),
});

console.log('\n=== 登录后页面渲染 ===');
for (const p of ['/tasks', '/tasks/new', '/export']) {
  const r = await api(p);
  const t = await r.text();
  check(`页面 ${p} 渲染正常`, r.status === 200 && !t.includes('Application error'), `status=${r.status}`);
}

// 建一条任务用于复核页与媒体流验证
const sample = path.resolve(process.cwd(), 'data/samples/sample_talk_12s.mp4');
const fd = new FormData();
fd.append('file', new Blob([fs.readFileSync(sample)]), path.basename(sample));
const up = await (await api('/api/uploads', { method: 'POST', body: fd })).json();
const sub = await (await api('/api/tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    clientKey: `page-${Date.now()}`,
    rows: [{ clientRowKey: 'r1', sourceType: 'LOCAL', stageId: up.data.stageId, fileName: path.basename(sample), title: '页面冒烟素材' }],
  }),
})).json();
const videoId = sub.data.results[0].videoId;

let detail = null;
for (let i = 0; i < 90; i += 1) {
  detail = (await (await api(`/api/videos/${videoId}`)).json()).data;
  if (detail && !['QUEUED', 'PROCESSING', 'UPLOADING'].includes(detail.status)) break;
  await new Promise((r) => setTimeout(r, 1000));
}

console.log('\n=== 复核页与媒体资源 ===');
const rp = await api(`/tasks/${videoId}`);
const rpt = await rp.text();
check('复核页渲染正常', rp.status === 200 && !rpt.includes('Application error'), `status=${rp.status}`);

// 工作台是客户端组件：SSR 只吐一个加载壳，下拉项 / 小字都不在里面。
// 断言「渲染出来的东西」必须用真实浏览器 —— 抓 HTML 会「看起来全 PASS 其实啥也没测」（2026-09-17 修正）。
const removedFormOpts = ['ai视频', '有ai片段', '真人口播', '真人访谈', '其他及简短说明', '待复核'];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.request.post(`${BASE}/api/auth/login`, { data: creds.editor });
const page = await ctx.newPage();
await page.goto(`${BASE}/tasks/${videoId}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('select', { timeout: 30000 });

const optionSets = await page.$$eval('select', (els) => els.map((e) => Array.from(e.options).map((o) => o.value)));
const formOpts = optionSets.find((v) => v.includes('混剪')) ?? [];
const workbenchHtml = await page.content();

const leftOver = removedFormOpts.filter((v) => formOpts.includes(v));
check('「形式」下拉已移除全部旧取值', leftOver.length === 0, leftOver.join(' ') || `当前取值 ${formOpts.join(' / ')}`);
const newOpts = ['混剪', 'AI数字人', '真人', '其他'];
check(
  '「形式」下拉只有 4 项新取值',
  newOpts.every((v) => formOpts.includes(v)) && formOpts.filter(Boolean).length === newOpts.length,
  `实际 ${formOpts.filter(Boolean).join(' / ')}`,
);
check(
  '标签列下方小字已删除',
  !workbenchHtml.includes('妆造 / 画面场景 / 情绪在'),
  workbenchHtml.includes('妆造 / 画面场景 / 情绪在') ? '仍存在' : '已删除',
);
await browser.close();

const goneShot = await api('/api/screenshots/not-a-real-id');
check('截图下载接口已下线（404）', goneShot.status === 404, `status=${goneShot.status}`);

const media = await api(`/api/videos/${videoId}/media`);
check('媒体流可播放（200 + video/mp4）', media.status === 200 && (media.headers.get('content-type') ?? '').includes('video'), `${media.status} ${media.headers.get('content-type')}`);
const ranged = await api(`/api/videos/${videoId}/media`, { headers: { Range: 'bytes=0-1023' } });
check('媒体流支持 Range（拖动进度）', ranged.status === 206 && ranged.headers.get('content-range') !== null, `${ranged.status} ${ranged.headers.get('content-range')}`);
check('媒体流声明 Accept-Ranges', media.headers.get('accept-ranges') === 'bytes');

// 注：截图相关能力已于 2026-09-16 全量下线（界面入口、下载接口 /api/screenshots/[id]
// 与接口下发字段均已删除），故此处不再验证截图可访问性。

// 拆分/合并由前端组合，这里验证保存后可持久化
const after = (await (await api(`/api/videos/${videoId}`)).json()).data;
const segs = after.current.segments;
const splitSave = await api(`/api/videos/${videoId}/save`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    baseRevisionId: after.current.id,
    segments: [
      ...segs.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        copyText: s.copyText,
        tag: s.tag,
        makeup: s.makeup,
        emotion: s.emotion,
      })),
      { startMs: 2000, endMs: 4000, copyText: '（人工新增段落）', tag: '其他', makeup: '无法辨认', emotion: '无法辨认' },
    ],
  }),
});
const sj = await splitSave.json();
check('新增/拆分后的段落可保存并持久化', sj.ok === true && sj.data.versionNo > after.current.versionNo, sj.error ?? `v${sj.data?.versionNo}`);
const final = (await (await api(`/api/videos/${videoId}`)).json()).data;
check('刷新后仍存在新增段落且序号重排', final.current.segments.some((s) => s.copyText.includes('人工新增段落')), `segments=${final.current.segments.length}`);

await api(`/api/videos/${videoId}`, { method: 'DELETE' });

const failed = out.filter((r) => !r.ok);
console.log(`\n=== 结果：${out.length - failed.length}/${out.length} 通过 ===`);
if (failed.length) process.exit(1);
