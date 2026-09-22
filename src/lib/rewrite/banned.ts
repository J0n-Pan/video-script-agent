// 违禁词资料包：解析 / 渲染进提示词 / 命中扫描（2026-09-22 第七轮需求）。
//
// 与 IP 资料包的关系：两者共用 `IpProfileRevision` 的版本管理（按 `kind` 区分），
// 但用途相反 —— IP 资料包回答「可以说什么」，违禁词资料包回答「绝对不能说什么」。
//
// 三个关键设计：
//
// 1. **不用模型整理词条**。违禁词的价值全在「一条都不能漏、一个字都不能改」，
//    而"结构化"本身就含丢信息与改写风险（profile.ts 里为了抽全禁令做过分块抽取，
//    就是因为单次调用必然截断）。这里改成纯本地解析：按行与列表分隔符切词，
//    分类只认文档里**显式写出的小标题**；拿不准就归「未分类」，绝不猜。
//
// 2. **提示词 + 程序扫描双保险**。提示词不是保证 —— 本项目已有先例：
//    profile.ts 的 `stripPromptEcho` 兜底就是为「模型把工作要求抄进结果」加的。
//    所以生成后由程序逐段扫描命中词，写进问题清单。
//
// 3. **命中只标记不阻断**（已确认口径）。违禁词一定有误报（禁「最好」而
//    文案里是中性用法），编导要能继续保存、选定、提交数字人，由人来判断。

export const BANNED_FALLBACK_CATEGORY = '未分类';

/**
 * 词条总数上限。超过则截断并在解析警告里说明 ——
 * 词表要全塞进提示词，无上限会挤掉参考段与资料包的位置。
 */
export const MAX_BANNED_ENTRIES = 800;

/** 单条词条短于这个长度就丢弃：「的」「了」「你」这类单字必然满屏误报，噪声大于价值 */
const MIN_ENTRY_LEN = 2;

/** 命中清单里每条文案最多列几个词（防界面被刷爆；实际命中数另计） */
export const MAX_HITS_PER_SEGMENT = 50;

export type BannedWordEntry = {
  /** 原样保留的词/表达，不做任何改写 */
  text: string;
  category: string;
  /** 可选备注（文档里跟在词后面的说明性文字） */
  note: string;
};

export type BannedPack = {
  /** 文档里出现过的分类，按出现顺序 */
  categories: string[];
  entries: BannedWordEntry[];
};

export type BannedHit = {
  word: string;
  category: string;
  /** 命中区间（基于原文的字符下标，左闭右开），供界面高亮 */
  start: number;
  end: number;
};

export type BannedParseResult = {
  pack: BannedPack;
  /** 解析过程中的提示（截断、疑似误读等），供导入结果回显 */
  warnings: string[];
  /** 按分类计数（含「未分类」），供界面显示 */
  categoryCounts: Record<string, number>;
};

/** 列表项前缀：`- item` / `1. item` / `(1) item` / `① item` 等，只剥前缀不改词 */
const BULLET_RE = /^\s*(?:[-*•·◦▪▫–—]|\d+\s*[.、)．)]|[（(]\s*\d+\s*[）)]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*/;

/** 明确的分类小标题写法（只认这几种，不做"看起来像标题"的猜测） */
const MD_HEADING_RE = /^#{1,6}\s*(.+?)\s*$/; // ## 绝对化用语
const BRACKET_HEADING_RE = /^【\s*(.+?)\s*】\s*$/; // 【绝对化用语】
const CHAPTER_HEADING_RE = /^第\s*[一二三四五六七八九十百零\d]+\s*(?:部分|章|节|类)\s*[:：、]?\s*(.*)$/;

/** 一行里同时含分类与词条（`绝对化用语：最好、第一`）时用的分隔符 */
const CATEGORY_COLON_RE = /^([^：:]{1,24})[：:]\s*(.*)$/;

/** 分类名的长度上限：超过就说明这行不是标题，而是正文 */
const MAX_CATEGORY_LEN = 24;

/**
 * 列表分隔符。刻意**不含 `/`**：违禁词文档里 `/` 更可能是「你/您」这类写法，
 * 也可能是路径或网址的一部分，按它切分收益小、误切风险大。
 */
const LIST_SEP_RE = /[、,，;；|丨]/;

/** 切词时保留的排除项：纯标点/纯符号的碎片没有意义 */
const PUNCT_ONLY_RE = /^[\s\p{P}\p{S}]+$/u;

function stripBullet(line: string): string {
  return line.replace(BULLET_RE, '').trim();
}

/**
 * 从一行里识别分类名的**强信号**（markdown 标题 / 【】/ 第X部分）。
 *
 * 这里刻意保守：把一句正常词条误判成标题，会让它之后的所有词条都挂到错的分类下；
 * 而漏判一个标题只是多几条「未分类」，不影响命中检查。两类错误的代价不对称，所以宁可漏判。
 *
 * `分类：内容` 这种弱信号不在这里判 —— 它的方向是可以反的（`最好：广告法禁用词`），
 * 由 parseBannedPack 按"宁可多收不可漏收"的口径处理。
 */
function matchStrongHeading(line: string): string | null {
  const md = MD_HEADING_RE.exec(line);
  if (md) return md[1].trim();

  const bracket = BRACKET_HEADING_RE.exec(line);
  if (bracket) return bracket[1].trim();

  // 「第三部分」「第三章：绝对化用语」：空尾巴时整行当分类名，否则尾巴当分类名
  const chapter = CHAPTER_HEADING_RE.exec(line);
  if (chapter) {
    const rest = chapter[1].trim();
    if (!rest) return line.trim();
    if (rest.length <= MAX_CATEGORY_LEN && !LIST_SEP_RE.test(rest)) return rest;
  }
  return null;
}

/**
 * 把一行切成若干词条。
 *
 * 为什么必须切：文档常见写法是一行塞多个词（`最好、第一、国家级`）。
 * 若整行当一个词条，扫描时只有原文逐字等于这一整串才算命中 —— 等于三个词全都失效。
 * 切分只会让匹配更敏感；配合 `MIN_ENTRY_LEN` 过滤单字碎片，压住误报。
 */
function splitEntries(text: string): string[] {
  return text
    .split(LIST_SEP_RE)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_ENTRY_LEN && !PUNCT_ONLY_RE.test(s));
}

/**
 * 本地解析违禁词文档为分类 + 词条。
 *
 * 解析口径（全部是"显式优先 + 宁可多收不可漏收"）：
 * - 分类只认强信号：markdown 标题 / 【…】 / 第X部分；
 * - `左：右` 是弱信号，方向可能反（`绝对化用语：最好、第一` vs `最好：广告法禁用词`）：
 *   右侧是顿号/逗号列表 → 左侧当分类；否则两侧都收成词条（右侧同时作为左侧的备注）。
 *   宁可多收几条本质上不是违禁词的分类名，也不能漏掉一个真正的违禁词；
 * - 一行里用 `、，,;；|丨` 分隔的多个短词各自成条；
 * - 词条文本**原样保留**，只剥掉列表符号与首尾空白 —— 不做同义归并、不做改写。
 */
export function parseBannedPack(rawText: string): BannedParseResult {
  const warnings: string[] = [];
  const entries: BannedWordEntry[] = [];
  const categories: string[] = [];
  const seen = new Set<string>();

  let current = BANNED_FALLBACK_CATEGORY;
  let dropped = 0;

  const pushCategory = (c: string) => {
    if (c && !categories.includes(c)) categories.push(c);
  };

  const pushEntry = (text: string, note = '', category = current) => {
    const t = text.trim();
    if (t.length < MIN_ENTRY_LEN || PUNCT_ONLY_RE.test(t)) return;
    if (entries.length >= MAX_BANNED_ENTRIES) {
      dropped += 1;
      return;
    }
    if (seen.has(t)) return;
    seen.add(t);
    entries.push({ text: t, category, note });
  };

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const strong = matchStrongHeading(line);
    if (strong) {
      current = strong || BANNED_FALLBACK_CATEGORY;
      pushCategory(current);
      continue;
    }

    const body = stripBullet(line);
    if (!body) continue;

    const colon = CATEGORY_COLON_RE.exec(body);
    if (colon) {
      const left = colon[1].trim();
      const right = colon[2].trim();
      if (!right) {
        // `绝对化用语：` —— 只有左侧，当分类标题
        current = left || BANNED_FALLBACK_CATEGORY;
        pushCategory(current);
        continue;
      }
      const rightItems = splitEntries(right);
      if (LIST_SEP_RE.test(right) && rightItems.length >= 2) {
        /**
         * `绝对化用语：最好、第一` —— 判为「左侧是分类，右侧是词」。
         *
         * 但**左侧同时收成一条词条**：这个方向判断是可以反的
         * （`最好：广告法绝对化用语，不能用` 右侧同样含顿号/逗号），
         * 漏掉一个真正的违禁词比多收一条「绝对化用语」严重得多，
         * 所以方向不明时两侧都收。
         *
         * 左侧这条挂在它自己名下（而不是留在上一个分类里）：挂到上一个分类会平白多出
         * 「未分类」条目、进而触发"有词条未识别分类"的提示，噪声大于价值；
         * 分类只影响提示词里的分组，不影响命中检查。
         */
        current = left || BANNED_FALLBACK_CATEGORY;
        pushCategory(current);
        pushEntry(left);
        for (const t of rightItems) pushEntry(t);
      } else {
        // 右侧不像词表（没有分隔符或只有一个片段）：左侧是词、右侧是它的说明
        pushEntry(left, right);
        for (const t of rightItems) pushEntry(t);
      }
      continue;
    }

    for (const t of splitEntries(body)) pushEntry(t);
  }

  if (entries.length === 0) {
    warnings.push('没有解析出任何词条：请确认文档里确实是逐条列出的词 / 表达（每行一条，或用、分隔）。');
  }
  if (dropped > 0) {
    warnings.push(`词条数超过上限 ${MAX_BANNED_ENTRIES}，有 ${dropped} 条被截断未收录。请拆分文档后分次导入。`);
  }
  if (entries.some((e) => e.category === BANNED_FALLBACK_CATEGORY)) {
    warnings.push(
      `有词条未识别到分类，已归入「${BANNED_FALLBACK_CATEGORY}」。` +
        '分类只认 markdown 标题、【分类】、第X部分、以及 `分类：词1、词2` 这几种写法；不影响命中检查。',
    );
  }

  const categoryCounts: Record<string, number> = {};
  for (const e of entries) categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;
  if (!categories.includes(BANNED_FALLBACK_CATEGORY) && categoryCounts[BANNED_FALLBACK_CATEGORY]) {
    categories.push(BANNED_FALLBACK_CATEGORY);
  }

  return { pack: { categories, entries }, warnings, categoryCounts };
}

/** 词条数（给列表接口用，避免把整包 JSON 回传给前端） */
export function countBannedEntries(profileJson: string): number {
  try {
    const o = JSON.parse(profileJson || '{}');
    return Array.isArray(o?.entries) ? o.entries.length : 0;
  } catch {
    return 0;
  }
}

/** 从存档的 profileJson 里取回违禁词表；形状不对时返回空包，不抛 */
export function readBannedPack(profileJson: string): BannedPack {
  try {
    const o = JSON.parse(profileJson || '{}');
    const entries: BannedWordEntry[] = Array.isArray(o?.entries)
      ? o.entries
          .map((e: unknown) =>
            typeof e === 'string'
              ? { text: e, category: BANNED_FALLBACK_CATEGORY, note: '' }
              : {
                  text: String((e as BannedWordEntry)?.text ?? ''),
                  category: String((e as BannedWordEntry)?.category ?? BANNED_FALLBACK_CATEGORY),
                  note: String((e as BannedWordEntry)?.note ?? ''),
                },
          )
          .filter((e: BannedWordEntry) => e.text.trim().length >= MIN_ENTRY_LEN)
      : [];
    return {
      categories: Array.isArray(o?.categories) ? o.categories.map(String) : [],
      entries,
    };
  } catch {
    return { categories: [], entries: [] };
  }
}

/**
 * 渲染进提示词。
 *
 * 位置与措辞都刻意做成"红线"：放在用户消息靠前处、并用与事实约束同级的措辞，
 * 是因为实测中越靠后出现的约束越容易被当成补充说明而忽略（IP 资料包里的
 * boundaries/gaps 也是同样的处理，见 profile.ts 的 RENDER_AS_CONSTRAINTS）。
 */
export function renderBannedText(pack: BannedPack, title: string, versionNo: number): string {
  if (pack.entries.length === 0) return '';
  const lines: string[] = [
    `### 以下是**禁用表达**（来自违禁词资料包《${title}》 v${versionNo}）：改写稿中绝对不能出现`,
    '违反即视为不合格。若某个意思只能靠这些词才能表达，请换一种自然说法把同一个意思讲清楚，',
    '不要用同音字、拆字、拼音首字母、谐音、符号间隔等方式变相写出这些表达。',
    '',
  ];
  for (const c of pack.categories) {
    const items = pack.entries.filter((e) => e.category === c);
    if (items.length === 0) continue;
    lines.push(`## ${c}`);
    for (const e of items) lines.push(`- ${e.text}`);
    lines.push('');
  }
  // 分类在 entries 里不存在（形状不全）时兜底：至少把所有词列出来
  const listed = new Set(pack.categories);
  const rest = pack.entries.filter((e) => !listed.has(e.category));
  if (rest.length) {
    lines.push(`## ${BANNED_FALLBACK_CATEGORY}`);
    for (const e of rest) lines.push(`- ${e.text}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * 把文本与词都做"去空白 + 小写"归一化，并保留归一化下标 → 原文下标的映射。
 *
 * 为什么要映射：界面要高亮命中位置，就必须给回**原文**的区间；
 * 而归一化会改变长度（去掉空白），直接拿归一化下标去切原文会错位。
 */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  const map: number[] = [];
  let norm = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (/\s/.test(ch)) continue;
    norm += ch.toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

function normalizeWord(w: string): string {
  return w.replace(/\s+/g, '').toLowerCase();
}

/** 预处理的扫描器：词表归一化一次，之后每段只做 indexOf */
export type PreparedBannedScanner = {
  items: Array<{ word: string; norm: string; category: string }>;
};

/**
 * 预处理词表。
 *
 * 为什么要单独一步：界面在**每次按键**都会把每个段落重扫一遍，
 * 若每次都重新归一化 800 个词，一次编辑就是上万次正则替换 —— 会明显卡输入。
 * 词表在页面生命周期内不变，归一化一次即可。
 */
export function prepareScanner(entries: BannedWordEntry[]): PreparedBannedScanner {
  const items: PreparedBannedScanner['items'] = [];
  for (const e of entries) {
    const norm = normalizeWord(e.text);
    if (norm.length < MIN_ENTRY_LEN) continue;
    items.push({ word: e.text, norm, category: e.category });
  }
  // 长的先比：同一位置被长短两个词同时命中时，先命中的是长词，
  // 后续短词的重叠区间会被渲染阶段的 cursor 跳过，最终显示的是更具体的那个。
  items.sort((a, b) => b.norm.length - a.norm.length);
  return { items };
}

/**
 * 扫描一段文案命中的违禁词。
 *
 * 口径：**子串匹配**（不是正则、不是分词）——
 * 违禁词要的是"出现就不行"，正则既容易写错也容易被规避；
 * 代价是必然有误报，所以命中只标记不阻断（见文件头第 3 条）。
 */
export function scanPrepared(text: string, scanner: PreparedBannedScanner): BannedHit[] {
  if (!text || scanner.items.length === 0) return [];
  const { norm, map } = normalizeWithMap(text);
  const hits: BannedHit[] = [];
  const seenKey = new Set<string>();

  for (const item of scanner.items) {
    let from = 0;
    for (;;) {
      const i = norm.indexOf(item.norm, from);
      if (i < 0) break;
      const start = map[i];
      const end = map[i + item.norm.length - 1] + 1;
      const key = `${start}-${end}-${item.word}`;
      if (!seenKey.has(key)) {
        seenKey.add(key);
        hits.push({ word: item.word, category: item.category, start, end });
      }
      from = i + 1;
    }
  }

  // 长的先排：同一区间被长短两个词同时命中时，界面高亮取长的那个更合理
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  return hits.slice(0, MAX_HITS_PER_SEGMENT);
}

/** 一次性扫描（服务端生成后检查用；前端连续扫描请用 prepareScanner + scanPrepared） */
export function scanBannedWords(text: string, entries: BannedWordEntry[]): BannedHit[] {
  return scanPrepared(text, prepareScanner(entries));
}
