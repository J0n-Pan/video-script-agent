import { MISSING, EXPORT_KIND_LABEL, type ExportKind } from '../constants';

const INVALID = /[:\\/?*[\]]/g;

/**
 * 工作表名由视频标题生成（PRD 7.1）：
 * 处理重复、非法字符与超长；表内保留完整标题；名称不得成为视频记录的唯一标识。
 */
export function buildSheetNames(titles: Array<{ title?: string | null; seq?: number | null }>): string[] {
  const used = new Set<string>();
  return titles.map((t, i) => {
    let base = (t.title ?? '').trim();
    if (!base) base = `${MISSING.NOT_PROVIDED}_${t.seq ?? i + 1}`;
    base = base.replace(INVALID, '_').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim();
    if (!base) base = `工作表_${i + 1}`;
    // Excel 限制 31 字符
    let name = base.slice(0, 31);
    if (used.has(name)) {
      let n = 2;
      let candidate = '';
      do {
        const suffix = `_${n}`;
        candidate = base.slice(0, 31 - suffix.length) + suffix;
        n += 1;
      } while (used.has(candidate));
      name = candidate;
    }
    used.add(name);
    return name;
  });
}

/** 文件名带导出类型前缀，便于在下载目录里区分三种导出 */
export function buildExportFileName(kind: ExportKind, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${EXPORT_KIND_LABEL[kind] ?? '视频脚本'}_${stamp}.xlsx`;
}

export function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
