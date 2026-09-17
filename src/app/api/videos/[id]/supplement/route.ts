import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import { baseFileName, safeExt } from '@/lib/storage';
import { stagesDir } from '@/lib/services/submit';
import { supplement } from '@/lib/services/script';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 本地补传：浏览器上传能力下由编导选择视频，服务端保存为暂存文件后关联原视频记录。
 * 原链接、已填标题与来源信息保留在同一视频记录中（PRD 3 / A17）。
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new HttpError(400, '未收到文件');
    const name = baseFileName(file.name || 'video');
    const ext = safeExt(name);
    const stageId = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext || '.bin'}`;
    const dest = path.join(stagesDir(), stageId);
    fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
    const r = await supplement(params.id, user.id, stageId, name);
    return ok({ ...r, fileName: name });
  } catch (e) {
    return handleError(e);
  }
}
