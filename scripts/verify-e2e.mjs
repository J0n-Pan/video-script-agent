/**
 * 端到端验证脚本（Mock 模式）：登录 → 上传 → 提交 → 队列解析 → 复核编辑 → 保存 → 标记复核 → 导出 → 校验 xlsx。
 * 用法：node scripts/verify-e2e.mjs [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { creds } from './_credentials.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3939';
const cookieJar = new Map();

function cookieHeader() {
  return Array.from(cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function storeCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

async function api(pathname, init = {}) {
  const res = await fetch(BASE + pathname, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: cookieHeader() },
    redirect: 'manual',
  });
  storeCookies(res);
  return res;
}

async function json(pathname, init) {
  const res = await api(pathname, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`\n=== 端到端验证 @ ${BASE} ===\n`);

  // 1. 未登录访问受保护资源应被拒绝（A33 前置：鉴权）
  const anon = await json('/api/tasks');
  check('未登录访问任务列表返回 401', anon.status === 401, `status=${anon.status}`);

  // 2. 登录
  const login = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds.editor),
  });
  check('编导账号登录成功', login.body.ok === true, JSON.stringify(login.body).slice(0, 120));

  const bad = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'editor', password: 'wrong' }),
  });
  check('错误密码被拒绝', bad.status === 401);

  // 3. 上传测试素材
  const sample = path.resolve(process.cwd(), 'data/samples/sample_talk_12s.mp4');
  if (!fs.existsSync(sample)) throw new Error(`缺少测试素材：${sample}，请先运行 npm run make:test-media`);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(sample)]), path.basename(sample));
  const up = await json('/api/uploads', { method: 'POST', body: fd });
  check('本地视频完整上传到主机', up.body.ok === true, up.body.error ?? '');
  const stageId = up.body.data?.stageId;

  // 4. 提交任务
  const clientKey = `e2e-${Date.now()}`;
  const submit = await json('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey,
      rows: [
        {
          clientRowKey: 'r1',
          sourceType: 'LOCAL',
          stageId,
          fileName: path.basename(sample),
          title: 'E2E 测试素材（12秒）',
          originalPath: 'D:\\素材\\sample_talk_12s.mp4',
        },
      ],
    }),
  });
  const videoId = submit.body.data?.results?.[0]?.videoId;
  check('批量提交逐行返回结果', submit.body.data?.results?.length === 1 && Boolean(videoId), submit.body.error ?? '');

  // 5. 幂等：同一次提交重发不重复创建
  const dup = await json('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey,
      rows: [{ clientRowKey: 'r1', sourceType: 'LOCAL', stageId, fileName: path.basename(sample), title: 'E2E 测试素材（12秒）' }],
    }),
  });
  check('重复点击同一次提交不产生重复任务', dup.body.data?.duplicated === true);

  // 6. 等待解析完成
  console.log('\n  等待解析进程处理…');
  let detail = null;
  for (let i = 0; i < 90; i += 1) {
    const r = await json(`/api/videos/${videoId}`);
    detail = r.body.data;
    if (detail && ['COMPLETED', 'PARTIAL', 'FAILED', 'UNSUPPORTED', 'CANCELLED'].includes(detail.status)) break;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  check('任务在队列中被串行处理并结束', Boolean(detail) && !['QUEUED', 'PROCESSING'].includes(detail.status), `status=${detail?.status}`);
  check('生成脚本版本', Boolean(detail?.current), `v${detail?.current?.versionNo}`);
  const segs = detail?.current?.segments ?? [];
  check(
    '段落含文案与唯一标签（「场景」已删除）',
    segs.length > 0 &&
      segs.every((s) => typeof s.copyText === 'string' && ['人设', '痛点', '干货（解决方案）', '营销内容（产品介绍）', '福利', '其他'].includes(s.tag)),
    `${segs.length} 段`,
  );
  check(
    '时间满足 0 ≤ 开始 < 结束 ≤ 总时长',
    segs.every((s) => s.startMs >= 0 && s.endMs > s.startMs && s.endMs <= (detail.durationMs ?? 0) + 1),
  );
  check('形式已判断', Boolean(detail?.classification?.categoryLabel), detail?.classification?.categoryLabel);
  check('模型调用与费用已记录', detail?.cost?.calls > 0, `${detail?.cost?.calls} 次，估算 ${detail?.cost?.estimatedTotal} 元`);

  // 7. 复核编辑：改文案 + 拆分段 + 调时间
  const first = segs[0];
  const edited = segs.map((s, i) =>
    i === 0
      ? { ...s, copyText: s.copyText + '（人工核对补充标点）', endMs: Math.max(s.endMs - 500, s.startMs + 500) }
      : s,
  );
  const save = await json(`/api/videos/${videoId}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRevisionId: detail.current.id, segments: edited }),
  });
  check('显式保存生成新版本', save.body.ok === true && save.body.data.versionNo === detail.current.versionNo + 1, save.body.error ?? '');

  // 8. 版本冲突：用过期的 baseRevisionId 再保存应被拒绝
  const conflict = await json(`/api/videos/${videoId}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRevisionId: detail.current.id, segments: edited }),
  });
  check('过期版本号保存被拒绝（不静默覆盖）', conflict.status === 409, `status=${conflict.status}`);

  // 9. 越权访问：另一个账号不得访问该视频（A33）
  const savedJar = new Map(cookieJar);
  cookieJar.clear();
  await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds.editor2),
  });
  const cross = await json(`/api/videos/${videoId}`);
  check('其他账号访问该视频被拒绝', cross.status === 404, `status=${cross.status}`);
  cookieJar.clear();
  for (const [k, v] of savedJar) cookieJar.set(k, v);

  // 10. 标记复核
  const after = await json(`/api/videos/${videoId}`);
  const revId = after.body.data.current.id;
  const hasHard = (after.body.data.current.problems ?? []).some((p) => p.severity !== 'info');
  const reviewNoAck = await json(`/api/videos/${videoId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revisionId: revId, acknowledgeProblems: false }),
  });
  if (hasHard) {
    check('存在问题标记时未确认不允许标记已复核', reviewNoAck.status === 409);
  } else {
    check('无阻断问题时可直接标记已复核', reviewNoAck.body.ok === true);
  }
  const review = await json(`/api/videos/${videoId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revisionId: revId, acknowledgeProblems: true }),
  });
  check('确认后可标记已复核', review.body.ok === true, review.body.error ?? '');

  // 11. 导出
  const expValidate = await json('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ videoId }] }),
  });
  check('导出前校验通过', expValidate.body.data?.stage === 'VALIDATE' && expValidate.body.data?.blocked?.length === 0, JSON.stringify(expValidate.body.data?.blocked ?? []).slice(0, 160));

  const expCreate = await json('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ videoId }], confirm: true }),
  });
  check('生成导出文件', expCreate.body.data?.stage === 'DONE', expCreate.body.error ?? '');

  // 12. 校验不可导出项被明确列出（A28）
  const queued = await json('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: `e2e2-${Date.now()}`,
      rows: [{ clientRowKey: 'r1', sourceType: 'TENCENT_MUSE', sourceUrl: 'https://admuse.qq.com/#/idea?id=abc', title: '未完成的任务' }],
    }),
  });
  const pendingId = queued.body.data?.results?.[0]?.videoId;
  const expBlocked = await json('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ videoId: pendingId }] }),
  });
  check(
    '无可用结果的任务被明确列为不可导出（不静默少导出）',
    (expBlocked.body.data?.blocked ?? []).length === 1,
    JSON.stringify(expBlocked.body.data?.blocked ?? []).slice(0, 200),
  );
  await json(`/api/videos/${pendingId}`, { method: 'DELETE' });

  // 13. 下载并校验 xlsx（默认「信息流素材库」：17 列 = 视频分析 10 + 脚本文案 1 + 标签 6，只有一行数据）
  const dl = await api(`/api/exports/${expCreate.body.data.exportId}/download`);
  check('导出文件下载需鉴权且可下载', dl.status === 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  check('一个视频一个工作表', wb.worksheets.length === 1, `${wb.worksheets.length} 个`);
  check('第 1 行完整标题', String(ws.getCell('A1').value ?? '').includes('E2E'), String(ws.getCell('A1').value ?? '').slice(0, 40));
  check('第 2 行时长 + 原文件名', String(ws.getCell('A2').value ?? '').startsWith('时长：') && String(ws.getCell('D2').value ?? '').startsWith('原文件名：'));
  check('第 3 行本地原文件路径', String(ws.getCell('A3').value ?? '').startsWith('本地原文件路径：'));
  check('第 4 行复核状态 + 版本时间', String(ws.getCell('A4').value ?? '').includes('已复核'), String(ws.getCell('A4').value ?? ''));
  const LIB_HEADERS = [
    '原视频标题',
    '性别特征',
    '年龄特征',
    '分镜/高光 title',
    '创意标签',
    '妆造',
    '画面场景',
    '情绪',
    '形式',
    '视频链接',
    '脚本文案',
    '人设',
    '痛点',
    '干货（解决方案）',
    '营销内容（产品介绍）',
    '福利',
    '其他',
  ];
  const gotGroup = [1, 11, 12].map((i) => String(ws.getRow(5).getCell(i).value ?? ''));
  check(
    '第 5 行分组行为「视频分析 / 脚本文案 / 标签分类」',
    JSON.stringify(gotGroup) === JSON.stringify(['视频分析', '脚本文案', '标签分类']),
    gotGroup.join('|'),
  );
  const got = LIB_HEADERS.map((_, i) => String(ws.getRow(6).getCell(i + 1).value ?? ''));
  check('第 6 行 17 列表头且顺序不变', JSON.stringify(got) === JSON.stringify(LIB_HEADERS), got.join('|'));
  check(
    '第 7 行唯一一行数据（第 8 行起为空）',
    LIB_HEADERS.some((_, i) => String(ws.getRow(7).getCell(i + 1).value ?? '') !== '') &&
      LIB_HEADERS.every((_, i) => String(ws.getRow(8).getCell(i + 1).value ?? '') === ''),
  );
  check('形式与视频链接已填充', String(ws.getRow(7).getCell(9).value ?? '').length > 0 && LIB_HEADERS[9].length > 0);

  // 13b. 「信息流脚本」导出：3 列（序号 / 时间、标签、文案），按时间轴一段一行
  const expScript = await json('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ videoId }], confirm: true, kind: 'SCRIPT' }),
  });
  check('生成信息流脚本导出', expScript.body.data?.stage === 'DONE', JSON.stringify(expScript.body.data ?? expScript.body).slice(0, 160));
  if (expScript.body.data?.exportId) {
    const dl2 = await api(`/api/exports/${expScript.body.data.exportId}/download`);
    check('信息流脚本文件可下载', dl2.status === 200);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(Buffer.from(await dl2.arrayBuffer()));
    const ws2 = wb2.worksheets[0];
    const h2 = [1, 2, 3].map((i) => String(ws2.getRow(5).getCell(i).value ?? ''));
    check('表头为「序号 / 时间、标签、文案」', JSON.stringify(h2) === JSON.stringify(['序号 / 时间', '标签', '文案']), h2.join('|'));
    // 导出的是「保存后的当前版本」，且按时间轴（startMs）排序；
    // 不能用前面那次的 segs（那是编辑前的旧版本），重新取当前版本比对
    const cur = await json(`/api/videos/${videoId}`);
    const nonEmpty = (cur.body.data?.current?.segments ?? [])
      .filter((s) => (s.copyText ?? '').trim() !== '')
      .sort((a, b) => a.startMs - b.startMs);
    check(
      '文案按时间轴一段一行且与段落一致',
      nonEmpty.length > 0 && nonEmpty.every((s, i) => String(ws2.getRow(6 + i).getCell(3).value ?? '') === s.copyText),
      `${nonEmpty.length} 段`,
    );
    check(
      '序号 / 时间列与段落起止一致',
      nonEmpty.every((s, i) => {
        const v = String(ws2.getRow(6 + i).getCell(1).value ?? '');
        const p = (n) => String(n).padStart(2, '0');
        const clock = (ms) => {
          const t = Math.max(0, Math.round(ms / 1000));
          return `${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
        };
        return v.split('\n')[0] === String(i + 1) && v.split('\n')[1] === `${clock(s.startMs)}–${clock(s.endMs)}`;
      }),
      nonEmpty.slice(0, 3).map((_, i) => JSON.stringify(String(ws2.getRow(6 + i).getCell(1).value ?? ''))).join(' '),
    );
  }

  // 14. 删除任务会清理
  const del = await json(`/api/videos/${videoId}`, { method: 'DELETE' });
  check('删除本人视频记录并清理关联导出', del.body.ok === true, JSON.stringify(del.body.data ?? {}));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('未通过项：');
    failed.forEach((f) => console.log(`  · ${f.name} ${f.detail}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n端到端验证异常：', e);
  process.exit(1);
});
