import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireUser, HttpError } from '@/lib/auth';
import { fail, handleError, ok } from '@/lib/api';
import { cfg } from '@/lib/config';
import { baseFileName, safeExt } from '@/lib/storage';
import { stagesDir } from '@/lib/services/submit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 上传并登记媒体：文件完整保存到主机暂存目录后才允许提交任务（PRD 10.2）。
 * 失败时清理未完成的临时文件，不产生半成品。
 */
export async function POST(req: Request) {
  try {
    await requireUser();
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new HttpError(400, '未收到文件');
    if (file.size <= 0) throw new HttpError(400, '文件为空');
    if (file.size > cfg.limits.maxFileBytes) {
      throw new HttpError(400, `文件超过当前配置上限 ${(cfg.limits.maxFileBytes / 1024 / 1024 / 1024).toFixed(1)}GB`);
    }
    const name = baseFileName(file.name || 'video');
    const ext = safeExt(name);
    if (ext && !cfg.limits.allowedExtensions.includes(ext)) {
      throw new HttpError(400, `暂不支持的格式 ${ext}；当前支持：${cfg.limits.allowedExtensions.join(' ')}`);
    }

    const stageId = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext || '.bin'}`;
    const dest = path.join(stagesDir(), stageId);
    const buf = Buffer.from(await file.arrayBuffer());
    try {
      fs.writeFileSync(dest, buf);
    } catch (e) {
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        // 忽略
      }
      throw new HttpError(500, `写入暂存文件失败：${(e as Error).message}`);
    }
    return ok({ stageId, fileName: name, sizeBytes: file.size });
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.message);
    return handleError(e);
  }
}
