import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { MISSING, SCRIPT_COLUMNS, formatClock, formatRange } from '../constants';
import { buildExportFileName, buildSheetNames, formatDateTime } from './sheet-name';
import { estimateLines, type ExportVideoPayload } from './xlsx';

/**
 * 「信息流脚本」导出（2026-09-16 需求方确认）：
 *   - 表头三列：序号 / 时间、标签、文案；
 *   - 内容按时间轴依次排列，一个转写片段一行，原文一字不改；
 *   - 保留抬头信息（标题 / 时长 / 原文件名 / 本地原文件路径 / 复核状态与版本）；
 *   - 一个视频一个工作表，序号在每个工作表内从 1 开始。
 *
 * 与「信息流素材库」的区别：这里**不按标签聚合**，保留时间信息，用于按时间轴核对口播。
 */
export const SCRIPT_COL_COUNT = SCRIPT_COLUMNS.length; // 3

const COL_WIDTHS = [18, 24, 110];

function colLetter(i: number): string {
  return String.fromCharCode(65 + i); // A..C
}

/** 第 1–4 行的抬头信息，与「信息流素材库」保持同一口径 */
function writeHeaderRows(ws: ExcelJS.Worksheet, p: ExportVideoPayload): void {
  // ---- 第 1 行：完整视频标题 ----
  ws.mergeCells(`A1:${colLetter(SCRIPT_COL_COUNT - 1)}1`);
  const titleCell = ws.getCell('A1');
  titleCell.value = (p.title ?? '').trim() || MISSING.NOT_PROVIDED;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  ws.getRow(1).height = 28;

  // ---- 第 2 行：时长 / 原文件名 ----
  ws.mergeCells('A2:B2');
  ws.getCell('A2').value = p.durationMs != null ? `时长：${formatClock(p.durationMs)}` : `时长：${MISSING.NOT_PROVIDED}`;
  ws.getCell('C2').value = `原文件名：${p.fileName || MISSING.NOT_PROVIDED}`;

  // ---- 第 3 行：本地原文件路径 ----
  ws.mergeCells(`A3:${colLetter(SCRIPT_COL_COUNT - 1)}3`);
  ws.getCell('A3').value = `本地原文件路径：${p.originalPath || MISSING.NOT_PROVIDED}`;

  // ---- 第 4 行：复核状态 / 保存版本 ----
  ws.mergeCells('A4:B4');
  ws.getCell('A4').value = `复核状态：${p.reviewStatusLabel}`;
  ws.getCell('C4').value = `保存版本：v${p.versionNo}；保存时间：${formatDateTime(p.savedAt)}`;

  for (const r of [2, 3, 4]) {
    ws.getRow(r).height = 20;
    for (let c = 1; c <= SCRIPT_COL_COUNT; c += 1) {
      const cell = ws.getRow(r).getCell(c);
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.font = { size: 10, color: { argb: 'FF444444' } };
    }
  }
}

export async function buildScriptWorkbook(
  payloads: ExportVideoPayload[],
  outDir: string,
): Promise<{ filePath: string; fileName: string }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '视频号信息流编导脚本编写 Agent';
  wb.created = new Date();

  const sheetNames = buildSheetNames(payloads.map((p) => ({ title: p.title, seq: p.seq })));

  payloads.forEach((p, idx) => {
    const ws = wb.addWorksheet(sheetNames[idx], { views: [{ state: 'frozen', ySplit: 5 }] });
    COL_WIDTHS.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });

    writeHeaderRows(ws, p);

    // ---- 第 5 行：表头（序号 / 时间、标签、文案）----
    const headerRow = ws.getRow(5);
    SCRIPT_COLUMNS.forEach((label, i) => {
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

    // ---- 第 6 行起：按时间轴依次排列，一段一行 ----
    const ordered = [...p.segments].sort((a, b) => a.startMs - b.startMs);
    if (ordered.length === 0) {
      const row = ws.getRow(6);
      row.getCell(1).value = '';
      row.getCell(2).value = '';
      row.getCell(3).value = MISSING.UNPARSED;
      styleDataRow(row);
      row.height = 30;
      return;
    }

    ordered.forEach((s, i) => {
      const row = ws.getRow(6 + i);
      row.getCell(1).value = `${i + 1}\n${formatRange(s.startMs, s.endMs)}`;
      row.getCell(2).value = s.tag ?? '';
      row.getCell(3).value = s.copyText ?? '';
      styleDataRow(row);
      // 行高按文案长度估算，避免被折叠看不到（内容完整保留）
      const lines = Math.max(2, estimateLines(s.copyText ?? ''));
      row.height = Math.min(420, Math.max(30, lines * 15 + 8));
    });
  });

  fs.mkdirSync(outDir, { recursive: true });
  const fileName = buildExportFileName('SCRIPT');
  const filePath = path.join(outDir, fileName);
  await wb.xlsx.writeFile(filePath);
  return { filePath, fileName };
}

function styleDataRow(row: ExcelJS.Row): void {
  for (let c = 1; c <= SCRIPT_COL_COUNT; c += 1) {
    const cell = row.getCell(c);
    cell.alignment = { vertical: 'top', horizontal: c === 1 || c === 2 ? 'center' : 'left', wrapText: true };
    cell.font = { size: 10 };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    };
  }
}
