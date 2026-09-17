import fs from 'node:fs';
import path from 'node:path';
import { cachePathFor, safeExt, baseFileName, fileSize } from '../storage';
import { cfg } from '../config';
import type { SourceAdapter, SourceFetchResult } from './types';

/**
 * 本地上传来源：文件先完整上传保存后才入队（PRD 6.1）。
 * 这里的「获取」即将已完整落盘的暂存文件复制为主机缓存副本，后续解析与播放都使用该副本。
 */
export class LocalSourceAdapter implements SourceAdapter {
  readonly kind = 'LOCAL' as const;

  async checkAvailability() {
    return { ok: true as const };
  }

  async fetch(input: {
    videoId: string;
    stagedPath?: string | null;
    fileName?: string | null;
  }): Promise<SourceFetchResult> {
    const staged = input.stagedPath;
    if (!staged || !fs.existsSync(staged)) {
      return {
        ok: false,
        code: 'CACHE_INCOMPLETE',
        message: '暂存文件不存在或尚未完整保存，未进入解析队列',
        recovery: 'SUPPLEMENT',
      };
    }
    const ext = safeExt(input.fileName ?? staged) || '.mp4';
    const dest = cachePathFor(input.videoId, ext);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(staged, dest);
    } catch (e) {
      return {
        ok: false,
        code: 'DOWNLOAD_FAILED',
        message: `写入主机缓存失败：${(e as Error).message}`,
        recovery: 'RETRY',
      };
    }
    const size = fileSize(dest);
    if (size <= 0) {
      return { ok: false, code: 'CACHE_INCOMPLETE', message: '缓存文件为空，缓存未完成', recovery: 'RETRY' };
    }
    if (size > cfg.limits.maxFileBytes) {
      return {
        ok: false,
        code: 'CACHE_INCOMPLETE',
        message: `文件大小超过当前配置上限 ${(cfg.limits.maxFileBytes / 1024 / 1024 / 1024).toFixed(1)}GB`,
        recovery: 'FIX_INPUT',
      };
    }
    // 缓存完整后再删除暂存副本，避免「临时下载不等于缓存成功」
    try {
      fs.rmSync(staged, { force: true });
    } catch {
      // 暂存清理失败不影响主流程
    }
    const name = baseFileName(input.fileName ?? path.basename(dest));
    // 本地导入的「原视频标题」就是原文件的文件名
    return { ok: true, localPath: dest, fileName: name, sourceTitle: name };
  }
}
