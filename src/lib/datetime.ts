/**
 * 时间格式化（本地时区）。
 *
 * 为什么单独放一个模块：妙思会话的到期时间在三个地方展示
 * （服务端拼的判定文案、页头提示栏、会话页），
 * 直接对 ISO 字符串做 slice(0,16) 会得到 **UTC 时间**，
 * 于是同一件事在两处显示成「2026-09-17 21:26」和「2026/9/18 05:26」，
 * 用户会以为是两个时间。统一走这里，保证展示口径一致。
 */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * @param iso ISO 时间字符串
 * @param withSeconds 是否带秒（默认不带）
 * @returns 形如 `2026-09-18 05:26`；无法解析时返回空串
 */
export function fmtLocal(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

/** 带秒的完整本地时间，用于「会话文件更新于」「上次检测」这类需要精确到秒的位置 */
export function fmtLocalFull(iso: string | null | undefined): string {
  const v = fmtLocal(iso, true);
  return v || '—';
}

/** 相对时间：避免用户去比对绝对时间戳 */
export function agoText(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '从未检测';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '时间未知';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
