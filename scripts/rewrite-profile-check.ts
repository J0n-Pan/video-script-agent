/**
 * IP 资料包结构化质量体检（只读，不调模型、不落库）。
 *
 * 为什么需要这个脚本：
 * 资料包结构化是**模型行为**，同一份文件连跑三次结果都不一样——
 * 实测同一份 10.7k 字的资料，边界条数 20 → 30 → 40，覆盖率 5 → 7 → 12。
 * 靠肉眼看一遍根本无法判断「换了个提示词 / 换了模型 / 加了分块」到底是变好还是变差。
 * 必须有一把可复现的尺子，改完立刻能比较。
 *
 * 两个方向的判据（缺一不可）：
 *
 * ① 召回（漏没漏）—— 用原文里含否定/禁令措辞的句子做基准。
 *    关键设计：比对的是句子的**否定核心**（从「不得/不能/避免…」起到句末），不是整句。
 *    为什么：模型会把长句压缩成短祈使句（原文「…不能写成所有购买者都会得到的结果」
 *    → 条目「不能写成所有购买者都会得到的结果。」）。用整句算 bigram 覆盖率时，
 *    短条目只占长句的一小部分，覆盖率天然偏低 —— 会把**抽对了的**判成漏抽。
 *    实测同一版资料包：整句判据 16/52，核心判据 40/52；后者才反映真实召回。
 *
 *    ⚠ 判读口径：用户的资料文档里混着两类东西 —— (a) IP 事实与禁令，(b) 给 Agent 的**操作说明**
 *    （「严格按当前保存的参考视频分段生成」「多版本应在同一结构内比较」「示例只能填入…」）。
 *    含否定词的句子会把 (b) 也扫进来，而 (b) 本来就不该进 IP 事实库（它们由 rewrite rules 承载）。
 *    实测 v6 未覆盖 17 句里约 13 句属 (b)。要剔除它们用 --exclude=<正则>，
 *    例如 --exclude="生成|稿件|多版本|数字人|样板|示例"，得到的是「真 IP 边界」的召回率。
 *
 * ② 忠实（编没编）—— 反向检查每个条目能否在原文里找到出处。
 *    条目的字符 bigram 若大量不在原文中出现，说明模型自己造了词（公司名、数字、书名等）。
 *    这是比召回更危险的一类错误：资料包被当作**唯一事实来源**，编出来的事实会被写进稿子。
 *
 * 用法：
 *   npm run rewrite:profile:check                 # 体检当前生效版本
 *   npm run rewrite:profile:check -- --all        # 列出各版本对比
 *   npm run rewrite:profile:check -- --v=5        # 指定版本
 *   npm run rewrite:profile:check -- --min-recall=0.7   # 召回低于阈值时非零退出（供 CI/验收）
 *   npm run rewrite:profile:check -- --show-missing     # 打印未覆盖的原文边界句
 *   npm run rewrite:profile:check -- --exclude="生成|稿件|多版本"   # 剔除资料自带的操作说明句
 */
import { PrismaClient } from '@prisma/client';
import { IP_SECTIONS, type IpSectionKey } from '../src/lib/rewrite/profile';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};
const ALL = args.includes('--all');
const SHOW_MISSING = args.includes('--show-missing');
const WANT_V = flag('v') ? Number(flag('v')) : undefined;
const MIN_RECALL = flag('min-recall') ? Number(flag('min-recall')) : undefined;
/** 剔除资料自带的「操作说明」句（这类句子含否定词但本就不该进 IP 事实库） */
const EXCLUDE = flag('exclude');
let excludeRe: RegExp | undefined;
if (EXCLUDE) {
  try {
    excludeRe = new RegExp(EXCLUDE);
  } catch {
    console.error(`--exclude 不是合法正则：${EXCLUDE}`);
    process.exit(1);
  }
}

/** 判为「边界句」的措辞。与资料包 boundaries 板块的收录范围保持一致。 */
const NEG_MARKERS = [
  '不得',
  '不能',
  '不应',
  '不承诺',
  '不保证',
  '避免',
  '不写成',
  '不要',
  '不把',
  '不改写',
  '不自行',
  '不属于',
];

/** 归一化：抹掉标点空白，只留内容字，避免标点差异影响比对 */
function norm(s: string): string {
  return s.replace(/[\s，,、（）()「」『』“”"':：;；。.!！?？\-—/·|]/g, '');
}

function bigrams(s: string): Set<string> {
  const t = norm(s);
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** a 的内容有多大比例出现在 b 中（0~1） */
function bigramCoverage(a: string, b: string | Set<string>): number {
  const A = bigrams(a);
  if (!A.size) return 0;
  const B = typeof b === 'string' ? bigrams(b) : b;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / A.size;
}

/** 取句子的「否定核心」：从第一个否定标记起到句末 */
function negationCore(sentence: string): string {
  let at = -1;
  for (const m of NEG_MARKERS) {
    const i = sentence.indexOf(m);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  return at < 0 ? sentence : sentence.slice(at);
}

function splitSentences(text: string): string[] {
  return text
    .split(/[\n。；！？]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

type RevRow = {
  versionNo: number;
  status: string;
  title: string;
  rawText: string;
  sections: Record<string, string[]>;
};

function load(row: { versionNo: number; status: string; title: string; rawText: string | null; profileJson: string | null }): RevRow {
  let sections: Record<string, string[]> = {};
  try {
    sections = JSON.parse(row.profileJson || '{}')?.sections ?? {};
  } catch {
    sections = {};
  }
  return {
    versionNo: row.versionNo,
    status: row.status,
    title: row.title,
    rawText: row.rawText ?? '',
    sections,
  };
}

/** 单版本体检 */
function inspect(rev: RevRow) {
  const raw = rev.rawText;
  const rawBigrams = bigrams(raw);

  const sentences = splitSentences(raw);
  const boundarySentences = sentences
    .filter((s) => NEG_MARKERS.some((n) => s.includes(n)))
    .filter((s) => !(excludeRe && excludeRe.test(s)));

  const boundaryItems: string[] = rev.sections.boundaries ?? [];
  const gapItems: string[] = rev.sections.gaps ?? [];
  // 除边界/缺失外的素材类板块：约束本就不该只出现在 boundaries
  // （价格条件归「适用条件与时效信息」、冲突字段归「待统一字段与缺失资料」都是正确归宿）
  const otherItems: string[] = IP_SECTIONS.filter((s) => s.key !== 'boundaries' && s.key !== 'gaps').flatMap(
    (s) => rev.sections[s.key] ?? [],
  );

  /** 句子的否定核心是否被某个条目代表 */
  const matched = (s: string, pool: string[]): boolean => {
    const core = negationCore(s);
    return pool.some(
      (it) => bigramCoverage(core, it) >= 0.5 || norm(it).includes(norm(core)) || norm(core).includes(norm(it)),
    );
  };

  const missing: string[] = [];
  let covered = 0;
  let coveredInBoundaries = 0;
  let coveredElsewhere = 0;
  for (const s of boundarySentences) {
    const inB = matched(s, boundaryItems);
    const inO = !inB && matched(s, [...otherItems, ...gapItems]);
    if (inB) coveredInBoundaries += 1;
    if (inO) coveredElsewhere += 1;
    if (inB || inO) covered += 1;
    else missing.push(s);
  }

  // ② 忠实：条目能否在原文找到出处。
  // 分两档，别把「模型改写压缩」当成「编造」：
  //   cover < 0.5          → 疑似编造（原文里几乎没有对应字面），必须人工核实
  //   0.5 ≤ cover < 0.85   → 压缩改写（同义替换、抽关键词），抽查即可
  // 为什么不能只看一个阈值：实测正常条目里，模型会把表格单元格问句（「没时间听直播怎么办？」）
  // 和长句压缩（「保送清华不能全归功于自己」）也压到 75% 左右，一律报警会淹掉真正的问题条目。
  const invented: { text: string; cover: number }[] = [];
  const condensed: { text: string; cover: number }[] = [];
  for (const s of IP_SECTIONS) {
    for (const it of rev.sections[s.key] ?? []) {
      const c = bigramCoverage(it, rawBigrams);
      if (c < 0.5) invented.push({ text: `[${s.label}] ${it}`, cover: c });
      else if (c < 0.85) condensed.push({ text: `[${s.label}] ${it}`, cover: c });
    }
  }
  const ungrounded = [...invented, ...condensed];

  const totalItems = IP_SECTIONS.reduce((n, s) => n + (rev.sections[s.key]?.length ?? 0), 0);

  return {
    totalItems,
    boundaryItems: boundaryItems.length,
    boundarySentences: boundarySentences.length,
    covered,
    coveredInBoundaries,
    coveredElsewhere,
    missing,
    ungrounded,
    invented,
    condensed,
    sectionCounts: Object.fromEntries(IP_SECTIONS.map((s) => [s.label, (rev.sections[s.key] ?? []).length])),
  };
}

function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(0)}%` : '—';
}

async function main() {
  const where = WANT_V !== undefined ? { versionNo: WANT_V } : ALL ? {} : { status: 'ACTIVE' };
  const rows = await prisma.ipProfileRevision.findMany({ where, orderBy: { versionNo: 'asc' } });
  if (!rows.length) {
    console.error('没有找到资料包版本（先跑 npm run rewrite:profile <文件>）');
    process.exit(1);
  }

  const inspected = rows.map((r) => ({ rev: load(r), m: inspect(load(r)) }));

  for (const { rev, m } of inspected) {
    const tag = rev.status === 'ACTIVE' ? '（生效）' : '';
    console.log(`v${rev.versionNo}${tag} 《${rev.title}》`);
    console.log(`  条目总数 ${m.totalItems}｜边界条目 ${m.boundaryItems}`);
    console.log(
      `  召回：${m.covered}/${m.boundarySentences}（${pct(m.covered, m.boundarySentences)}）` +
        `  = 边界板块 ${m.coveredInBoundaries} + 其他板块 ${m.coveredElsewhere}`,
    );
    console.log('        ← 以原文含禁令措辞的句子的「否定核心」为基准，跨全板块统计');
    console.log(
      `  忠实：${m.totalItems - m.ungrounded.length}/${m.totalItems}（${pct(m.totalItems - m.ungrounded.length, m.totalItems)}）` +
        `  疑似编造 ${m.invented.length} 条／压缩改写 ${m.condensed.length} 条`,
    );
    if (m.invented.length) {
      console.log('  ✗ 疑似编造（原文中几乎找不到出处，必须核实）：');
      for (const u of [...m.invented].sort((a, b) => a.cover - b.cover)) {
        console.log(`      ${(u.cover * 100).toFixed(0)}%  ${u.text.slice(0, 110)}`);
      }
    }
    if (m.condensed.length) {
      console.log(`  · 压缩改写 ${m.condensed.length} 条（抽查）：`);
      for (const u of [...m.condensed].sort((a, b) => a.cover - b.cover).slice(0, 5)) {
        console.log(`      ${(u.cover * 100).toFixed(0)}%  ${u.text.slice(0, 100)}`);
      }
    }
    console.log('  板块：' + IP_SECTIONS.map((s) => `${s.label.slice(0, 4)} ${m.sectionCounts[s.label] ?? 0}`).join(' / '));
    if (SHOW_MISSING && m.missing.length) {
      console.log(`  未覆盖的原文边界句（${m.missing.length}）：`);
      for (const s of m.missing) console.log('      - ' + s.slice(0, 140));
    }
    console.log('');
  }

  if (ALL && inspected.length > 1) {
    console.log('版本 | 边界条目 | 召回 | 忠实 | 疑似编造');
    for (const { rev, m } of inspected) {
      console.log(
        `v${rev.versionNo}${rev.status === 'ACTIVE' ? '(生效)' : ''} | ${m.boundaryItems} | ` +
          `${m.covered}/${m.boundarySentences} (${pct(m.covered, m.boundarySentences)}) | ` +
          `${m.totalItems - m.ungrounded.length}/${m.totalItems} (${pct(m.totalItems - m.ungrounded.length, m.totalItems)}) | ` +
          `${m.invented.length}`,
      );
    }
    console.log('');
  }

  const active = inspected.find((x) => x.rev.status === 'ACTIVE') ?? inspected[inspected.length - 1];
  if (MIN_RECALL !== undefined) {
    const ratio = active.m.covered / active.m.boundarySentences;
    if (ratio < MIN_RECALL) {
      console.error(`✗ 生效版本召回 ${pct(active.m.covered, active.m.boundarySentences)} < 阈值 ${(MIN_RECALL * 100).toFixed(0)}%`);
      process.exitCode = 1;
    } else {
      console.log(`✓ 生效版本召回 ${pct(active.m.covered, active.m.boundarySentences)} ≥ 阈值 ${(MIN_RECALL * 100).toFixed(0)}%`);
    }
  }
}

main()
  .catch((e) => {
    console.error('体检失败：', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
