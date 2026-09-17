export type SourceFailureCode =
  | 'INVALID_URL'
  | 'ABUSE_LIST_PAGE'
  | 'SESSION_MISSING'
  | 'SESSION_EXPIRED'
  /** 链接打开了，但没进到目标素材详情页（登录态失效或被弹回首页等） */
  | 'MATERIAL_NOT_REACHED'
  | 'MEDIA_NOT_FOUND'
  | 'DOWNLOAD_FAILED'
  | 'CACHE_INCOMPLETE'
  | 'UNSUPPORTED_ADAPTER';

export type RecoveryHint = 'RELOGIN' | 'SUPPLEMENT' | 'FIX_INPUT' | 'RETRY';

export type SourceFetchOk = {
  ok: true;
  localPath: string;
  fileName: string;
  /**
   * 原视频标题（工作台「视频分析」栏字段「原视频标题」）：
   * 本地导入 = 原文件的文件名；链接导入 = 链接对应网页的标题（妙思用素材页标题节点）。
   * 与「任务信息 → 标题」分开：标题可被人工修改，本字段保留原样。
   */
  sourceTitle?: string;
  /**
   * 原网页板块快照（仅妙思来源，填充工作台的「视频分析」栏）：
   * 人群分析（性别/年龄）、视频分镜或高光时序 title、创意标签全量。
   * 原网页没有该板块时为空值并带原因，不留空无据。
   */
  insight?: import('./muse-insight').MuseInsight;
};

export type SourceFetchFail = {
  ok: false;
  code: SourceFailureCode;
  /** 面向编导的准确失败原因（不展示栈信息） */
  message: string;
  recovery: RecoveryHint;
};

export type SourceFetchResult = SourceFetchOk | SourceFetchFail;

export interface SourceAdapter {
  readonly kind: 'LOCAL' | 'TENCENT_MUSE';
  /** 登录态检查：不长期占用解析槽位，缺失/过期立即返回 */
  checkAvailability(): Promise<{ ok: true } | SourceFetchFail>;
  fetch(input: { videoId: string; url?: string | null; stagedPath?: string | null; fileName?: string | null }): Promise<SourceFetchResult>;
}
