import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { cfg, ensureDirs } from '../config';
import { enqueueAttempt, nextQueueSeq } from '../queue';
import { HttpError } from '../auth';
import { MISSING } from '../constants';
import { safeExt, baseFileName } from '../storage';

export type SubmitRow = {
  clientRowKey: string;
  sourceType: 'LOCAL' | 'TENCENT_MUSE';
  title?: string;
  sourceUrl?: string;
  originalPath?: string;
  /** 已完整上传的暂存文件标识（uploads 接口返回） */
  stageId?: string;
  fileName?: string;
};

export type SubmitRowResult = {
  clientRowKey: string;
  ok: boolean;
  videoId?: string;
  error?: string;
};

/**
 * 批量提交（PRD 3.4 / 10.2）：
 * - 同次重复提交幂等：以 (ownerId, clientKey) 唯一约束挡住重复批次
 * - 逐行返回成功或错误；失败行保留原因，合法行可独立提交，失败行不占解析槽位
 * - 本地文件必须完整保存到主机后才能入队
 */
export async function submitBatch(ownerId: string, clientKey: string, rows: SubmitRow[]) {
  if (!clientKey) throw new HttpError(400, '缺少提交幂等标识');
  if (rows.length === 0) throw new HttpError(400, '清单为空');
  if (rows.length > cfg.limits.maxBatchRows) {
    throw new HttpError(400, `单批次最多 ${cfg.limits.maxBatchRows} 条`);
  }

  const existing = await prisma.batch.findUnique({
    where: { ownerId_clientKey: { ownerId, clientKey } },
    include: { videos: { select: { id: true, clientRowKey: true } } },
  });
  if (existing) {
    // 同次重发不重复创建
    return {
      batchId: existing.id,
      duplicated: true,
      results: rows.map<SubmitRowResult>((r) => {
        const v = existing.videos.find((x) => x.clientRowKey === r.clientRowKey);
        return v
          ? { clientRowKey: r.clientRowKey, ok: true, videoId: v.id }
          : { clientRowKey: r.clientRowKey, ok: false, error: '重复提交，未创建新任务' };
      }),
    };
  }

  ensureDirs();
  const batch = await prisma.batch.create({ data: { ownerId, clientKey } });
  const results: SubmitRowResult[] = [];

  for (const row of rows) {
    try {
      const validated = validateRow(row);
      // 先确认本地文件已完整落盘，再创建任务记录：校验失败的行不留半成品、不占解析槽位
      let staged: string | null = null;
      let stagedSize = 0;
      if (row.sourceType === 'LOCAL') {
        if (!row.stageId) throw new Error('本地文件尚未完整上传，未入解析队列');
        staged = stagedPath(row.stageId);
        if (!fs.existsSync(staged)) throw new Error('暂存文件不存在，请重新上传');
        stagedSize = fs.statSync(staged).size;
      }

      const seq = await nextQueueSeq();
      const video = await prisma.video.create({
        data: {
          ownerId,
          batchId: batch.id,
          seq,
          clientRowKey: row.clientRowKey,
          title: validated.title,
          titleSource: validated.title ? 'MANUAL' : 'NONE',
          // 原视频标题（本地导入 = 原文件名）：提交时就落库，不等解析完成
          ...(row.sourceType === 'LOCAL' && validated.fileName ? { sourceTitle: validated.fileName } : {}),
          sourceType: row.sourceType,
          sourceUrl: validated.sourceUrl,
          sourceUrlText: validated.sourceUrl,
          fileName: validated.fileName,
          originalPath: validated.originalPath,
          status: 'UPLOADING',
          currentStage: null,
        },
      });

      await prisma.mediaAsset.create({
        data:
          row.sourceType === 'LOCAL'
            ? {
                videoId: video.id,
                cachePath: staged!,
                fileName: validated.fileName ?? 'unknown',
                sizeBytes: stagedSize,
                status: 'PENDING',
              }
            : { videoId: video.id, cachePath: '', fileName: validated.fileName ?? '', status: 'PENDING' },
      });

      await enqueueAttempt(video.id, 'INITIAL');
      await prisma.video.update({ where: { id: video.id }, data: { status: 'QUEUED' } });
      results.push({ clientRowKey: row.clientRowKey, ok: true, videoId: video.id });
    } catch (e) {
      results.push({ clientRowKey: row.clientRowKey, ok: false, error: (e as Error).message });
    }
  }

  if (results.every((r) => !r.ok)) {
    await prisma.batch.delete({ where: { id: batch.id } }).catch(() => undefined);
  }
  return { batchId: batch.id, duplicated: false, results };
}

function validateRow(row: SubmitRow) {
  const title = (row.title ?? '').trim();
  const sourceUrl = (row.sourceUrl ?? '').trim();

  if (row.sourceType === 'TENCENT_MUSE') {
    if (!sourceUrl) throw new Error('链接任务必须提供素材链接');
    let u: URL;
    try {
      u = new URL(sourceUrl);
    } catch {
      throw new Error('链接格式无法解析');
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('仅支持 http/https 链接');
    if (!['admuse.qq.com'].includes(u.hostname)) {
      throw new Error('仅支持 admuse.qq.com 下的腾讯妙思素材链接');
    }
  } else if (!row.stageId) {
    throw new Error('必须提供视频文件或素材链接');
  }

  const fileName = row.fileName ? baseFileName(row.fileName) : '';
  if (fileName) {
    const ext = safeExt(fileName);
    if (ext && !cfg.limits.allowedExtensions.includes(ext)) {
      throw new Error(`暂不支持的格式 ${ext}；当前支持：${cfg.limits.allowedExtensions.join(' ')}`);
    }
  }

  return {
    title: title || null,
    sourceUrl: sourceUrl || null,
    fileName: fileName || null,
    originalPath: (row.originalPath ?? '').trim() || null,
  };
}

export function stagesDir() {
  const dir = path.join(cfg.tmpDir, 'stage');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function stagedPath(stageId: string) {
  // stageId 由服务端生成，这里再做一次白名单校验并确认解析后仍位于暂存目录内，避免路径穿越
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$/.test(stageId)) throw new Error('非法的暂存文件标识');
  const dir = stagesDir();
  const full = path.resolve(dir, stageId);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('非法的暂存文件标识');
  return full;
}

export function videoTitleDisplay(v: { title: string | null; fileName: string | null }) {
  return v.title?.trim() || MISSING.NOT_PROVIDED;
}
