import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {
  BASIC_INFO_COLUMNS,
  BASIC_INFO_GROUP_LABEL,
  EXPORT_COLUMNS,
  MISSING,
  TAG_COLUMN_OFFSET,
  TAG_ORDER,
  TRANSCRIPT_GROUP_LABEL,
  formatClock,
  formatRange,
  orderCreativeTags,
} from '../constants';
import type { MuseInsight } from '../sources/muse-insight';
import { buildExportFileName, buildSheetNames, formatDateTime } from './sheet-name';

/**
 * 「信息流素材库」导出结构（2026-09-16 需求方确认）：
 *   - 脚本表格只保留一行；
 *   - 左半为「视频分析」10 列：原视频标题 / 性别特征 / 年龄特征 / 分镜或高光 title / 创意标签 /
 *     妆造 / 画面场景 / 情绪 / 形式 / 视频链接（该组名称由「基本信息」改为「视频分析」，导出表在第 5 行分组行标出）；
 *   - 中间为「脚本文案」1 列：音频转写模型输出的整段原文（人工可改），内容与工作台同源；
 *   - 右半为六个标签列：人设 / 痛点 / 干货（解决方案）/ 营销内容（产品介绍）/ 福利 / 其他，
 *     用该标签下的转写原文填充（按时间顺序拼接，一个字不改），没有则留空；
 *   - 「创意标签」只呈现需求方指定的 10 项并按固定顺序排列（见 constants.MUSE_CREATIVE_TAG_ORDER）；
 *   - 已删除「场景」标签与段落级场景标注；「画面场景」作为整条视频一次的概览保留；
 *   - 已删除原「序号时间 / 文案 / 旁白」与「主要画面截图」列。
 *
 * 另一种导出「信息流脚本」（按时间轴逐段列出，不聚合）见 ./script-sheet.ts。
 */

export type ExportSegment = {
  orderIndex: number;
  startMs: number;
  endMs: number;
  copyText: string;
  tag: string;
  makeup: string;
  emotion: string;
};

export type ExportVideoPayload = {
  videoId: string;
  title: string | null;
  /** 原视频标题：本地导入 = 原文件名；链接导入 = 网页标题 */
  sourceTitle?: string | null;
  durationMs: number | null;
  fileName: string | null;
  originalPath: string | null;
  sourceUrl: string | null;
  seq: number | null;
  reviewStatus: string;
  reviewStatusLabel: string;
  versionNo: number;
  savedAt: Date;
  formLabel: string;
  /** 形式是否为混剪：混剪时妆造/画面场景/情绪留空，不重复标注 */
  isMixedCut: boolean;
  /** 「视频分析」栏的画面场景：整条视频一次的概览；混剪时留空 */
  sceneOverview?: string;
  /** 「脚本文案」栏：音频转写原文整段（人工可改，导出原样输出） */
  transcriptText?: string;
  /** 原网页板块快照；取不到时为空值 */
  insight?: MuseInsight | null;
  segments: ExportSegment[];
};

const COL_COUNT = EXPORT_COLUMNS.length; // 17 = 视频分析 10 + 脚本文案 1 + 标签 6

/** 列宽：视频分析列适中，脚本文案与标签列留足读文案的空间 */
const COL_WIDTHS = [40, 12, 16, 26, 40, 22, 20, 20, 12, 34, 60, 34, 34, 30, 40, 40, 26];

/** 「视频链接」列位随列结构变化，不能写死 */
const LINK_COL_INDEX = BASIC_INFO_COLUMNS.findIndex((c) => c.key === 'sourceLink') + 1;

/** 空值统一留空（需求：如果没有则标记为空），不写占位词 */
const BLANK = '';

function colLetter(i: number): string {
  return String.fromCharCode(65 + i); // A..O
}

/** 文本安全：以 = 等开头的识别内容按普通文本写入，不能被执行成公式（PRD 7.3） */
function asText(v: string): string {
  return v ?? '';
}

/** 某标签下的文案：按时间顺序拼接，原文不改，只加换行分隔 */
function cellForTag(segments: ExportSegment[], tag: string): string {
  const parts = segments
    .filter((s) => s.tag === tag)
    .sort((a, b) => a.startMs - b.startMs)
    .map((s) => (s.copyText ?? '').trim())
    .filter((t) => t !== '');
  return parts.join('\n');
}

/** 妆造/情绪：整条视频取首段的完整描述（首段必须给完整值）；混剪留空 */
function firstFullValue(segments: ExportSegment[], key: 'makeup' | 'emotion'): string {
  for (const s of segments) {
    const v = (s[key] ?? '').trim();
    if (v && v !== MISSING.SAME_AS_ABOVE) return v;
  }
  return BLANK;
}

function creativeTagsText(insight?: MuseInsight | null): string {
  // 只呈现需求方指定的 10 项，并按固定顺序排列；填充方式（多值用「、」连接）不变
  return orderCreativeTags(insight?.creativeTags)
    .map((t) => `${t.label}：${t.values.join('、')}`)
    .join('\n');
}

function shotTitleText(insight?: MuseInsight | null): string {
  return (insight?.shotTitles ?? []).join('\n');
}

export async function buildWorkbook(
  payloads: ExportVideoPayload[],
  outDir: string,
): Promise<{ filePath: string; fileName: string }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '视频号信息流编导脚本编写 Agent';
  wb.created = new Date();

  const sheetNames = buildSheetNames(payloads.map((p) => ({ title: p.title, seq: p.seq })));

  payloads.forEach((p, idx) => {
    const ws = wb.addWorksheet(sheetNames[idx], {
      views: [{ state: 'frozen', ySplit: 6 }],
    });
    COL_WIDTHS.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });

    // ---- 第 1 行：完整视频标题 ----
    ws.mergeCells(`A1:${colLetter(COL_COUNT - 1)}1`);
    const titleCell = ws.getCell('A1');
    titleCell.value = (p.title ?? '').trim() || MISSING.NOT_PROVIDED;
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    ws.getRow(1).height = 28;

    // ---- 第 2 行：时长 / 原文件名 ----
    ws.mergeCells('A2:C2');
    ws.getCell('A2').value = p.durationMs != null ? `时长：${formatClock(p.durationMs)}` : `时长：${MISSING.NOT_PROVIDED}`;
    ws.mergeCells(`D2:${colLetter(COL_COUNT - 1)}2`);
    ws.getCell('D2').value = `原文件名：${p.fileName || MISSING.NOT_PROVIDED}`;

    // ---- 第 3 行：本地原文件路径 ----
    ws.mergeCells(`A3:${colLetter(COL_COUNT - 1)}3`);
    ws.getCell('A3').value = `本地原文件路径：${p.originalPath || MISSING.NOT_PROVIDED}`;

    // ---- 第 4 行：复核状态 / 保存版本 ----
    ws.mergeCells('A4:C4');
    ws.getCell('A4').value = `复核状态：${p.reviewStatusLabel}`;
    ws.mergeCells(`D4:${colLetter(COL_COUNT - 1)}4`);
    ws.getCell('D4').value = `保存版本：v${p.versionNo}；保存时间：${formatDateTime(p.savedAt)}`;

    for (const r of [2, 3, 4]) {
      ws.getRow(r).height = 20;
      for (let c = 1; c <= COL_COUNT; c += 1) {
        const cell = ws.getRow(r).getCell(c);
        cell.alignment = { vertical: 'middle', wrapText: true };
        cell.font = { size: 10, color: { argb: 'FF444444' } };
      }
    }

    // ---- 第 5 行：分组行（视频分析 9 列 / 脚本文案 1 列 / 标签分类 6 列）----
    const BASIC_COUNT = BASIC_INFO_COLUMNS.length;
    const groupRow = ws.getRow(5);
    ws.mergeCells(`A5:${colLetter(BASIC_COUNT - 1)}5`);
    ws.getCell('A5').value = BASIC_INFO_GROUP_LABEL;
    const TRANSCRIPT_COL = BASIC_COUNT; // 0 基下标，即第 10 列
    ws.getCell(colLetter(TRANSCRIPT_COL) + '5').value = TRANSCRIPT_GROUP_LABEL;
    ws.mergeCells(`${colLetter(TRANSCRIPT_COL + 1)}5:${colLetter(COL_COUNT - 1)}5`);
    ws.getCell(colLetter(TRANSCRIPT_COL + 1) + '5').value = '标签分类';
    for (let c = 1; c <= COL_COUNT; c += 1) {
      const cell = groupRow.getCell(c);
      cell.font = { bold: true, size: 10, color: { argb: 'FF333333' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      };
    }
    groupRow.height = 20;

    // ---- 第 6 行：列名表头（左半视频分析，右半六类标签）----
    const headerRow = ws.getRow(6);
    EXPORT_COLUMNS.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.header;
      cell.font = { bold: true, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: col.group === 'basic' ? 'FFEDF1F7' : col.group === 'transcript' ? 'FFFFF4E5' : 'FFEAF3EA' },
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      };
    });
    headerRow.height = 26;

    // ---- 第 7 行：唯一一行数据 ----
    const row = ws.getRow(7);
    const mixed = p.isMixedCut;
    const basicValues: string[] = [
      (p.sourceTitle ?? '').trim() || MISSING.NOT_PROVIDED,
      (p.insight?.gender ?? []).join('、'),
      (p.insight?.age ?? []).join('、'),
      shotTitleText(p.insight),
      creativeTagsText(p.insight),
      mixed ? BLANK : firstFullValue(p.segments, 'makeup'),
      mixed ? BLANK : (p.sceneOverview ?? '').trim(),
      mixed ? BLANK : firstFullValue(p.segments, 'emotion'),
      p.formLabel,
      p.sourceUrl || MISSING.NOT_PROVIDED,
    ];
    const tagValues = TAG_ORDER.map((t) => cellForTag(p.segments, t));
    // 脚本文案：整段转写原文（人工改过的也按保存值导出），无语音时为「无」；历史版本可能没有
    const transcriptValue = (p.transcriptText ?? '').trim() || MISSING.NOT_PROVIDED;

    [...basicValues, transcriptValue, ...tagValues].forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = asText(v);
      cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true, shrinkToFit: false };
      cell.font = { size: 10 };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      };
    });

    // 视频链接保留可读原始文本，同时可点击
    const linkCell = row.getCell(LINK_COL_INDEX);
    const linkUrl = p.sourceUrl && /^https?:\/\//i.test(p.sourceUrl) ? p.sourceUrl : null;
    if (linkUrl) {
      linkCell.value = { text: p.sourceUrl as string, hyperlink: linkUrl } as ExcelJS.CellValue;
      linkCell.font = { color: { argb: 'FF0563C1' }, underline: true, size: 10 };
    }

    // 行高按最长单元格估算，避免文案被折叠看不到（内容仍完整保留）
    const allValues = [...basicValues, transcriptValue, ...tagValues];
    const longest = allValues.reduce((m, v) => Math.max(m, estimateLines(v)), 0);
    row.height = Math.min(420, Math.max(60, longest * 15 + 10));

    if (p.segments.length === 0) {
      // 未解析时把「未解析」写在第一个标签列上（列位随结构变化，不能写死列号）
      row.getCell(TAG_COLUMN_OFFSET + 1).value = asText(MISSING.UNPARSED);
    }
  });

  fs.mkdirSync(outDir, { recursive: true });
  const fileName = buildExportFileName('LIBRARY');
  const filePath = path.join(outDir, fileName);
  await wb.xlsx.writeFile(filePath);
  return { filePath, fileName };
}

/** 估算换行后的行数：显式换行 + 按 30 字折行 */
export function estimateLines(v: string): number {
  const s = v ?? '';
  if (!s) return 1;
  return s.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 30)), 0);
}

export { formatRange };
