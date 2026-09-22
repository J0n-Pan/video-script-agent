// 最小 docx 读取（零依赖，仅用 node:zlib）。
//
// 为什么不装 mammoth / 复用 exceljs 的间接依赖：
// 1. docx 就是一个 ZIP，我们只需要 word/document.xml 一个条目，为它引入依赖不划算；
// 2. exceljs 的 jszip/unzipper 是**间接依赖**，靠提升（hoisting）才在 node_modules 顶层，
//    依赖它等于依赖别人的依赖树，升级 exceljs 就可能断。
//
// 实现要点：从结尾的中央目录（EOCD）取条目表，而不是顺序读局部文件头 ——
// 流式写出的 ZIP 局部头里压缩长度可能为 0（靠 data descriptor 补），只有中央目录一定准确。

import fs from 'node:fs';
import zlib from 'node:zlib';

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** 从文件尾部回扫 EOCD（注释最长 65535 字节，多留一点余量） */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (65535 + 22));
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

export function listZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP/docx 文件：未找到中央目录结束记录（EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 读取单个条目并解压。method 0=store，8=deflate；其余（如 bzip2/zstd）本项目不支持。 */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const e = listZipEntries(buf).find((x) => x.name === name);
  if (!e) return null;
  if (buf.readUInt32LE(e.localHeaderOffset) !== LOC_SIG) {
    throw new Error(`ZIP 局部文件头校验失败：${name}`);
  }
  const nameLen = buf.readUInt16LE(e.localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(e.localHeaderOffset + 28);
  const start = e.localHeaderOffset + 30 + nameLen + extraLen;
  // 有的写入器在中央目录里给了长度，但局部也可能有 data descriptor；以中央目录长度为准
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的 ZIP 压缩方式 ${e.method}（条目 ${name}），请另存为 .docx 后重试`);
}

// ---------------------------------------------------------------------------
// document.xml → 段落 / 表格
// ---------------------------------------------------------------------------

export type DocxBlock =
  | { type: 'p'; text: string }
  | { type: 'table'; rows: string[][] };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, g: string) => {
    if (g.startsWith('#')) {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g] ?? m;
  });
}

/** 只保留 w: 主命名空间的标签名，忽略其它命名空间前缀（w14:、mc: 等） */
function localName(tag: string): string {
  const name = tag.split(/\s/)[0].replace(/\/$/, '');
  const idx = name.indexOf(':');
  const prefix = idx >= 0 ? name.slice(0, idx) : '';
  const local = idx >= 0 ? name.slice(idx + 1) : name;
  return prefix === '' || prefix === 'w' ? local : '';
}

/**
 * 解析 document.xml 正文。返回段落与表格的有序块列表。
 * 表格单元格内多个段落用空格连接（导出资料包时按单元格取值即可）。
 */
export function parseDocumentXml(xml: string): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  // 只看 body，避免把 sectPr / 样式里的文本算进正文
  const bodyStart = xml.indexOf('<w:body');
  const bodyEnd = xml.lastIndexOf('</w:body>');
  const body = bodyStart >= 0 && bodyEnd > bodyStart ? xml.slice(bodyStart, bodyEnd) : xml;

  let i = 0;
  let collecting = false;
  let para = '';
  let inTable = false;
  let tableRows: string[][] = [];
  let row: string[] = [];
  let cell = '';

  const flushPara = () => {
    const text = para.replace(/\s+$/g, '').trim();
    if (inTable) {
      cell = cell ? `${cell} ${text}` : text;
    } else if (text) {
      blocks.push({ type: 'p', text });
    }
    para = '';
  };

  while (i < body.length) {
    const lt = body.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i && collecting) {
      para += decodeEntities(body.slice(i, lt));
    }
    const gt = body.indexOf('>', lt);
    if (gt < 0) break;
    const rawTag = body.slice(lt + 1, gt);
    const isClose = rawTag.startsWith('/');
    const selfClose = rawTag.endsWith('/');
    const name = localName(isClose ? rawTag.slice(1) : rawTag);

    if (name === 't') {
      collecting = !isClose && !selfClose;
    } else if (name === 'tab' && !isClose) {
      if (collecting) para += '\t';
    } else if (name === 'br' && !isClose) {
      if (collecting) para += '\n';
    } else if (name === 'tbl') {
      if (isClose) {
        if (tableRows.length) blocks.push({ type: 'table', rows: tableRows });
        tableRows = [];
        inTable = false;
      } else {
        inTable = true;
        tableRows = [];
      }
    } else if (name === 'tr') {
      if (isClose) {
        if (row.length) tableRows.push(row);
        row = [];
      } else {
        row = [];
      }
    } else if (name === 'tc') {
      if (isClose) {
        row.push(cell.trim());
        cell = '';
      } else {
        cell = '';
      }
    } else if (name === 'p') {
      if (isClose) {
        flushPara();
      } else {
        para = '';
      }
    }

    i = gt + 1;
  }

  return blocks;
}

export type DocxContent = {
  blocks: DocxBlock[];
  /** 纯文本（段落按行、表格按行拼接），用于资料原文存档 */
  text: string;
  paragraphCount: number;
  tableCount: number;
};

export function docxContentToText(blocks: DocxBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type === 'p') lines.push(b.text);
    else for (const r of b.rows) lines.push(r.join('\t'));
  }
  return lines.join('\n');
}

/**
 * 读取本地 docx：支持 .docx/.dotx（ZIP 容器）。
 * .doc / .wps（二进制老格式）不支持，需先另存为 .docx —— 这里显式报错，不做静默降级。
 */
export function readDocx(filePath: string): DocxContent {
  const buf = fs.readFileSync(filePath);
  // ZIP 魔数 PK\x03\x04；老式 .doc 是 D0CF11E0（OLE 复合文档），必须明确拒绝
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0xe011cfd0) {
    throw new Error(
      '这是老式二进制 Word（.doc/.wps），不是 ZIP 容器的 .docx。请用 WPS/Word 另存为 .docx 后再导入。',
    );
  }
  const xmlBuf = readZipEntry(buf, 'word/document.xml');
  if (!xmlBuf) throw new Error('docx 内未找到 word/document.xml，文件可能已损坏');
  const blocks = parseDocumentXml(xmlBuf.toString('utf8'));
  return {
    blocks,
    text: docxContentToText(blocks),
    paragraphCount: blocks.filter((b) => b.type === 'p').length,
    tableCount: blocks.filter((b) => b.type === 'table').length,
  };
}
