import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { APP_NAME, MISSING, REWRITE_COLUMNS } from '../constants';
import { buildExportFileName, formatDateTime } from './sheet-name';
import { estimateLines } from './xlsx';

/**
 * 「信息流文案改写稿」导出（2026-09-20 需求迭代 §9）。
 *
 * 与另两种导出的关系：**新增独立类型**，不改动「信息流脚本」与「信息流素材库」的行为。
 * 列口径：稿件版本 / 序号 / 标签 / 正文 / 预计口播时长（估算）。
 *
 * 两点刻意处理：
 * 1. 改写稿没有真实时间码 —— 所以时长的列名与取值都写明「估算」，
 *    不用 `mm:ss-mm:ss` 那种参考片时间码格式，避免编导误当成原片时间轴；
 * 2. 一个创作任务一个工作表，多个版本按版本号、序号依次排列在**同一张表**里，
 *    这样「稿件版本」这一列才有意义，也方便编导纵向横向对比。
 */

export const REWRITE_COL_COUNT = REWRITE_COLUMNS.length; // 5

const COL_WIDTHS = [12, 8, 24, 110, 22];

export type ExportRewriteSegment = {
  orderIndex: number;
  tag: string;
  copyText: string;
};

export type ExportRewriteVariant = {
  variantNo: number;
  revisionNo: number;
  createdBy: string;
  diffSummary: string;
  charCount: number;
  estimatedDurationMs: number;
  segments: ExportRewriteSegment[];
};

export type ExportRewritePayload = {
  jobId: string;
  /** 任务标题（取来源视频标题；来源已删除时用快照里的标题） */
  jobTitle: string;
  /** 来源参考视频标题；来源已删除时明确说明 */
  sourceTitle: string;
  sourceRevisionLabel: string;
  platformLabel: string;
  ipProfileLabel: string;
  modelId: string;
  generatedAt: Date | null;
  selectionLabel: string;
  variants: ExportRewriteVariant[];
};

function colLetter(i: number): string {
  return String.fromCharCode(65 + i); // A..E
}

function writeHeaderRows(ws: ExcelJS.Worksheet, p: ExportRewritePayload): void {
  const last = colLetter(REWRITE_COL_COUNT - 1);

  // ---- 第 1 行：任务标题 ----
  ws.mergeCells(`A1:${last}1`);
  const titleCell = ws.getCell('A1');
  titleCell.value = (p.jobTitle ?? '').trim() || MISSING.NOT_PROVIDED;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  ws.getRow(1).height = 28;

  // ---- 第 2 行：平台 / 资料包版本 ----
  ws.mergeCells('A2:B2');
  ws.getCell('A2').value = `平台：${p.platformLabel}`;
  ws.mergeCells(`C2:${last}2`);
  ws.getCell('C2').value = `资料包：${p.ipProfileLabel}`;

  // ---- 第 3 行：来源参考视频与参考版本 ----
  ws.mergeCells(`A3:${last}3`);
  ws.getCell('A3').value = `来源参考视频：${p.sourceTitle || MISSING.NOT_PROVIDED}；参考版本：${p.sourceRevisionLabel}`;

  // ---- 第 4 行：模型 / 生成时间 / 选定情况 ----
  ws.mergeCells('A4:B4');
  ws.getCell('A4').value = `生成模型：${p.modelId || MISSING.NOT_PROVIDED}`;
  ws.mergeCells(`C4:${last}4`);
  ws.getCell('C4').value = `生成时间：${p.generatedAt ? formatDateTime(p.generatedAt) : MISSING.NOT_PROVIDED}；${p.selectionLabel}`;

  for (const r of [2, 3, 4]) {
    ws.getRow(r).height = 20;
    for (let c = 1; c <= REWRITE_COL_COUNT; c += 1) {
      const cell = ws.getRow(r).getCell(c);
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.font = { size: 10, color: { argb: 'FF444444' } };
    }
  }
}

function styleDataRow(row: ExcelJS.Row): void {
  for (let c = 1; c <= REWRITE_COL_COUNT; c += 1) {
    const cell = row.getCell(c);
    cell.alignment = { vertical: 'top', horizontal: c === 4 ? 'left' : 'center', wrapText: true };
    cell.font = { size: 10 };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    };
  }
}

/**
 * 估算时长的写法：「约 146 秒（按 4.8 字/秒估算）」。
 *
 * 刻意**不用** `mm:ss` 形态 —— 那是参考片时间码的样子，编导容易误读成原片时间轴。
 * 用纯秒数 + 明说「估算口径」，与真实时间码在视觉上就区分开了（§9 要求二者明确区分）。
 */
function formatEstimated(ms: number): string {
  if (!ms || ms <= 0) return '';
  const sec = Math.round(ms / 1000);
  return `约 ${sec} 秒`;
}

export async function buildRewriteWorkbook(
  payloads: ExportRewritePayload[],
  outDir: string,
): Promise<{ filePath: string; fileName: string }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = APP_NAME;
  wb.created = new Date();

  payloads.forEach((p, idx) => {
    // 表名：任务标题（Excel 限 31 字符，非法字符由 buildSheetNameSafe 处理）
    const ws = wb.addWorksheet(sheetName(p.jobTitle, idx + 1), { views: [{ state: 'frozen', ySplit: 5 }] });
    COL_WIDTHS.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });

    writeHeaderRows(ws, p);

    // ---- 第 5 行：表头 ----
    const headerRow = ws.getRow(5);
    REWRITE_COLUMNS.forEach((label, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = label;
      cell.font = { bold: true, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF1F7' } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      };
    });
    headerRow.height = 24;

    // ---- 第 6 行起：按版本号、段序号依次排列 ----
    const rows: Array<{ variantNo: number; orderIndex: number; tag: string; copyText: string; estimatedMs: number }> = [];
    for (const v of [...p.variants].sort((a, b) => a.variantNo - b.variantNo)) {
      for (const s of [...v.segments].sort((a, b) => a.orderIndex - b.orderIndex)) {
        rows.push({
          variantNo: v.variantNo,
          orderIndex: s.orderIndex,
          tag: s.tag ?? '',
          copyText: s.copyText ?? '',
          estimatedMs: v.estimatedDurationMs,
        });
      }
    }

    if (rows.length === 0) {
      const row = ws.getRow(6);
      row.getCell(1).value = '';
      row.getCell(2).value = '';
      row.getCell(3).value = '';
      row.getCell(4).value = MISSING.UNPARSED;
      row.getCell(5).value = '';
      styleDataRow(row);
      row.height = 30;
      return;
    }

    rows.forEach((r, i) => {
      const row = ws.getRow(6 + i);
      row.getCell(1).value = `第 ${r.variantNo} 版`;
      row.getCell(2).value = r.orderIndex;
      row.getCell(3).value = r.tag;
      row.getCell(4).value = r.copyText;
      // 预计时长按稿件整体给一次，不逐段重复，避免被误读成分段时长
      row.getCell(5).value = i === 0 || rows[i - 1].variantNo !== r.variantNo ? formatEstimated(r.estimatedMs) : '';
      styleDataRow(row);
      const lines = Math.max(2, estimateLines(r.copyText));
      row.height = Math.min(420, Math.max(30, lines * 15 + 8));
    });
  });

  fs.mkdirSync(outDir, { recursive: true });
  const fileName = buildExportFileName('REWRITE');
  const filePath = path.join(outDir, fileName);
  await wb.xlsx.writeFile(filePath);
  return { filePath, fileName };
}

const INVALID_SHEET = /[:\\/?*[\]]/g;

function sheetName(title: string, fallbackSeq: number): string {
  let base = (title ?? '').trim().replace(INVALID_SHEET, '_').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ');
  if (!base) base = `改写稿_${fallbackSeq}`;
  return base.slice(0, 31);
}
