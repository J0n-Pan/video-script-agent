/**
 * 妙思相关的前端记忆键（sessionStorage）。
 *
 * ## 为什么要集中定义
 *
 * 这些键有三个写入方/读取方（登录页、自动检查弹窗、顶部提示栏），
 * 而且**必须按用户区分** —— 会话自 2026-09-22 起一人一份，
 * 同一台机器上换个账号登录时，如果记忆键不分人：
 *   - 「本次浏览器已检查过」会让新登录的编导跳过自动检查；
 *   - 「已收起故障提示」会把上一个人的收起继承过来，故障被静默吞掉。
 * 所以键里统一拼上 viewerId，任何人都不要自己拼字符串。
 */

/** 自动检查妙思登录态在本浏览器会话内是否已跑过（每次登录工作台清一次） */
export function museAutoCheckKey(viewerId: string): string {
  return `museAutoChecked:${viewerId}`;
}

/** 顶部故障提示栏的「收起」记忆（按人 + 按状态，状态变过就作废） */
export function museBannerCollapseKey(viewerId: string): string {
  return `museBannerCollapsed:${viewerId}`;
}

/**
 * 登录成功后清掉本人的自动检查记忆，让下一次登录工作台重新走一遍自动检查。
 *
 * 为什么在登录页做而不是在登出按钮做：登出可能发生在会话过期、直接关标签页、
 * 甚至从不点登出（只重开浏览器）等情形，只有「登录成功」这一个点是必然经过的。
 */
export function clearMuseAutoCheck(viewerId: string): void {
  try {
    sessionStorage.removeItem(museAutoCheckKey(viewerId));
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用，忽略即可：最坏就是多检查一次 */
  }
}
