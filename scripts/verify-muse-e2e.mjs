/**
 * 妙思真实抓取端到端验证：只给一条腾讯妙思素材链接，走完整产品链路。
 *
 * 覆盖：链接提交 → 解析进程真实抓取（登录态会话 + 无头浏览器）→ 媒体缓存 → 真实模型解析
 *       → 六类标签落库（「场景」已删除）→ 原网页板块采集 → 导出 xlsx（16 列 · 1 行）。
 *
 * 前置：
 *   1. 已执行 npm run muse:login（会话有效），.env 中 MUSE_FETCH_ENABLED=true
 *   2. 已重启解析进程：npm run worker
 *   3. AI_MODE=dashscope 且密钥有效（本脚本会产生真实费用）
 *
 * 用法：node scripts/verify-muse-e2e.mjs [素材链接] [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';

const TAGS = ['人设', '痛点', '干货（解决方案）', '营销内容（产品介绍）', '福利', '其他'];
const HEADERS = [
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
  ...TAGS,
];
/** 导出表第 5 行为分组行：【视频分析】10 列 + 【脚本文案】1 列 + 【标签分类】6 列 */
const GROUP_ROW = ['视频分析', ...Array(9).fill(''), '脚本文案', '标签分类', ...Array(5).fill('')];
/** 标签列在导出表中的起始下标（0 基） */
const TAG_OFFSET = 11;

import { creds } from './_credentials.mjs';

const prisma = new PrismaClient();

// 运行时请传入真实素材链接；下面的占位 ID 仅示意地址格式，取不到素材。
const MUSE_URL =
  process.argv[2] ??
  'https://admuse.qq.com/#/idea/detail/video/134580000004?from=wechat_channels';
const BASE = process.argv[3] ?? 'http://127.0.0.1:3939';

const cookieJar = new Map();
const cookieHeader = () => Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookieJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
async function api(p, init = {}) {
  const res = await fetch(BASE + p, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: cookieHeader() },
    redirect: 'manual',
  });
  storeCookies(res);
  return res;
}
async function json(p, init) {
  const res = await api(p, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const results = [];
function check(name, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const TERMINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'UNSUPPORTED', 'CANCELLED'];

async function main() {
  console.log(`\n=== 妙思真实抓取端到端验证 @ ${BASE} ===`);
  console.log(`素材链接：${MUSE_URL}\n`);

  const login = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds.editor),
  });
  check('登录成功', login.body.ok === true);

  // 只提交链接，不上传任何文件：抓取必须由解析进程完成
  const submit = await json('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: `muse-${Date.now()}`,
      rows: [
        {
          clientRowKey: 'r1',
          sourceType: 'TENCENT_MUSE',
          sourceUrl: MUSE_URL,
          title: '',
          referenceUrl: '腾讯妙思素材（真实抓取验证）',
        },
      ],
    }),
  });
  const videoId = submit.body.data?.results?.[0]?.videoId;
  check('提交成功（仅链接，无本地文件）', Boolean(videoId), submit.body.error ?? JSON.stringify(submit.body.data ?? {}).slice(0, 160));
  if (!videoId) process.exit(1);

  console.log('\n  等待真实抓取 + 解析（抓取走无头浏览器，解析走真实模型）…\n');
  const t0 = Date.now();
  let d = null;
  let sawFetch = false;
  for (let i = 0; i < 900; i++) {
    const r = await json(`/api/videos/${videoId}`);
    d = r.body.data;
    if (d?.currentStage === 'FETCH' || d?.currentStageLabel?.includes('获取')) sawFetch = true;
    if (d && TERMINAL.includes(d.status)) break;
    if (i % 5 === 0) {
      process.stdout.write(
        `\r  阶段：${d?.currentStageLabel ?? d?.status ?? '排队中'}（${((Date.now() - t0) / 1000).toFixed(0)}s）      `,
      );
    }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\r  处理结束，用时 ${elapsed}s                                     \n`);

  check('任务走到终态', TERMINAL.includes(d?.status), `status=${d?.status}（${d?.statusLabel ?? ''}）`);
  check('状态为已完成', d?.status === 'COMPLETED', d?.errorMessage ?? '');

  // 抓取证据：媒体是从妙思取回的，不是本地补传
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: { media: true, classification: true },
  });
  const media = video?.media;
  check('媒体资产已落库', Boolean(media?.cachePath), media?.cachePath ?? '无');
  check(
    '媒体文件存在且非空',
    Boolean(media?.cachePath) && fs.existsSync(media.cachePath) && fs.statSync(media.cachePath).size > 0,
    media?.cachePath ? `${(fs.statSync(media.cachePath).size / 1024 / 1024).toFixed(2)}MB` : '无',
  );
  check(
    '来源确为腾讯妙思且保留原链接',
    video?.sourceType === 'TENCENT_MUSE' && Boolean(video?.sourceUrl),
    `${video?.sourceType} / ${video?.sourceUrl}`,
  );
  console.log(`\n── 抓取结果 ──`);
  console.log(`  来源类型：${video?.sourceType}`);
  console.log(`  原链接：${video?.sourceUrl}`);
  console.log(`  抓取标题：${d?.title ?? '（未取到，沿用人工标题）'}`);
  console.log(`  标题来源：${d?.titleSource ?? '—'}`);
  console.log(`  媒体文件：${media?.fileName ?? '—'}`);
  console.log(`  文件路径：${media?.cachePath ?? '—'}`);

  // 识别结果（新逻辑：段落 + 唯一标签）
  const segs = d?.current?.segments ?? [];
  check('生成了脚本版本', Boolean(d?.current) && segs.length > 0, `v${d?.current?.versionNo}，${segs.length} 段`);
  check('形式已判定', Boolean(d?.classification?.categoryLabel), d?.classification?.categoryLabel ?? '无');
  check(
    '时间段单调递增且非空',
    segs.every((s, i) => s.endMs > s.startMs && (i === 0 || s.startMs >= segs[i - 1].startMs)),
  );
  check(
    '每段都有唯一且合法的标签（六类之一）',
    segs.every((s) => TAGS.includes(s.tag)),
    Array.from(new Set(segs.map((s) => s.tag))).join(' | ') || '（无）',
  );
  check(
    '已删除「场景」标签（段落标签与导出标签都不含场景）',
    segs.every((s) => s.tag !== '场景') && !TAGS.includes('场景'),
  );
  check(
    '每段文案非空（转写原文不改字）',
    segs.every((s) => typeof s.copyText === 'string' && s.copyText.trim().length > 0),
  );

  // ── 任务 1 验收：段落不重不漏 ──
  const problems = d?.current?.problems ?? [];
  const dupCodes = ['DUPLICATE_UTTERANCE', 'SEGMENT_DROPPED', 'MISSING_UTTERANCE', 'REWRITTEN', 'NO_SOURCE_REF'];
  const hitDup = problems.filter((p) => dupCodes.includes(p.code));
  check(
    '段落不重不漏（无重复引用 / 重复段 / 漏段 / 改写问题）',
    hitDup.length === 0,
    hitDup.length ? hitDup.map((p) => p.code).join(' | ') : '无',
  );
  // 每段有多少比例的 6 字片段在「它之前的段落」里已出现过 —— 直接量化「段落内容不应重复」
  const norm = (s) => String(s || '').replace(/[\s，。！？、；：""''（）…—]/g, '');
  const shingles = (s) => {
    const t = norm(s);
    const out = new Set();
    for (let i = 0; i + 6 <= t.length; i += 1) out.add(t.slice(i, i + 6));
    return out;
  };
  const seenGram = new Set();
  const dupRates = [];
  for (const s of segs) {
    const g = shingles(s.copyText);
    let dup = 0;
    for (const x of g) if (seenGram.has(x)) dup += 1;
    dupRates.push(g.size ? (dup / g.size) * 100 : 0);
    for (const x of g) seenGram.add(x);
  }
  const worst = Math.round(Math.max(0, ...dupRates.slice(1)));
  check(
    '第 2 段起与前面段落无内容重合（重合度 < 50%）',
    worst < 50,
    `最高 ${worst}%（逐段 ${dupRates.map((r) => `${Math.round(r)}%`).join(' ')}）`,
  );
  // 脚本文案：整段转写原文，且必须等于各段文案按序拼接（不丢字、不重复）
  const transcriptText = (d?.current?.transcriptText ?? '').trim();
  check('「脚本文案」已落库（转写原文整段、非空）', transcriptText.length > 0, `${transcriptText.length} 字`);
  if (transcriptText && transcriptText !== '无') {
    const joined = segs.map((s) => s.copyText).join('');
    check(
      '脚本文案 = 各段文案按序拼接（证明分段不重不漏）',
      norm(joined) === norm(transcriptText),
      `拼接 ${norm(joined).length} 字 / 原文 ${norm(transcriptText).length} 字`,
    );
  }

  const mixed = d?.classification?.category === '混剪';
  const grouped = Object.fromEntries(
    TAGS.map((t) => [t, segs.filter((s) => s.tag === t).map((s) => s.copyText.trim()).filter(Boolean)]),
  );
  const groupedCount = TAGS.reduce((n, t) => n + grouped[t].length, 0);
  const filledCount = segs.filter((s) => s.copyText.trim().length > 0).length;
  check('按标签聚合后无遗漏（六格并集 = 全部转写段）', groupedCount === filledCount, `${groupedCount}/${filledCount}`);
  const sceneOverview = (d?.current?.sceneOverview ?? '').trim();
  check(
    '混剪时妆造/画面场景/情绪留空且不重复标注',
    !mixed || (segs.every((s) => !s.makeup && !s.emotion) && sceneOverview === ''),
    mixed ? '形式=混剪' : '非混剪（不适用）',
  );

  const cls = d?.classification;
  if (cls) {
    console.log(`\n── 形式判定 ──`);
    console.log(`  形式：${cls.categoryLabel}`);
    console.log(`  AI 占比：${cls.ratioEstimated ? `${(cls.aiRatio * 100).toFixed(1)}%` : '未估计（不编造精确比例）'}`);
    console.log(`  依据：${cls.evidence || '（空）'}`);
  }

  // 视频分析栏（原网页板块 + 妆造/画面场景/情绪）
  const ins = d?.insight;
  console.log(`\n── 视频分析 ──`);
  console.log(`  性别特征：${ins?.gender?.join('、') || '空'}`);
  console.log(`  年龄特征：${ins?.age?.join('、') || '空'}`);
  console.log(
    `  分镜/高光 title：${ins?.shotTitles?.length ? ins.shotTitles.join('｜') : '空'}` +
      (ins?.shotTitles?.length ? `（来源：${ins.shotTitleSource === 'video_script_summary' ? '视频分镜分析' : '高光时序分析'}）` : ''),
  );
  console.log(
    `  创意标签：${ins?.creativeTags?.length ? ins.creativeTags.map((t) => `${t.label}=${t.values.join('/')}`).join('；') : '空'}`,
  );
  console.log(`  妆造：${mixed ? '（混剪留空）' : segs[0]?.makeup || '空'}`);
  console.log(`  画面场景：${mixed ? '（混剪留空）' : sceneOverview || '空'}`);
  console.log(`  情绪：${mixed ? '（混剪留空）' : segs[0]?.emotion || '空'}`);
  console.log(`  形式：${cls?.categoryLabel ?? '—'}`);
  console.log(`  视频链接：${d?.sourceUrl ?? '—'}`);
  if (ins && !ins.fetched) console.log(`  板块说明：${ins.note}`);
  check('板块采集已执行（取到或明确为空）', Boolean(ins), ins?.fetched ? '已取到板块内容' : `空值：${ins?.note ?? '—'}`);

  console.log(`\n── 脚本文案（共 ${transcriptText.length} 字，截断 120 字）──`);
  console.log(`  ${transcriptText.slice(0, 120)}${transcriptText.length > 120 ? '…' : ''}`);

  console.log(`\n── 六类标签分布（共 ${segs.length} 段）──`);
  console.log(TAGS.map((t) => `  ${t}：${grouped[t].length} 段`).join('\n'));
  console.log(`\n── 按标签聚合预览（导出效果，截断 120 字）──`);
  for (const t of TAGS) {
    const text = grouped[t].join('\n');
    console.log(`  【${t}】${text ? text.slice(0, 120) + (text.length > 120 ? '…' : '') : '（空）'}`);
  }

  console.log(`\n── 原文保真校验 ──`);
  console.log(problems.length ? problems.map((p) => `  [${p.severity}] ${p.message}`).join('\n') : '  无问题');

  // 费用
  const usages = await prisma.modelUsage.findMany({ where: { attempt: { videoId } }, orderBy: { callNo: 'asc' } });
  console.log('\n── 模型调用与费用 ──');
  for (const u of usages) {
    const ms = u.finishedAt && u.startedAt ? u.finishedAt.getTime() - u.startedAt.getTime() : null;
    console.log(
      `  ${u.capability} ｜ ${u.modelId} ｜ ${u.status}` +
        (u.audioSeconds !== null ? ` ｜ ${u.audioSeconds}s` : '') +
        (u.inputTokens !== null || u.outputTokens !== null ? ` ｜ tok ${u.inputTokens}/${u.outputTokens}` : '') +
        ` ｜ ${u.estimatedCost === null ? '费用待核对' : `¥${Number(u.estimatedCost).toFixed(4)}`}` +
        (ms !== null ? ` ｜ ${(ms / 1000).toFixed(1)}s` : ''),
    );
  }
  const total = usages.reduce((s, u) => s + (u.estimatedCost ?? 0), 0);
  console.log(`  合计：¥${total.toFixed(4)}`);

  // 校验阶段（缺省 confirm）必须只返回校验结果、不带 exportId。
  // 历史 bug：前端把这一响应当成「导出完成」，拼出 /api/exports/undefined/download → 404。
  const validateOnly = await json('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ videoId }], kind: 'LIBRARY' }),
  });
  check(
    '校验阶段只返回校验结果，不带 exportId（避免 undefined 下载地址）',
    validateOnly.body.data?.stage === 'VALIDATE' && validateOnly.body.data?.exportId === undefined,
    JSON.stringify(validateOnly.body.data ?? validateOnly.body).slice(0, 160),
  );

  // 导出（一）信息流素材库：视频分析 10 列 + 脚本文案 1 列 + 标签 6 列 = 17 列，只有一行数据
  const exp = await json('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ videoId }], confirm: true, kind: 'LIBRARY' }),
  });
  const exportId = exp.body.data?.exportId;
  check('导出成功', exp.body.data?.stage === 'DONE' && Boolean(exportId), JSON.stringify(exp.body.data ?? exp.body).slice(0, 200));
  let outPath = '';
  if (exportId) {
    const dl = await api(`/api/exports/${exportId}/download`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const name = (dl.headers.get('content-disposition') ?? '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
    outPath = path.join(path.resolve(process.cwd(), 'data/exports'), decodeURIComponent(name ?? 'muse-export.xlsx'));
    fs.writeFileSync(outPath, buf);
    check('导出文件非空', buf.length > 0, `${(buf.length / 1024).toFixed(0)}KB`);
    check('导出文件名带「信息流素材库」前缀', /^信息流素材库_/.test(decodeURIComponent(name ?? '')), decodeURIComponent(name ?? ''));
    console.log(`\n导出文件（素材库）：${outPath}`);

    // 读回校验：视频分析 10 列 + 脚本文案 1 列 + 标签 6 列 = 17 列，且只有一行数据
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];
    const cellStr = (c) => {
      const v = c.value;
      if (v && typeof v === 'object' && 'text' in v) return String(v.text ?? '');
      return String(v ?? '');
    };
    const groupRow = GROUP_ROW.map((_, i) => cellStr(ws.getRow(5).getCell(i + 1)));
    check(
      '第 5 行分组行标注「视频分析」「脚本文案」「标签分类」',
      groupRow[0] === '视频分析' && groupRow[10] === '脚本文案' && groupRow[11] === '标签分类',
      `${groupRow[0]} | ${groupRow[10]} | ${groupRow[11]}`,
    );
    const header = HEADERS.map((_, i) => cellStr(ws.getRow(6).getCell(i + 1)));
    check(
      '第 6 行 17 列表头与约定一致（视频分析 10 + 脚本文案 1 + 标签 6）',
      header.length === 17 && JSON.stringify(header) === JSON.stringify(HEADERS),
      header.join(' | '),
    );
    const dataValues = HEADERS.map((_, i) => cellStr(ws.getRow(7).getCell(i + 1)));
    const row8 = HEADERS.map((_, i) => cellStr(ws.getRow(8).getCell(i + 1))).join('').trim();
    check('脚本表格只保留一行（第 8 行起为空）', row8 === '', row8 ? `第 8 行有内容：${row8.slice(0, 60)}` : '');
    check(
      '标签列内容与按标签聚合结果一致（逐列比对）',
      TAGS.every((t, i) => {
        const expected = grouped[t].join('\n');
        const actual = dataValues[TAG_OFFSET + i];
        return expected === actual;
      }),
      TAGS.map((t, i) => `${t}:${dataValues[TAG_OFFSET + i] ? '有' : '空'}`).join(' '),
    );
    const curRev = await prisma.scriptRevision.findFirst({ where: { videoId, isCurrent: true } });
    check(
      '脚本文案列等于该版本保存的转写原文（整段、未切分）',
      Boolean(dataValues[10]) && dataValues[10] === (curRev?.transcriptText ?? ''),
      `单元格 ${dataValues[10] ? `${dataValues[10].length} 字` : '空'} / 版本 ${(curRev?.transcriptText ?? '').length} 字`,
    );
    check(
      '画面场景列取自整条视频概览（不来自段落）',
      mixed ? dataValues[6] === '' : dataValues[6] === sceneOverview,
      `单元格=${dataValues[6] ? dataValues[6].slice(0, 40) : '空'}`,
    );
    check(
      '已删除序号时间 / 文案 / 旁白 / 截图结构与「场景」标签列',
      !header.includes('序号') &&
        !header.includes('旁白') &&
        !header.includes('主要画面截图') &&
        // 「脚本文案」是本次新增的列，此处只排除旧的「文案」列
        !header.some((h, i) => i !== 10 && h.includes('文案')) &&
        !header.includes('场景'),
      header.join(' | '),
    );
    // 创意标签：只呈现需求方指定的 10 项，且顺序固定
    const CT_SPEC = ['定向年龄', '人群', '制作形式', '情绪', '背景风格', '场景背景', '叙事', '开场钩子', '结尾钩子', '行动引导'];
    const ctLines = dataValues[4].split('\n').filter(Boolean).map((l) => l.split('：')[0].trim());
    check(
      '创意标签只呈现指定 10 项且顺序固定',
      ctLines.every((l) => CT_SPEC.includes(l)) &&
        ctLines.every((l, i) => i === 0 || CT_SPEC.indexOf(l) > CT_SPEC.indexOf(ctLines[i - 1])),
      ctLines.join(' → ') || '（空）',
    );
    // 原视频标题：链接导入取网页标题，与库里的 sourceTitle 一致
    const videoRow = await prisma.video.findUnique({ where: { id: videoId } });
    check(
      '「原视频标题」列取自链接对应网页标题',
      Boolean(dataValues[0]) && dataValues[0] === (videoRow?.sourceTitle ?? '') && dataValues[0] !== '未提供',
      `单元格=${dataValues[0]} / 库内=${videoRow?.sourceTitle ?? '（空）'}`,
    );

    // 「任务信息 → 标题」可人工修改，且不覆盖「原视频标题」
    const patched = await json(`/api/videos/${videoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '端到端验证-人工标题' }),
    });
    const afterPatch = await prisma.video.findUnique({ where: { id: videoId } });
    check(
      '标题可人工修改（来源标记为人工填写，且不覆盖原视频标题）',
      patched.body.ok === true &&
        afterPatch?.title === '端到端验证-人工标题' &&
        afterPatch?.titleSource === 'MANUAL' &&
        afterPatch?.sourceTitle === (videoRow?.sourceTitle ?? null),
      `title=${afterPatch?.title}（${afterPatch?.titleSource}）/ sourceTitle=${afterPatch?.sourceTitle}`,
    );
    // 还原为自动获取的标题，避免影响后续人工查看
    await json(`/api/videos/${videoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: afterPatch?.sourceTitle ?? '' }),
    });
  }

  // 导出（二）信息流脚本：3 列（序号 / 时间、标签、文案），按时间轴依次排列，一视频一表、序号从 1 起
  const exp2 = await json('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ videoId }], confirm: true, kind: 'SCRIPT' }),
  });
  const exportId2 = exp2.body.data?.exportId;
  check('导出信息流脚本成功', exp2.body.data?.stage === 'DONE' && Boolean(exportId2), JSON.stringify(exp2.body.data ?? exp2.body).slice(0, 200));
  if (exportId2) {
    const dl2 = await api(`/api/exports/${exportId2}/download`);
    const buf2 = Buffer.from(await dl2.arrayBuffer());
    const name2 = decodeURIComponent(
      (dl2.headers.get('content-disposition') ?? '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] ?? 'script.xlsx',
    );
    const outPath2 = path.join(path.resolve(process.cwd(), 'data/exports'), name2);
    fs.writeFileSync(outPath2, buf2);
    check('信息流脚本文件非空', buf2.length > 0, `${(buf2.length / 1024).toFixed(0)}KB`);
    check('信息流脚本文件名带「信息流脚本」前缀', /^信息流脚本_/.test(name2), name2);
    console.log(`导出文件（脚本）：${outPath2}`);

    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(outPath2);
    const ws2 = wb2.worksheets[0];
    const cell2 = (c) => {
      const v = c.value;
      if (v && typeof v === 'object' && 'text' in v) return String(v.text ?? '');
      return String(v ?? '');
    };
    const h2 = [1, 2, 3].map((i) => cell2(ws2.getRow(5).getCell(i)));
    check(
      '第 5 行表头为「序号 / 时间、标签、文案」',
      JSON.stringify(h2) === JSON.stringify(['序号 / 时间', '标签', '文案']),
      h2.join(' | '),
    );
    const segs = (await prisma.segment.findMany({
      where: { revision: { videoId, isCurrent: true } },
      orderBy: { startMs: 'asc' },
    })).filter((s) => (s.copyText ?? '').trim() !== '');
    const clock = (ms) => {
      const t = Math.max(0, Math.round(ms / 1000));
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = t % 60;
      const mm = String(m).padStart(2, '0');
      const ss = String(s).padStart(2, '0');
      return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    };
    const rows2 = [];
    for (let r = 6; r <= 6 + segs.length + 1; r += 1) {
      rows2.push([cell2(ws2.getRow(r).getCell(1)), cell2(ws2.getRow(r).getCell(2)), cell2(ws2.getRow(r).getCell(3))]);
    }
    check(
      '数据行数等于当前版本的段落数（一段一行）',
      rows2.slice(0, segs.length).every((r) => r[2] !== '') && rows2[segs.length][2] === '',
      `段落 ${segs.length} 行 / 第 ${segs.length + 1} 行是否空：${rows2[segs.length][2] === ''}`,
    );
    check(
      '序号从 1 连续递增且与时间同格',
      rows2.slice(0, segs.length).every((r, i) => r[0].split('\n')[0] === String(i + 1)),
      rows2.slice(0, 3).map((r) => JSON.stringify(r[0])).join(' '),
    );
    check(
      '时间列为该段的起止区间（与段落时间一致）',
      rows2.slice(0, segs.length).every((r, i) => r[0].split('\n')[1] === `${clock(segs[i].startMs)}–${clock(segs[i].endMs)}`),
      rows2.slice(0, 3).map((r) => r[0].split('\n')[1]).join(' '),
    );
    check(
      '文案列逐段等于转写原文（不改字、按时间轴排序）',
      rows2.slice(0, segs.length).every((r, i) => r[2] === (segs[i].copyText ?? '')),
      `${segs.length} 段逐字比对`,
    );
    check(
      '标签列等于段落标签',
      rows2.slice(0, segs.length).every((r, i) => r[1] === segs[i].tag),
      rows2.slice(0, 3).map((r) => r[1]).join(' '),
    );
  }

  await prisma.$disconnect();

  const passed = results.filter(Boolean).length;
  console.log(`\n=== 结果：${passed}/${results.length} 项通过 ===`);
  console.log(`视频详情页：${BASE}/tasks/${videoId}\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('验证异常：', e);
  process.exit(1);
});
