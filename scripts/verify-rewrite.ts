/**
 * 个性化文案 + 数字人迭代的自动验收（2026-09-20 需求文档 §10，A01~A22）。
 *
 * 设计取舍：
 * - **不花钱**：改写链路全部走「干跑 / 库层直调」，数字人走 Mock 适配器；
 *   唯一不碰模型的地方是「幂等回放」断言 —— 它本来就在读库后直接返回，不触发调用。
 * - **不碰真实数据**：所有造出来的记录都挂在一条带 `__verify_rewrite__` 前缀的测试视频下，
 *   跑完即清理；不会读改删编导的真实任务。
 * - **断言「可自动断言的部分」**：结构契约、版本、鉴权、幂等、状态迁移、成品校验。
 *   文案审美与口播效果由编导验收，脚本不做评价（§10 明确）。
 *
 * 用法：
 *   npm run verify:rewrite:unit        # 仅纯函数与库层断言（不需要 web，不调模型）
 *   npm run verify:rewrite             # 追加接口层断言（需要 web 在 3939 跑着）
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { cfg } from '../src/lib/config';
import { validateDrafts, checkLengthBalance, checkBannedWordHits, checkTranscriptConsistency, findDuplicateDrafts, estimateDurationMs, SPEECH_CHARS_PER_SECOND } from '../src/lib/rewrite/validate';
import { parseBannedPack, readBannedPack, renderBannedText, scanBannedWords, scanPrepared, prepareScanner } from '../src/lib/rewrite/banned';
import { buildRewriteRules, buildRewriteUserMessage } from '../src/lib/rewrite/rules';
import { normalizeExportKind } from '../src/lib/export/service';
import { EXPORT_KIND } from '../src/lib/constants';
import { generateRewrite, saveVariantRevision } from '../src/lib/rewrite/service';
import { createAvatarJob } from '../src/lib/avatar/service';

/**
 * 护栏：本验收**必须**走 Mock 适配器。
 *
 * 它会调用 `createAvatarJob` / `advanceAvatarJob`，而适配器取自 `.env`。
 * 一旦有人为了联调把 `AVATAR_ADAPTER` 改成了 `playwright`，再跑这个脚本就会
 * **真的把「验收用正文」提交到鲲之益平台**，白白消耗额度、还留下一条废作品。
 * 这类事不该靠人记得，所以这里直接拦住并说明怎么跑。
 */
if (cfg.avatar.adapter !== 'mock') {
  console.error(
    `\n[verify:rewrite] 拒绝运行：当前 AVATAR_ADAPTER="${cfg.avatar.adapter}"，本验收只能走 Mock。\n` +
      '  原因：脚本会调用数字人提交逻辑，真实适配器会向鲲之益平台提交测试文本、消耗平台额度。\n' +
      '  跑法（不改 .env，只对本条命令生效）：\n' +
      '    AVATAR_ADAPTER="mock" npm run verify:rewrite\n' +
      '    AVATAR_ADAPTER="mock" npm run verify:rewrite:unit\n',
  );
  process.exit(2);
}

/**
 * 同一类坑的下一步：`AVATAR_SUBMIT_MODE` 也会改变提交语义。
 *
 * 本脚本绝大多数断言是按 **auto**（适配器自己提交）写的 —— 例如「提交结果不明 → 待核对」
 * 依赖 `adapter.submit()` 那条路。若 `.env` 里设了 `assist`，这些断言会**静默换意思**：
 * 同一个作品名走的是 `assistSubmit`，`[uncertain]` 这种只对 submit 生效的标记就不再触发，
 * 结果是「改了环境变量 → 一批断言假失败」，而代码一点没变（2026-09-22 实测踩到）。
 * 所以这里统一把 ambient 值归一到 auto；assist 的语义由下面专门的分组自己切换并还原。
 */
if (cfg.avatar.submitMode !== 'auto') {
  console.log(
    `（提示：当前 AVATAR_SUBMIT_MODE=${cfg.avatar.submitMode}，本验收按 auto 断言，已在本进程内临时改为 auto）`,
  );
  (cfg.avatar as { submitMode: 'auto' | 'assist' }).submitMode = 'auto';
}

const args = process.argv.slice(2);
const UNIT_ONLY = args.includes('--unit-only');
const API_BASE = process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:3939';
const PREFIX = '__verify_rewrite__';

const prisma = new PrismaClient();
let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

function refSegs() {
  return [
    { id: 'r1', orderIndex: 1, tag: '其他', copyText: 'Light光ang sunlight，阳ang光moonlight，月光ang starlight，星光ang skylight。' },
    { id: 'r2', orderIndex: 2, tag: '人设', copyText: '哎，这本书你也在学啊，我孩子也在学，这本书就是我出版的呀。没错，就是我。' },
    { id: 'r3', orderIndex: 3, tag: '痛点', copyText: '那这本书到底怎么用啊？课本上的单词密密麻麻全是长单词和音表，孩子没学过，他不会背，他就没有兴趣。' },
    { id: 'r4', orderIndex: 4, tag: '干货（解决方案）', copyText: '所以我们呀要通过这一套英语单词拆分手册，让孩子对背单词这件事儿感兴趣。' },
    { id: 'r5', orderIndex: 5, tag: '营销内容（产品介绍）', copyText: '每个单元有两个码，第一个码是动画片，第二码是真人讲解。' },
    { id: 'r6', orderIndex: 6, tag: '干货（解决方案）', copyText: '你让孩子先花三分钟时间看动画，让它看的眼熟，听的耳熟。' },
    { id: 'r7', orderIndex: 7, tag: '干货（解决方案）', copyText: '然后这样子每天往复练习啊，一个月下来单词量就刷刷的往上涨。' },
  ];
}

/** 由参考段生成一份合法草稿，可指定要破坏的点 */
function draft(variantNo: number, mutate?: (segs: any[]) => any[]) {
  const segs = refSegs().map((r) => ({
    orderIndex: r.orderIndex,
    sourceSegmentId: r.id,
    tag: r.tag,
    copyText: `第${variantNo}版改写正文第${r.orderIndex}段：内容与参考段作用相同但表达不同。`,
    factRefs: ['personal-1'],
  }));
  return { variantNo, diffSummary: `第${variantNo}版差异说明`, segments: mutate ? mutate(segs) : segs };
}

// ---------------------------------------------------------------------------
// 一、结构契约（A03 / A04 / A05 / A06 / A07）
// ---------------------------------------------------------------------------
function unitAssertions() {
  const refs = refSegs();

  group('结构契约：段数 / 顺序 / 标签 / 来源段对应（A03）');
  {
    const r = validateDrafts(refs as any, [draft(1)] as any, 1);
    ok('合法稿被接受', r.drafts.length === 1);
    ok('接受稿的段数与参考一致', r.drafts[0]?.segments.length === refs.length);
    ok(
      '每段 sourceSegmentId 与参考段一一对应',
      r.drafts[0]?.segments.every((s, i) => s.sourceSegmentId === refs[i].id),
    );
    ok('每段标签与参考段一致', r.drafts[0]?.segments.every((s, i) => s.tag === refs[i].tag));
    ok('整段正文 = 各段按序拼接', r.drafts[0]?.transcriptText === r.drafts[0]?.segments.map((s) => s.copyText).join(''));
  }

  {
    const r = validateDrafts(refs as any, [draft(1, (s) => s.slice(0, 6))] as any, 1);
    ok('少一段 → 整稿被拒（不修补）', r.drafts.length === 0 && r.problems.some((p) => p.code === 'REWRITE_SEGMENT_COUNT_MISMATCH'));
  }
  {
    const r = validateDrafts(refs as any, [draft(1, (s) => [...s, { ...s[5], orderIndex: 8 }])] as any, 1);
    ok('多一段 → 整稿被拒', r.drafts.length === 0);
  }
  {
    // 注意：数组元素顺序不重要（校验器按 orderIndex 排序后比对），
    // 真正要防的是**orderIndex 与 sourceSegmentId 不再匹配** —— 那才是「重排了结构」
    const r = validateDrafts(
      refs as any,
      [draft(1, (s) => s.map((x, i) => (i === 0 ? { ...x, orderIndex: 2 } : i === 1 ? { ...x, orderIndex: 1 } : x)))] as any,
      1,
    );
    ok(
      '段落与参考段的对应被调换 → 整稿被拒（不得重排结构）',
      r.drafts.length === 0 && r.problems.some((p) => p.code === 'REWRITE_SOURCE_REF_MISMATCH' || p.code === 'REWRITE_ORDER_MISMATCH'),
    );
  }
  {
    const r = validateDrafts(refs as any, [draft(1, (s) => s.map((x, i) => (i === 2 ? { ...x, tag: '福利' } : x)))] as any, 1);
    ok('标签被改成另一类 → 整稿被拒', r.drafts.length === 0 && r.problems.some((p) => p.code === 'REWRITE_TAG_MISMATCH'));
  }
  {
    const r = validateDrafts(refs as any, [draft(1, (s) => s.map((x, i) => (i === 0 ? { ...x, sourceSegmentId: '不存在' } : x)))] as any, 1);
    ok('引用不存在的参考段 → 整稿被拒', r.drafts.length === 0 && r.problems.some((p) => p.code === 'REWRITE_SOURCE_REF_INVALID'));
  }
  {
    const r = validateDrafts(refs as any, [draft(1, (s) => s.map((x, i) => (i === 4 ? { ...x, copyText: '   ' } : x)))] as any, 1);
    ok('某段正文为空 → 整稿被拒', r.drafts.length === 0 && r.problems.some((p) => p.code === 'REWRITE_EMPTY_TEXT'));
  }

  group('标签形态归一（实测中 qwen3.7-flash 把「干货（解决方案）」写成半角右括号）');
  {
    const r = validateDrafts(
      refs as any,
      [draft(1, (s) => s.map((x, i) => (i === 3 ? { ...x, tag: '干货（解决方案)' } : x)))] as any,
      1,
    );
    ok('仅全/半角括号差异 → 接受，并回填参考段的规范标签', r.drafts.length === 1 && r.drafts[0]?.segments[3].tag === '干货（解决方案）');
    ok('同时留 info 级问题项（修正但不静默）', r.problems.some((p) => p.code === 'REWRITE_TAG_NORMALIZED' && p.severity === 'info'));
  }

  group('多版本差异（A07）');
  {
    const a = { ...draft(1), segments: draft(1).segments };
    const b = { ...draft(2), segments: draft(1).segments }; // 正文与第 1 版完全相同
    const v = validateDrafts(refs as any, [a, b] as any, 2);
    const dup = findDuplicateDrafts(v.drafts);
    ok('两稿正文逐字相同 → 判为无效重复', dup.some((p) => p.code === 'REWRITE_DUPLICATE_CONTENT'));
  }
  {
    const v = validateDrafts(refs as any, [draft(1), draft(2), draft(3)] as any, 3);
    ok('三稿各不相同 → 无重复告警', findDuplicateDrafts(v.drafts).length === 0);
  }

  group('素材不足 / 无法生成（A06）');
  {
    const blocked = { variantNo: 1, diffSummary: '', blockedReason: '第 3 段：资料包中没有可对应的事实', segments: [] };
    const r = validateDrafts(refs as any, [blocked] as any, 1);
    ok('模型明确说明无法生成 → 标为未生成并保留原因', r.drafts.length === 1 && r.drafts[0].blockedReason !== '' && r.drafts[0].segments.length === 0);
    ok('未生成的稿不计入可用版本', r.drafts.filter((d) => !d.blockedReason).length === 0);
  }

  group('段落长度平衡（实测 flash 曾把 483 字写成 940 字）');
  {
    const long = draft(1, (s) => s.map((x, i) => (i === 1 ? { ...x, copyText: '很长的正文。'.repeat(40) } : x)));
    const v = validateDrafts(refs as any, [long] as any, 1);
    ok('某段远超参考段 → 出 warn 但不拒稿', checkLengthBalance(refs as any, v.drafts).some((p) => p.code === 'REWRITE_SEGMENT_LENGTH_OFF') && v.drafts.length === 1);
  }

  group('整段与分段一致性（A09）');
  {
    const segs = draft(1).segments;
    const good = checkTranscriptConsistency(segs.map((s) => s.copyText).join(''), segs);
    ok('一致 → 不提示', good.consistent === true && good.message === '');
    const bad = checkTranscriptConsistency('这是一段与分段完全不同的整段文案', segs);
    ok('不一致 → 提示「本次使用分段版本」且不判定为一致', bad.consistent === false && bad.message.includes('分段'));
  }

  group('时长估算（估算值与参考时间码区分）');
  {
    const ms = estimateDurationMs(480);
    ok('按 4.8 字/秒估算', ms === Math.round((480 / SPEECH_CHARS_PER_SECOND) * 1000));
  }

  // -------------------------------------------------------------------------
  // 违禁词资料包（2026-09-22 第七轮）：解析口径 / 提示词位置 / 命中扫描
  // -------------------------------------------------------------------------
  group('违禁词解析：分类只认显式写法，词一个都不能丢（2026-09-22 新增）');
  {
    const md = parseBannedPack(['# 绝对化用语', '- 最好', '- 第一', '', '# 医疗承诺', '- 包治百病'].join('\n'));
    ok('markdown 标题被识别为分类', JSON.stringify(md.pack.categories) === JSON.stringify(['绝对化用语', '医疗承诺']));
    ok('标题本身不会被当成词条', !md.pack.entries.some((e) => e.text === '绝对化用语'));
    ok('词条全部收录', md.pack.entries.length === 3);

    const bracket = parseBannedPack(['【绝对化用语】', '最好、第一、国家级'].join('\n'));
    ok('【分类】被识别', bracket.pack.categories[0] === '绝对化用语');
    ok('一行里的顿号多个词被拆开', bracket.pack.entries.length === 3);

    const noisy = parseBannedPack(['1. 秒杀', '2) 全网最低', '• 稳赚不赔', '(3) 无风险'].join('\n'));
    ok(
      '编号 / 项目符号被剥掉、词原样保留',
      ['秒杀', '全网最低', '稳赚不赔', '无风险'].every((w) => noisy.pack.entries.some((e) => e.text === w)),
    );

    const flat = parseBannedPack('最好\n第一');
    ok('没有标题时全部归「未分类」而不是丢弃', flat.pack.entries.length === 2 && flat.pack.entries.every((e) => e.category === '未分类'));
    ok('未分类时给出可读提示', flat.warnings.some((w) => w.includes('未分类')));

    /**
     * 方向可以反的弱信号：`最好：广告法禁用词` 与 `绝对化用语：最好、第一` 形态相同。
     * 断言的不是"判对了方向"，而是**词没丢** —— 这才是不可接受的失败。
     */
    const ambiguous = parseBannedPack('最好：广告法绝对化用语，不能用');
    ok('方向不明的冒号行：左侧词条不丢', ambiguous.pack.entries.some((e) => e.text === '最好'));
  }

  group('违禁词渲染与命中扫描（空白/大小写归一、区间能切回原文）');
  {
    const pack = parseBannedPack(['# 绝对化用语', '- 最好', '- 第一'].join('\n')).pack;
    const text = renderBannedText(pack, '广告法禁语', 2);
    ok('渲染含版本号', text.includes('v2'));
    ok('渲染含分类小标题', text.includes('## 绝对化用语'));
    ok('渲染含词条', text.includes('- 最好'));
    ok('空词表渲染为空串（提示词里整块消失）', renderBannedText({ categories: [], entries: [] }, 'x', 1) === '');

    const hits = scanPrepared('这个产品是最好的，ABC 第一。', prepareScanner(pack.entries));
    ok('命中最长的词', hits.some((h) => h.word === '最好'));
    ok('命中「第一」', hits.some((h) => h.word === '第一'));
    const best = hits.find((h) => h.word === '最好');
    ok(
      '命中区间能切回原文（供界面高亮）',
      best != null && '这个产品是最好的，ABC 第一。'.slice(best.start, best.end) === '最好',
      best ? JSON.stringify('这个产品是最好的，ABC 第一。'.slice(best.start, best.end)) : '',
    );
    ok(
      '跨空白也能命中（「包治 百病」命中「包治百病」）',
      scanBannedWords('能包治 百病', [{ text: '包治百病', category: 'c', note: '' }]).length === 1,
    );
    ok(
      'prepareScanner 与一次性扫描结果一致',
      JSON.stringify(scanPrepared('最好和第一', prepareScanner(pack.entries))) ===
        JSON.stringify(scanBannedWords('最好和第一', pack.entries)),
    );
    ok('没有词表时不命中', scanBannedWords('什么都说', []).length === 0);
  }

  group('命中检查：只标记不阻断（BANNED_WORD_HIT 为 warn，不进 problemFlags 之外的裁决）');
  {
    const refs = refSegs();
    const entries = parseBannedPack('- 最好').pack.entries;
    const withHit = validateDrafts(refs as any, [draft(1, (segs) => [{ ...segs[0], copyText: '这段话里出现了最好这个词' }, ...segs.slice(1)])] as any, 1).drafts;
    const probs = checkBannedWordHits(withHit, entries);
    ok('命中产生 BANNED_WORD_HIT 问题项', probs.length === 1 && probs[0].code === 'BANNED_WORD_HIT');
    ok('严重度为 warn（不阻断保存与选定）', probs[0]?.severity === 'warn');
    ok('问题项指出具体段号', probs[0]?.orderIndex === 1);
    ok('稿子上打了命中标记', withHit[0]?.problemFlags.includes('BANNED_WORD_HIT') === true);

    const clean = validateDrafts(refs as any, [draft(1)] as any, 1).drafts;
    ok('没有命中则无问题项', checkBannedWordHits(clean, entries).length === 0);
    ok('没有配置词表则整项检查跳过', checkBannedWordHits(withHit, []).length === 0);
  }

  group('禁用表达进提示词：位置在参考段之前，未配置时整块不出现');
  {
    const rules = buildRewriteRules();
    ok('规则里含「禁用表达」红线一节', rules.includes('# 禁用表达（红线'));
    ok('规则里含变体规避禁令', rules.includes('同音字'));

    const base: any = {
      platform: 'WECHAT_CHANNELS',
      platformLabel: '微信视频号',
      variantCount: 1,
      refSegments: [{ id: 'r1', orderIndex: 1, tag: '人设', copyText: '参考段正文' }],
      ipProfileText: '资料包正文',
      ipProfileVersion: 1,
      videoInsightText: '',
      formLabel: '真人',
      durationMs: 1000,
      rules,
    };
    const withBanned = buildRewriteUserMessage({ ...base, bannedWordsText: '### 禁用表达\n- 最好', bannedPackVersion: 1 });
    ok('配置了词表时出现禁用表达块', withBanned.includes('## 禁用表达'));
    ok(
      '禁用表达排在参考段之前（约束先于素材）',
      withBanned.indexOf('## 禁用表达') < withBanned.indexOf('## 参考版本分段'),
    );
    ok('结尾复述里也提到禁用表达', withBanned.includes('禁用表达'));

    const without = buildRewriteUserMessage({ ...base, bannedWordsText: '', bannedPackVersion: null });
    // 注意：规则正文里常驻「禁用表达（红线…）」这句（它是永远的约束），
    // 所以这里只能断言**词表块标题**不出现，不能拿「禁用表达」三字去搜。
    ok('未配置时提示词里没有词表块', !without.includes('## 禁用表达'));
    ok('未配置时结尾复述不吓唬人', !without.includes('一个都不许出现'));
    ok('但红线规则本身照常在（不因没词表而消失）', without.includes('# 禁用表达（红线'));
  }

  group('导出类型归一（A20：不改动原有两种导出）');
  {
    ok('SCRIPT 保持 SCRIPT', normalizeExportKind('SCRIPT') === EXPORT_KIND.SCRIPT);
    ok('LIBRARY 保持 LIBRARY', normalizeExportKind('LIBRARY') === EXPORT_KIND.LIBRARY);
    ok('REWRITE 识别为 REWRITE', normalizeExportKind('REWRITE') === EXPORT_KIND.REWRITE);
    ok('非法值退化为 LIBRARY（不静默换类型）', normalizeExportKind('SOMETHING') === EXPORT_KIND.LIBRARY);
    ok('空值退化为 LIBRARY', normalizeExportKind(undefined) === EXPORT_KIND.LIBRARY);
  }
}

// ---------------------------------------------------------------------------
// 二、库层与业务约束（A01 / A11 / A12 / A14 / A16 / A18 / A19 / A22）
// ---------------------------------------------------------------------------
async function seedTestFixture() {
  const owner = await prisma.user.findFirst({ where: { role: 'MAINTAINER' } });
  if (!owner) throw new Error('找不到维护人员账号，请先 npm run db:seed');

  // 复用现有资料包（不新建，避免多花一次结构化费用）
  const profile = await prisma.ipProfileRevision.findFirst({ where: { ownerId: owner.id, status: 'ACTIVE' } });
  if (!profile) throw new Error('找不到生效的 IP 资料包，请先 npm run rewrite:profile <文件>');

  const video = await prisma.video.create({
    data: {
      ownerId: owner.id,
      title: `${PREFIX} 验收用参考视频`,
      sourceTitle: `${PREFIX} 验收用参考视频.mp4`,
      sourceType: 'LOCAL',
      status: 'COMPLETED',
      durationMs: 70_000,
    },
  });
  const revision = await prisma.scriptRevision.create({
    data: {
      videoId: video.id,
      versionNo: 1,
      isCurrent: true,
      reviewStatus: 'CONFIRMED',
      savedAt: new Date(),
      transcriptText: refSegs().map((r) => r.copyText).join(''),
      segments: {
        create: refSegs().map((r, i) => ({
          orderIndex: r.orderIndex,
          startMs: i * 10_000,
          endMs: (i + 1) * 10_000,
          copyText: r.copyText,
          tag: r.tag,
        })),
      },
    },
  });

  return { owner, video, revision, profile };
}

async function libraryAssertions() {
  const fx = await seedTestFixture();
  const { owner, video, revision } = fx;
  // 真实的参考段 id：生成段若引用编造的 id 会直接撞外键约束（这本身也说明引用必须落到真实段落）
  const realSegs = await prisma.segment.findMany({ where: { revisionId: revision.id }, orderBy: { orderIndex: 'asc' } });

  group('参考稿不可用的情形被如实拒绝（A06）');
  {
    // 把某段正文清空 → buildRewriteInput 应明确报「有几段没有正文」，而不是静默跳过
    const segs = await prisma.segment.findMany({ where: { revisionId: revision.id }, orderBy: { orderIndex: 'asc' } });
    await prisma.segment.update({ where: { id: segs[2].id }, data: { copyText: '' } });
    let msg = '';
    try {
      const { buildRewriteInput } = await import('../src/lib/rewrite/service');
      await buildRewriteInput({ ownerId: owner.id, sourceVideoId: video.id });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    ok('有段落缺正文 → 明确报出并拒绝生成', msg.includes('没有正文'), msg);
    await prisma.segment.update({ where: { id: segs[2].id }, data: { copyText: refSegs()[2].copyText } });
  }

  group('生成任务的幂等键（A16：重复请求只关联一个任务）');
  let jobId = '';
  {
    const clientKey = `${PREFIX}-idem`;
    const job = await prisma.rewriteJob.create({
      data: {
        ownerId: owner.id,
        sourceVideoId: video.id,
        sourceRevisionId: revision.id,
        platform: 'WECHAT_CHANNELS',
        variantCount: 1,
        ipProfileRevisionId: fx.profile.id,
        modelId: 'verify-stub',
        inputSnapshot: JSON.stringify({ refSegments: refSegs(), sourceInsight: '', formLabel: '真人' }),
        status: 'SUCCEEDED',
        clientKey,
      },
    });
    jobId = job.id;

    const before = await prisma.modelUsage.count({ where: { rewriteJobId: job.id } });
    const r = await generateRewrite({ ownerId: owner.id, sourceVideoId: video.id, clientKey, variantCount: 1 });
    const after = await prisma.modelUsage.count({ where: { rewriteJobId: job.id } });
    ok('同 clientKey 再次请求 → 回放原任务', r.jobId === job.id);
    ok('回放不产生任何新的模型调用', before === after && after === 0);
    ok('回放带明确的问题项说明', r.problems.some((p) => p.code === 'REWRITE_IDEMPOTENT_REPLAY'));
  }

  group('编辑保存的乐观锁（A10）');
  {
    const variant = await prisma.rewriteVariant.create({
      data: {
        jobId,
        variantNo: 1,
        diffSummary: '验收用',
        revisions: {
          create: {
            revisionNo: 1,
            createdBy: 'AI',
            transcriptText: refSegs().map((r) => `初稿${r.orderIndex}`).join(''),
            charCount: 14,
            estimatedDurationMs: 3000,
            segments: {
              create: refSegs().map((r, i) => ({
                orderIndex: r.orderIndex,
                sourceSegmentId: realSegs[i].id,
                tag: r.tag,
                copyText: `初稿${r.orderIndex}`,
                factRefs: '[]',
              })),
            },
          },
        },
      },
      include: { revisions: true },
    });
    await prisma.rewriteVariant.update({ where: { id: variant.id }, data: { currentRevisionId: variant.revisions[0].id } });

    const base = variant.revisions[0].id;
    const segs = await prisma.rewriteSegment.findMany({ where: { revisionId: base }, orderBy: { orderIndex: 'asc' } });

    const good = await saveVariantRevision({
      ownerId: owner.id,
      variantId: variant.id,
      baseRevisionId: base,
      segments: segs.map((s, i) => ({ orderIndex: s.orderIndex, tag: s.tag, copyText: i === 0 ? '改过的第一段' : s.copyText })),
    });
    ok('合法编辑 → 保存为新修订', good.ok === true && good.revisionNo === 2);

    const conflict = await saveVariantRevision({
      ownerId: owner.id,
      variantId: variant.id,
      baseRevisionId: base, // 故意用旧基准
      segments: segs.map((s) => ({ orderIndex: s.orderIndex, tag: s.tag, copyText: s.copyText })),
    });
    ok('用过期基准保存 → 冲突被拒（不覆盖）', conflict.ok === false && conflict.conflict === true);

    const cur = await prisma.rewriteVariant.findUnique({ where: { id: variant.id } });
    const curRev = await prisma.rewriteRevision.findUnique({ where: { id: cur!.currentRevisionId! } });
    ok('当前生效修订仍是上一步保存的（冲突方未写入）', curRev?.revisionNo === 2);

    const countErr = await saveVariantRevision({
      ownerId: owner.id,
      variantId: variant.id,
      baseRevisionId: cur!.currentRevisionId!,
      segments: segs.map((s) => ({ orderIndex: s.orderIndex, tag: s.tag, copyText: s.copyText })).slice(0, 6),
    });
    ok('增删段落被拒（严格结构）', countErr.ok === false && !countErr.conflict && countErr.message.includes('段数'));

    const tagErr = await saveVariantRevision({
      ownerId: owner.id,
      variantId: variant.id,
      baseRevisionId: cur!.currentRevisionId!,
      segments: segs.map((s, i) => ({ orderIndex: s.orderIndex, tag: i === 1 ? '福利' : s.tag, copyText: s.copyText })),
    });
    ok('改标签被拒', tagErr.ok === false && tagErr.message.includes('标签'));
  }

  group('数字人任务：未选定不得提交（A12）');
  {
    const job = await prisma.rewriteJob.findUnique({ where: { id: jobId }, include: { variants: true } });
    const variant = job!.variants[0];
    const cur = await prisma.rewriteVariant.findUnique({ where: { id: variant.id } });
    let msg = '';
    try {
      await createAvatarJob({ ownerId: owner.id, revisionId: cur!.currentRevisionId!, idempotencyKey: `${PREFIX}-no-select` });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    ok('未选定 → 拒绝创建数字人任务', msg.includes('尚未选定'), msg);
  }

  group('数字人任务：提交文本 = 选定正文按序拼接（A14）');
  let avatarJobId = '';
  let selectedRevisionId = '';
  {
    const job = await prisma.rewriteJob.findUnique({ where: { id: jobId }, include: { variants: true } });
    const variant = job!.variants[0];
    const cur = await prisma.rewriteVariant.findUnique({ where: { id: variant.id } });
    selectedRevisionId = cur!.currentRevisionId!;

    await prisma.rewriteSelection.create({
      data: { jobId, variantId: variant.id, revisionId: selectedRevisionId, selectedById: owner.id },
    });

    const created = await createAvatarJob({
      ownerId: owner.id,
      revisionId: selectedRevisionId,
      idempotencyKey: `${PREFIX}-avatar-1`,
    });
    avatarJobId = created.jobId;

    const rev = await prisma.rewriteRevision.findUnique({
      where: { id: selectedRevisionId },
      include: { segments: { orderBy: { orderIndex: 'asc' } } },
    });
    const expected = rev!.segments.map((s) => s.copyText).join('');
    ok('提交文本等于各段正文按序拼接', created.textSnapshot === expected);
    ok('提交文本不含标签等非口播内容', !rev!.segments.some((s) => s.tag && created.textSnapshot.includes(`[${s.tag}]`)));

    const again = await createAvatarJob({
      ownerId: owner.id,
      revisionId: selectedRevisionId,
      idempotencyKey: `${PREFIX}-avatar-1`,
    });
    ok('同幂等键重复请求 → 回放同一任务（双击不重复提交）', again.replayed === true && again.jobId === avatarJobId);
  }

  group('数字人任务：文本超上限时提示而不自动拆分（§7.3）');
  {
    const big = await prisma.rewriteJob.create({
      data: {
        ownerId: owner.id,
        sourceVideoId: video.id,
        platform: 'WECHAT_CHANNELS',
        variantCount: 1,
        modelId: 'verify-stub',
        inputSnapshot: '{}',
        status: 'SUCCEEDED',
      },
    });
    const v = await prisma.rewriteVariant.create({ data: { jobId: big.id, variantNo: 1 } });
    const rev = await prisma.rewriteRevision.create({
      data: {
        variantId: v.id,
        revisionNo: 1,
        createdBy: 'AI',
        transcriptText: 'x',
        segments: { create: [{ orderIndex: 1, tag: '其他', copyText: '字'.repeat(cfg.avatar.maxTextChars + 10) }] },
      },
    });
    await prisma.rewriteVariant.update({ where: { id: v.id }, data: { currentRevisionId: rev.id } });
    await prisma.rewriteSelection.create({ data: { jobId: big.id, variantId: v.id, revisionId: rev.id, selectedById: owner.id } });

    let msg = '';
    try {
      await createAvatarJob({ ownerId: owner.id, revisionId: rev.id, idempotencyKey: `${PREFIX}-too-long` });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    ok('超限 → 明确报出错并提示编导处理', msg.includes('超过平台单次文本上限'), msg);
    ok('未自动拆分出第二个任务', (await prisma.avatarVideoJob.count({ where: { ownerId: owner.id, idempotencyKey: `${PREFIX}-too-long` } })) === 0);
  }

  group('数字人任务状态迁移与成品校验（Mock 适配器，A17 / A18 / A21）');
  {
    const { advanceAvatarJob } = await import('../src/lib/avatar/service');
    const statuses: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const s = await advanceAvatarJob(avatarJobId);
      statuses.push(s);
      if (s === 'SUCCEEDED' || s === 'FAILED' || s === 'NEEDS_REVIEW') break;
    }
    const final = await prisma.avatarVideoJob.findUnique({ where: { id: avatarJobId }, include: { assets: true } });
    ok('任务最终成功', final?.status === 'SUCCEEDED', `实际状态：${final?.status}（过程：${statuses.join(' → ')}）`);
    ok('过程中出现「平台生成中」状态（真实等待被记录）', statuses.includes('VENDOR_RUNNING'), statuses.join(' → '));
    ok('产出了成品记录', (final?.assets.length ?? 0) === 1);
    ok('成品时长非零', (final?.assets[0]?.durationMs ?? 0) > 0);
    ok('成品含音轨', final?.assets[0]?.hasAudio === true);
    ok('成品落库了文件校验值', !!final?.assets[0]?.sha256);
    ok('成品文件在服务器上确实存在', !!final?.assets[0]?.filePath && fs.existsSync(final!.assets[0]!.filePath));

    // A21：数字人等待不改写来源视频状态、也不占用视频分析队列
    const afterVideo = await prisma.video.findUnique({ where: { id: video.id } });
    ok('数字人任务未改写参考视频状态（A21）', afterVideo?.status === 'COMPLETED');
    const attempts = await prisma.attempt.count({ where: { videoId: video.id } });
    ok('数字人任务未向视频分析队列插入任何执行尝试（A21）', attempts === 0);
  }

  group('数字人任务：结果不明走待核对，不自动重提（A16）');
  {
    const { advanceAvatarJob } = await import('../src/lib/avatar/service');
    // Mock 里用作品名触发「提交结果不明」需要走 submit，这里直接用 [uncertain] 语义造一个任务
    const job = await prisma.avatarVideoJob.create({
      data: {
        ownerId: owner.id,
        rewriteRevisionId: selectedRevisionId,
        textSnapshot: '验收用文本',
        paramsSnapshot: '{}',
        idempotencyKey: `${PREFIX}-uncertain`,
        businessName: 'VSA-verify-[uncertain]',
        status: 'QUEUED',
      },
    });
    const s = await advanceAvatarJob(job.id);
    const after = await prisma.avatarVideoJob.findUnique({ where: { id: job.id } });
    ok('提交结果不明 → 进入「结果待核对」', s === 'NEEDS_REVIEW' && after?.status === 'NEEDS_REVIEW');
    ok('记录了对账说明供人工核对', (after?.reconcileNote ?? '').length > 0);
    ok('未自动创建第二个提交任务', (await prisma.avatarVideoJob.count({ where: { ownerId: owner.id, rewriteRevisionId: selectedRevisionId, idempotencyKey: { startsWith: `${PREFIX}-uncertain` } } })) === 1);
  }

  /**
   * 2026-09-21 修的 bug：从未提交过的任务点「重新核对平台记录」，
   * 平台当然查不到（因为压根没提交），旧代码把这个 NOT_FOUND 写成「结果待核对 /
   * 找不到对应作品记录」，用户去平台翻记录只会更糊涂；真因是数字人进程没在跑。
   */
  group('从未提交的任务：核对不得伪造成「结果待核对」');
  {
    const { reconcileAvatarJob } = await import('../src/lib/avatar/service');

    // ① 排队中、从未提交 → 核对只应如实说明「还没提交」，状态不动
    const queued = await prisma.avatarVideoJob.create({
      data: {
        ownerId: owner.id,
        rewriteRevisionId: selectedRevisionId,
        textSnapshot: '验收用文本',
        paramsSnapshot: '{}',
        idempotencyKey: `${PREFIX}-never-queued`,
        businessName: 'VSA-verify-never-queued',
        status: 'QUEUED',
      },
    });
    const r1 = await reconcileAvatarJob(owner.id, queued.id);
    const q1 = await prisma.avatarVideoJob.findUnique({ where: { id: queued.id } });
    ok('排队中核对 → 明确「尚未提交」', (r1 as { notSubmitted?: boolean }).notSubmitted === true, JSON.stringify(r1).slice(0, 160));
    ok('排队中核对 → 不写成「待核对」', q1?.status === 'QUEUED' && q1?.reconcileNote === '', `${q1?.status}/${q1?.reconcileNote}`);

    // ② 被误标为待核对（库里的脏状态）→ 核对时修回排队中，且不再回显误导说明
    const dirty = await prisma.avatarVideoJob.create({
      data: {
        ownerId: owner.id,
        rewriteRevisionId: selectedRevisionId,
        textSnapshot: '验收用文本',
        paramsSnapshot: '{}',
        idempotencyKey: `${PREFIX}-never-dirty`,
        businessName: 'VSA-verify-never-dirty',
        status: 'NEEDS_REVIEW',
        reconcileNote: 'Mock：找不到对应作品记录',
      },
    });
    const r2 = await reconcileAvatarJob(owner.id, dirty.id);
    const q2 = await prisma.avatarVideoJob.findUnique({ where: { id: dirty.id } });
    ok('脏「待核对」→ 修回排队中', q2?.status === 'QUEUED', `${q2?.status}`);
    ok('清掉误导性的对账说明', q2?.reconcileNote === '', q2?.reconcileNote);
    ok('回执里说明已修复', (r2 as { repaired?: boolean }).repaired === true);
  }

  /**
   * 幂等键是「每次点击」生成的，所以连点两次能绕过「同键回放」；
   * 而两条任务引用同一份正文，切到真实适配器后会**两份都提交、重复计费**。
   * 这里用一条**独立修订**（不与其他分组共用）来隔离断言。
   */
  group('同一修订不会出现两条在途任务（避免切真实适配器后重复计费）');
  {
    // 前面几组只动过第 1 版（fixture 任务只建了 1 版），这里**新建一整版**做隔离，
    // 免得把它们的 currentRevisionId / 选定记录搅乱。
    const variant = await prisma.rewriteVariant.create({ data: { jobId, variantNo: 99, diffSummary: '验收用·去重' } });
    const freshRevision = async () => {
      const rev = await prisma.rewriteRevision.create({
        data: {
          variantId: variant.id,
          revisionNo: 1,
          createdBy: 'HUMAN',
          transcriptText: '验收用正文',
          charCount: 6,
          estimatedDurationMs: 2000,
          segments: { create: [{ orderIndex: 1, tag: '其他', copyText: '验收用正文一二三四', factRefs: '[]' }] },
        },
      });
      await prisma.rewriteVariant.update({ where: { id: variant.id }, data: { currentRevisionId: rev.id } });
      await prisma.rewriteSelection.create({ data: { jobId, variantId: variant.id, revisionId: rev.id, selectedById: owner.id } });
      return rev.id;
    };

    const revId = await freshRevision();
    const a = await createAvatarJob({ ownerId: owner.id, revisionId: revId, idempotencyKey: `${PREFIX}-dedupe-a` });
    // 换一个幂等键（等价于「又点了一次按钮」）：不得再建第二条
    const b = await createAvatarJob({ ownerId: owner.id, revisionId: revId, idempotencyKey: `${PREFIX}-dedupe-b` });
    ok('第二次点击 → 复用同一条在途任务', b.jobId === a.jobId && b.replayed === true, `${a.jobId} vs ${b.jobId}`);
    ok(
      '库里确实只有一条在途任务',
      (await prisma.avatarVideoJob.count({
        where: { ownerId: owner.id, rewriteRevisionId: revId, idempotencyKey: { in: [`${PREFIX}-dedupe-a`, `${PREFIX}-dedupe-b`] } },
      })) === 1,
    );

    // 详情接口靠它把数字人卡片带回界面：刷新/重进页面后仍能看到任务状态与成品
    const { latestAvatarJobIdForRewriteJob } = await import('../src/lib/avatar/service');
    ok('任务详情能回填最近一条数字人任务 id', (await latestAvatarJobIdForRewriteJob(owner.id, jobId)) === a.jobId);
    const emptyJob = await prisma.rewriteJob.create({
      data: {
        ownerId: owner.id,
        sourceVideoId: video.id,
        platform: 'WECHAT_CHANNELS',
        variantCount: 1,
        modelId: 'verify-stub',
        inputSnapshot: '{}',
        status: 'SUCCEEDED',
        clientKey: `${PREFIX}-no-avatar`,
      },
    });
    ok('没建过数字人任务的改写任务 → 回填 null', (await latestAvatarJobIdForRewriteJob(owner.id, emptyJob.id)) === null);

    // 终态（失败）允许重来，否则编导没法重试
    await prisma.avatarVideoJob.update({ where: { id: a.jobId }, data: { status: 'FAILED', finishedAt: new Date() } });
    const c = await createAvatarJob({ ownerId: owner.id, revisionId: revId, idempotencyKey: `${PREFIX}-dedupe-c` });
    ok('上一条已失败 → 允许重新建任务（不把编导堵死）', c.jobId !== a.jobId && c.replayed === false);
  }

  group('提交成功但没读回作品 ID：不得判成「待核对」，也不得再提交一次（2026-09-21 实测）');
  {
    const { advanceAvatarJob } = await import('../src/lib/avatar/service');
    const { readMockSubmissions } = await import('../src/lib/avatar/mock');

    /** 作品名必须带 [no-id]，Mock 才会走「提交成功但不返回 ID」那条分支 */
    const mk = async (tag: string, status: string, submittedAt: Date | null) => {
      const bname = `${PREFIX}-[no-id]-${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 9999)}`;
      const v = await prisma.rewriteVariant.create({ data: { jobId, variantNo: 200 + Math.floor(Math.random() * 700) } });
      const rev = await prisma.rewriteRevision.create({
        data: {
          variantId: v.id,
          revisionNo: 1,
          createdBy: 'HUMAN',
          transcriptText: '验收用正文',
          charCount: 6,
          segments: { create: [{ orderIndex: 1, tag: '其他', copyText: '验收用正文一二三四', factRefs: '[]' }] },
        },
      });
      await prisma.rewriteVariant.update({ where: { id: v.id }, data: { currentRevisionId: rev.id } });
      await prisma.rewriteSelection.create({ data: { jobId, variantId: v.id, revisionId: rev.id, selectedById: owner.id } });
      const aj = await prisma.avatarVideoJob.create({
        data: {
          ownerId: owner.id,
          rewriteRevisionId: rev.id,
          textSnapshot: '验收用正文一二三四',
          paramsSnapshot: '{}',
          idempotencyKey: `${bname}`,
          businessName: bname,
          status,
          submittedAt,
          attemptCount: submittedAt ? 1 : 0,
        },
      });
      return { id: aj.id, bname };
    };

    // ① 提交成功、平台有作品，只是没读回 ID → 应当是「平台生成中」，而不是「结果待核对」
    const a = await mk('a', 'QUEUED', null);
    const s1 = await advanceAvatarJob(a.id);
    ok('没读回 ID 但有明确提交结论 → 进入「平台生成中」而非「待核对」', s1 === 'VENDOR_RUNNING', `实际 ${s1}`);
    const r1 = await prisma.avatarVideoJob.findUnique({ where: { id: a.id } });
    ok('未误判为结果不明', r1?.errorCode !== 'AVATAR_SUBMIT_UNCERTAIN', String(r1?.errorCode));

    // ② 后续按唯一作品名查询能把平台作品 ID 补回来（真实平台的作品 ID 只能从列表里读）
    const s2 = await advanceAvatarJob(a.id);
    const r2 = await prisma.avatarVideoJob.findUnique({ where: { id: a.id } });
    ok('后续查询补回平台作品 ID', !!r2?.vendorJobId, String(r2?.vendorJobId));
    ok('补回 ID 后仍在推进（未被打回待核对）', s2 === 'VENDOR_RUNNING' || s2 === 'SUCCEEDED', `实际 ${s2}`);

    /**
     * ③ 红线：已经提交过的任务（submittedAt 有值），即使状态因会话失效变成「待登录」、
     *    且 vendorJobId 还空着，也**不得**再提交一次 —— 否则同一稿件出两条片、重复计费。
     */
    const b = await mk('b', 'NEEDS_LOGIN', new Date());
    const countOf = (name: string) => readMockSubmissions().filter((r) => r.businessName === name).length;
    const before = countOf(b.bname);
    await advanceAvatarJob(b.id).catch(() => undefined);
    const afterCount = countOf(b.bname);
    ok('已提交过的任务不会被再提交一次（不重复计费）', afterCount === before, `提交记录 ${before} → ${afterCount}`);
    const r3 = await prisma.avatarVideoJob.findUnique({ where: { id: b.id } });
    ok('该任务没有被重新推进到「正在提交」', r3?.status !== 'SUBMITTING', String(r3?.status));
    ok('提交次数没有被悄悄加一', r3?.attemptCount === 1, String(r3?.attemptCount));
  }

  /**
   * 人工接手（`AVATAR_SUBMIT_MODE=assist`）—— 2026-09-22 新增的第二条提交路径。
   *
   * 与 auto 的差别只在「取消」怎么判定：assist 的适配器是**查过平台作品列表**之后
   * 才敢报 cancelled，所以那是确定结论，允许直接清 `submittedAt` 重来；
   * auto 那条路绝不敢这么做（会话过期 + 没读回 ID 就会重复提交、重复计费）。
   * 这组断言把这条差别钉死，免得以后有人「顺手统一」两边的处理。
   */
  group('人工接手模式：确定没提交 → 允许重来；会话查不了 → 待核对（2026-09-22 新增）');
  {
    const { advanceAvatarJob, reconcileAvatarJob, createAvatarJob: createJob } = await import('../src/lib/avatar/service');
    const { readMockSubmissions } = await import('../src/lib/avatar/mock');
    const modeBackup = cfg.avatar.submitMode;
    /**
     * `cfg` 是 `as const`，类型层面只读；运行期就是个普通对象。
     * 这里用局部可变别名临时切到 assist，跑完 finally 还原 —— 不去为「能被测试改」
     * 而在生产代码里开一个可写口子。
     */
    const avatarCfg = cfg.avatar as { submitMode: 'auto' | 'assist' };
    avatarCfg.submitMode = 'assist';
    try {
      /** 造一条独立的「已选定」修订，并按需直接落一条数字人任务 */
      const mk = async (tag: string) => {
        const bname = `${PREFIX}-${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 9999)}`;
        const v = await prisma.rewriteVariant.create({ data: { jobId, variantNo: 300 + Math.floor(Math.random() * 600) } });
        const rev = await prisma.rewriteRevision.create({
          data: {
            variantId: v.id,
            revisionNo: 1,
            createdBy: 'HUMAN',
            transcriptText: '验收用正文',
            charCount: 6,
            segments: { create: [{ orderIndex: 1, tag: '其他', copyText: '验收用正文一二三四', factRefs: '[]' }] },
          },
        });
        await prisma.rewriteVariant.update({ where: { id: v.id }, data: { currentRevisionId: rev.id } });
        await prisma.rewriteSelection.create({ data: { jobId, variantId: v.id, revisionId: rev.id, selectedById: owner.id } });
        const aj = await prisma.avatarVideoJob.create({
          data: {
            ownerId: owner.id,
            rewriteRevisionId: rev.id,
            textSnapshot: '验收用正文一二三四',
            paramsSnapshot: '{}',
            idempotencyKey: bname,
            businessName: bname,
            status: 'QUEUED',
          },
        });
        return { id: aj.id, bname, revisionId: rev.id };
      };

      // ① 人工接手未完成提交（关闭了平台窗口）→ 确定没提交
      const cancelled = await mk('[assist-cancel]');
      const s1 = await advanceAvatarJob(cancelled.id);
      const r1 = await prisma.avatarVideoJob.findUnique({ where: { id: cancelled.id } });
      ok('人工接手未完成 → 进入「人工接手已取消」', s1 === 'ASSIST_CANCELLED' && r1?.status === 'ASSIST_CANCELLED', `实际 ${s1}`);
      ok(
        'Mock 里确实没有这条提交记录（「取消」不是猜的，是查过没有）',
        readMockSubmissions().filter((x) => x.businessName === cancelled.bname).length === 0,
      );
      ok('取消即清空 submittedAt（否则红线会反过来堵死重来）', r1?.submittedAt === null, String(r1?.submittedAt));
      ok('取消即把提交次数归零', r1?.attemptCount === 0, String(r1?.attemptCount));
      ok('取消不留「待核对说明」（它不是待核对）', r1?.reconcileNote === '', String(r1?.reconcileNote));
      ok('取消不作为失败展示（走独立错误码，界面上不是「生成失败」）', r1?.errorCode === 'AVATAR_ASSIST_CANCELLED', String(r1?.errorCode));
      ok('保留取消原因（关闭窗口 / 超时）供人看清为什么没提交', (r1?.errorMessage ?? '').length > 0, String(r1?.errorMessage));

      // ② 取消之后必须能重新发起 —— 不能因为「防重复提交」把正常重试堵死
      //    （这里**故意不**先把状态改回 QUEUED：要验的就是「已取消」这个状态本身不算在途）
      const again = await createJob({
        ownerId: owner.id,
        revisionId: cancelled.revisionId,
        idempotencyKey: `${PREFIX}-assist-retry`,
      });
      ok('取消后可以再次发起（不被当作在途任务挡下）', again.replayed === false && again.jobId !== cancelled.id);

      // ③ 对「已取消」点核对：结论应是「无需核对」，状态不许被翻成待核对
      const rec = await reconcileAvatarJob(owner.id, cancelled.id);
      const r3 = await prisma.avatarVideoJob.findUnique({ where: { id: cancelled.id } });
      ok('已取消的任务 → 核对回执明确「未提交、无需核对」', (rec as { cancelled?: boolean }).cancelled === true, JSON.stringify(rec).slice(0, 160));
      ok('核对不得把「已取消」翻成「待核对」', r3?.status === 'ASSIST_CANCELLED', String(r3?.status));
      ok('核对不得留下「请确认数字人进程在运行」这种答错方向的文案', !String((rec as { message?: string }).message).includes('进程'), String((rec as { message?: string }).message));

      // ④ 人工接手结束但会话失效、查不了作品列表 → 只能如实说「结果不明」
      const uncertain = await mk('[assist-uncertain]');
      const s4 = await advanceAvatarJob(uncertain.id);
      const r4 = await prisma.avatarVideoJob.findUnique({ where: { id: uncertain.id } });
      ok('查不了作品列表 → 进入「结果待核对」', s4 === 'NEEDS_REVIEW' && r4?.status === 'NEEDS_REVIEW', `实际 ${s4}`);
      ok('留下了对账说明供人工核对', (r4?.reconcileNote ?? '').length > 0);
      ok('待核对的提交不被当成取消（两者不能混）', r4?.status !== 'ASSIST_CANCELLED');

      // ⑤ 正常人工接手（编导点了生成视频）→ 按「已提交」推进
      const ok1 = await mk('assist-ok');
      const s5 = await advanceAvatarJob(ok1.id);
      const r5 = await prisma.avatarVideoJob.findUnique({ where: { id: ok1.id } });
      ok('人工接手完成提交 → 进入「平台生成中」', s5 === 'VENDOR_RUNNING' && r5?.status === 'VENDOR_RUNNING', `实际 ${s5}`);
      ok(
        '这条路留下了提交记录（与「取消」形成对照）',
        readMockSubmissions().filter((x) => x.businessName === ok1.bname).length === 1,
      );
      ok('提交成功即清掉错误信息', !r5?.errorCode && !r5?.errorMessage);

      // ⑥ 分流是按配置走的：auto 模式下同一条任务名不会被当成「人工接手取消」
      avatarCfg.submitMode = 'auto';
      const autoJob = await mk('[assist-cancel]-auto');
      const s6 = await advanceAvatarJob(autoJob.id);
      ok('auto 模式不受 assist 分支影响（同一条任务照常走全自动提交）', s6 === 'VENDOR_RUNNING', `实际 ${s6}`);
      ok(
        'auto 模式确实落了提交记录',
        readMockSubmissions().filter((x) => x.businessName === autoJob.bname).length === 1,
      );
    } finally {
      avatarCfg.submitMode = modeBackup;
    }
  }

  /**
   * 作品在平台上被改名 —— 2026-09-22 真实事故的回归。
   *
   * 事故形状：assist 提交**成功**（平台上确实出了片，作品 ID 12857），但编导随手把作品名
   * 改成了「信息流编导工作台测试_1」；而我们对账只认自己的唯一作品名，于是再也找不到那条作品 ——
   * 一条已经出片的任务被判成「确定没提交」，`submittedAt` 与 `attemptCount` 一起被清空。
   * 判错的方向最危险：丢掉一条真出片的交付，还放开了一次重复计费的重提。
   *
   * 这一组钉两件事：
   *   ① 改名场景**不许**判「确定没提交」，要退回「结果待核对」并保住提交痕迹；
   *   ② 必须能按**平台作品 ID**（不随改名变化）把作品接回任务，接回后一路推进到取回成品。
   */
  group('作品被改名：不许判「确定没提交」，且能按平台作品 ID 接回（2026-09-22 事故回归）');
  {
    const { advanceAvatarJob, bindAvatarJobWork, listPlatformWorks } = await import('../src/lib/avatar/service');
    const modeBackup = cfg.avatar.submitMode;
    const avatarCfg = cfg.avatar as { submitMode: 'auto' | 'assist' };
    avatarCfg.submitMode = 'assist';
    try {
      const bname = `${PREFIX}-[assist-renamed]-${Date.now().toString(36)}`;
      const v = await prisma.rewriteVariant.create({ data: { jobId, variantNo: 300 + Math.floor(Math.random() * 600) } });
      const rev = await prisma.rewriteRevision.create({
        data: {
          variantId: v.id,
          revisionNo: 1,
          createdBy: 'HUMAN',
          transcriptText: '验收用正文',
          charCount: 6,
          segments: { create: [{ orderIndex: 1, tag: '其他', copyText: '验收用正文一二三四', factRefs: '[]' }] },
        },
      });
      await prisma.rewriteVariant.update({ where: { id: v.id }, data: { currentRevisionId: rev.id } });
      await prisma.rewriteSelection.create({ data: { jobId, variantId: v.id, revisionId: rev.id, selectedById: owner.id } });
      const aj = await prisma.avatarVideoJob.create({
        data: {
          ownerId: owner.id,
          rewriteRevisionId: rev.id,
          textSnapshot: '验收用正文一二三四',
          paramsSnapshot: '{}',
          idempotencyKey: bname,
          businessName: bname,
          status: 'QUEUED',
        },
      });

      const s1 = await advanceAvatarJob(aj.id);
      const r1 = await prisma.avatarVideoJob.findUnique({ where: { id: aj.id } });
      ok('改名场景不判「确定没提交」，退回「结果待核对」', s1 === 'NEEDS_REVIEW' && r1?.status === 'NEEDS_REVIEW', `实际 ${s1}`);
      ok('改名场景不能落成「人工接手已取消」', r1?.status !== 'ASSIST_CANCELLED', String(r1?.status));
      ok('改名场景保住 submittedAt（「提交过」这件事不能被抹掉）', r1?.submittedAt !== null, String(r1?.submittedAt));
      ok('改名场景不把提交次数归零（归零等于放开重复提交、重复计费）', r1?.attemptCount === 1, String(r1?.attemptCount));
      ok(
        '对账说明点明「疑似改名」并带上平台作品 ID',
        /改(过)?名/.test(r1?.reconcileNote ?? '') && /mock-renamed-/.test(r1?.reconcileNote ?? ''),
        (r1?.reconcileNote ?? '').slice(0, 180),
      );

      // 平台列表里那条作品显示的名字已经**不是**我们的唯一作品名了 —— 这正是「按名字对不上、按 ID 认得出」
      const works = await listPlatformWorks(20);
      const renamed = works.works.find((w) => (w.vendorJobId ?? '').startsWith('mock-renamed-'));
      ok('从平台作品列表里能读到改名后的那条作品', !!renamed, JSON.stringify(works.works.slice(0, 2)));
      ok('它显示的名字与我们的唯一作品名不同（按名字必然对不上）', !!renamed && !renamed.name.includes(bname), renamed?.name ?? '');
      ok('它有平台作品 ID（改名不改变 ID —— 这就是能接回来的原因）', !!renamed?.vendorJobId, String(renamed?.vendorJobId));

      // 绑定前置校验一：不存在的作品 ID 必须被拒，且不许改库
      const before = await prisma.avatarVideoJob.findUnique({ where: { id: aj.id } });
      let bindErr = '';
      await bindAvatarJobWork(owner.id, aj.id, { workId: 'no-such-work-999999' }).catch((e) => {
        bindErr = String((e as Error).message);
      });
      ok('绑定不存在的作品 → 明确报错（不静默改库）', bindErr.includes('找不到'), bindErr.slice(0, 140));
      const afterFail = await prisma.avatarVideoJob.findUnique({ where: { id: aj.id } });
      ok(
        '绑定失败不改库（状态与平台作品 ID 原样）',
        afterFail?.status === before?.status && afterFail?.vendorJobId === before?.vendorJobId,
        `${afterFail?.status} / ${afterFail?.vendorJobId}`,
      );

      // 绑定前置校验二：空内容（既没 ID 也没作品名）也要拒掉
      let emptyErr = '';
      await bindAvatarJobWork(owner.id, aj.id, {}).catch((e) => {
        emptyErr = String((e as Error).message);
      });
      ok('绑定内容为空 → 明确报错', emptyErr.includes('请填写'), emptyErr.slice(0, 140));

      // 按平台作品 ID 接回
      const b = await bindAvatarJobWork(owner.id, aj.id, { workId: renamed?.vendorJobId ?? '' });
      ok(
        '按平台作品 ID 绑定成功并回到「平台生成中」',
        b.status === 'VENDOR_RUNNING' && b.vendorJobId === renamed?.vendorJobId,
        JSON.stringify(b).slice(0, 180),
      );
      const r2 = await prisma.avatarVideoJob.findUnique({ where: { id: aj.id } });
      ok('绑定补回提交痕迹（attemptCount ≥ 1）', (r2?.attemptCount ?? 0) >= 1, String(r2?.attemptCount));
      ok(
        '绑定写清「接了哪条作品」，便于回溯',
        (r2?.reconcileNote ?? '').includes(String(renamed?.vendorJobId)),
        (r2?.reconcileNote ?? '').slice(0, 180),
      );

      // 接回之后按 ID 继续推进：改名不再影响查询与取回
      const statuses: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const s = await advanceAvatarJob(aj.id);
        statuses.push(s);
        if (s === 'SUCCEEDED' || s === 'FAILED' || s === 'NEEDS_REVIEW') break;
      }
      const fin = await prisma.avatarVideoJob.findUnique({ where: { id: aj.id }, include: { assets: true } });
      ok('接回后能一路推进到「已完成」', fin?.status === 'SUCCEEDED', `${fin?.status}（过程：${statuses.join(' → ')}）`);
      ok('接回后确实取回了成品', (fin?.assets.length ?? 0) === 1);

      // 已有平台作品 ID / 已完成的任务不允许再绑 —— 否则等于把成品指到别的作品上
      let doneErr = '';
      await bindAvatarJobWork(owner.id, aj.id, { workId: renamed?.vendorJobId ?? '' }).catch((e) => {
        doneErr = String((e as Error).message);
      });
      ok('已关联作品的任务拒绝再次绑定', doneErr.includes('已完成') || doneErr.includes('已关联'), doneErr.slice(0, 140));
    } finally {
      avatarCfg.submitMode = modeBackup;
    }
  }

  group('平台生成失败：终态不得残留自相矛盾的进度说明（2026-09-21 真实失败实测）');
  {
    const { advanceAvatarJob } = await import('../src/lib/avatar/service');
    const bname = `${PREFIX}-[fail]-${Date.now().toString(36)}${Math.floor(Math.random() * 9999)}`;
    const v = await prisma.rewriteVariant.create({ data: { jobId, variantNo: 200 + Math.floor(Math.random() * 700) } });
    const rev = await prisma.rewriteRevision.create({
      data: {
        variantId: v.id,
        revisionNo: 1,
        createdBy: 'HUMAN',
        transcriptText: '验收用正文',
        charCount: 6,
        segments: { create: [{ orderIndex: 1, tag: '其他', copyText: '验收用正文一二三四', factRefs: '[]' }] },
      },
    });
    await prisma.rewriteVariant.update({ where: { id: v.id }, data: { currentRevisionId: rev.id } });
    await prisma.rewriteSelection.create({ data: { jobId, variantId: v.id, revisionId: rev.id, selectedById: owner.id } });
    const aj = await prisma.avatarVideoJob.create({
      data: {
        ownerId: owner.id,
        rewriteRevisionId: rev.id,
        textSnapshot: '验收用正文一二三四',
        paramsSnapshot: '{}',
        idempotencyKey: bname,
        businessName: bname,
        status: 'QUEUED',
      },
    });

    const s1 = await advanceAvatarJob(aj.id);
    ok('提交被受理 → 先进入「平台生成中」', s1 === 'VENDOR_RUNNING', `实际 ${s1}`);
    const s2 = await advanceAvatarJob(aj.id);
    ok('平台渲染失败 → 任务置为失败', s2 === 'FAILED', `实际 ${s2}`);

    const r = await prisma.avatarVideoJob.findUnique({ where: { id: aj.id } });
    ok(
      '不残留「待核对说明」（否则卡片上会同时出现「创作中」和「生成失败」）',
      (r?.reconcileNote ?? '') === '',
      JSON.stringify(r?.reconcileNote),
    );
    ok('错误码标明是平台侧失败', r?.errorCode === 'AVATAR_VENDOR_FAILED', String(r?.errorCode));
    ok('失败有终态时间', !!r?.finishedAt);
    ok('平台作品 ID 保留下来（便于人工去平台核对）', !!r?.vendorJobId, String(r?.vendorJobId));
  }

  group('生成中断状态的如实呈现（不干挂 RUNNING）');
  {
    const { listRewriteJobs } = await import('../src/lib/rewrite/service');
    const stallAfter = cfg.rewrite.timeoutMs + 2 * 60 * 1000;
    // 造两条 RUNNING：一条 startedAt 已远超模型超时（=请求被中途打断），一条刚起
    const stale = await prisma.rewriteJob.create({
      data: {
        ownerId: owner.id,
        sourceVideoId: video.id,
        sourceRevisionId: revision.id,
        platform: 'WECHAT_CHANNELS',
        variantCount: 3,
        modelId: 'qwen3.8-flash',
        inputSnapshot: '{}',
        status: 'RUNNING',
        stage: 'REWRITE',
        clientKey: `${PREFIX}-stalled-old`,
        startedAt: new Date(Date.now() - stallAfter - 60_000),
      },
    });
    const fresh = await prisma.rewriteJob.create({
      data: {
        ownerId: owner.id,
        sourceVideoId: video.id,
        sourceRevisionId: revision.id,
        platform: 'WECHAT_CHANNELS',
        variantCount: 3,
        modelId: 'qwen3.8-flash',
        inputSnapshot: '{}',
        status: 'RUNNING',
        stage: 'REWRITE',
        clientKey: `${PREFIX}-stalled-fresh`,
        startedAt: new Date(),
      },
    });
    const list = await listRewriteJobs(owner.id, video.id);
    const byId = new Map(list.map((j) => [j.id, j]));
    ok('超时未完成的 RUNNING 被标为「可能已中断」', byId.get(stale.id)?.stalled === true);
    ok('刚起的 RUNNING 不误报为中断', byId.get(fresh.id)?.stalled === false);
    ok('已完成的任务一律不标中断', list.filter((j) => j.status !== 'RUNNING').every((j) => j.stalled === false));
  }

  group('来源视频删除后新稿与成品留存（A22）');
  {
    // 软删参考视频：稿件与成品必须都还在
    await prisma.video.update({ where: { id: video.id }, data: { deletedAt: new Date() } });
    const stillJob = await prisma.rewriteJob.findUnique({ where: { id: jobId }, include: { variants: { orderBy: { variantNo: 'asc' }, include: { revisions: { include: { segments: true } } } } } });
    ok('已生成的改写稿仍留存', (stillJob?.variants[0]?.revisions[0]?.segments.length ?? 0) > 0);
    const stillAvatar = await prisma.avatarVideoJob.findUnique({ where: { id: avatarJobId }, include: { assets: true } });
    ok('已产出的数字人成品仍留存', (stillAvatar?.assets.length ?? 0) === 1 && fs.existsSync(stillAvatar!.assets[0].filePath));
    ok('来源视频被标记为删除', (await prisma.video.findUnique({ where: { id: video.id } }))?.deletedAt !== null);
  }

  return { owner, videoId: video.id, jobId };
}

// ---------------------------------------------------------------------------
// 三、接口层（A19 归属鉴权）
// ---------------------------------------------------------------------------
async function apiAssertions() {
  group('接口层：归属鉴权（A19）');
  {
    let reachable = true;
    try {
      const r = await fetch(`${API_BASE}/api/videos/nonexistent/rewrites`);
      reachable = r.status !== 0;
      ok('未登录访问生成页接口 → 被拒（401/403/404）', [401, 403, 404].includes(r.status), `实际 ${r.status}`);
    } catch {
      reachable = false;
    }
    if (!reachable) {
      console.log(`  ! 跳过：web 服务未在 ${API_BASE} 上运行（可用 npm run dev:web 后重跑）`);
      return;
    }

    const r2 = await fetch(`${API_BASE}/api/rewrites/nonexistent`);
    ok('未登录访问任务详情 → 被拒', [401, 403, 404].includes(r2.status), `实际 ${r2.status}`);
    const r3 = await fetch(`${API_BASE}/api/avatar-jobs/nonexistent/video`);
    ok('未登录取成品视频 → 被拒', [401, 403, 404].includes(r3.status), `实际 ${r3.status}`);
    const r4 = await fetch(`${API_BASE}/api/ip-profiles`);
    ok('未登录读资料包版本 → 被拒', [401, 403, 404].includes(r4.status), `实际 ${r4.status}`);
  }
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

/**
 * 清掉本脚本造出来的全部数据。
 * 不依赖 fixture（上次跑若在造数据途中异常，fixture 可能是空的），
 * 一律按 `__verify_rewrite__` 前缀去找 —— 前缀是这份数据的唯一标识。
 */
async function purgeVerifyData() {
  const owner = await prisma.user.findFirst({ where: { role: 'MAINTAINER' } });
  if (!owner) return 0;
  let n = 0;

  const byKey = await prisma.rewriteJob.findMany({ where: { ownerId: owner.id, clientKey: { startsWith: PREFIX } } });
  for (const j of byKey) {
    await prisma.rewriteJob.delete({ where: { id: j.id } }).catch(() => undefined);
    n += 1;
  }

  const videos = await prisma.video.findMany({ where: { ownerId: owner.id, title: { startsWith: PREFIX } } });
  for (const v of videos) {
    const jobs = await prisma.rewriteJob.findMany({ where: { sourceVideoId: v.id } });
    for (const j of jobs) {
      await prisma.rewriteJob.delete({ where: { id: j.id } }).catch(() => undefined);
      n += 1;
    }
    await prisma.video.delete({ where: { id: v.id } }).catch(() => undefined);
    n += 1;
  }

  const avatars = await prisma.avatarVideoJob.deleteMany({
    where: { ownerId: owner.id, idempotencyKey: { startsWith: PREFIX } },
  });
  n += avatars.count;

  return n;
}

async function main() {
  console.log('=== 个性化文案 + 数字人 自动验收 ===');
  console.log(`资料包版本上限：${cfg.avatar.maxTextChars} 字；数字人适配器：${cfg.avatar.adapter}`);
  if (!fs.existsSync(path.resolve(process.cwd(), 'data', 'app.db'))) {
    console.error('找不到数据库 data/app.db');
    process.exit(1);
  }

  // 先清历史遗留：上次若中途异常，唯一键与测试视频会挡住本次
  const purged = await purgeVerifyData();
  if (purged > 0) console.log(`（已清理上次遗留的 ${purged} 条验收数据）`);

  unitAssertions();

  let fixture: Awaited<ReturnType<typeof libraryAssertions>> | null = null;
  try {
    fixture = await libraryAssertions();
  } catch (e) {
    fail += 1;
    failures.push(`库层断言异常：${e instanceof Error ? e.message : String(e)}`);
    console.error('\n库层断言异常：', e instanceof Error ? e.message : e);
  }

  if (!UNIT_ONLY) await apiAssertions();

  // 用前缀兜底清理，保证异常路径也不留垃圾（fixture 参数仅用于日志）
  void fixture;
  await purgeVerifyData();
  console.log('\n（已清理本次验收造的测试数据）');

  console.log(`\n=== 结果：通过 ${pass} 项，失败 ${fail} 项 ===`);
  if (failures.length) {
    console.log('失败明细：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  if (fail > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error('验收脚本异常：', e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
