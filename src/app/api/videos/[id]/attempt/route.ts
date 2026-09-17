import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { cancelQueuedVideo, reparse, retry } from '@/lib/services/script';

export const dynamic = 'force-dynamic';

/** 重试 / 重新解析 / 取消排队：都保留原视频记录与尝试历史，新尝试排到队尾 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = await readJson<{ action: 'retry' | 'reparse' | 'cancel' }>(req);
    switch (body.action) {
      case 'retry':
        return ok(await retry(params.id, user.id));
      case 'reparse':
        return ok(await reparse(params.id, user.id));
      case 'cancel':
        return ok(await cancelQueuedVideo(params.id, user.id));
      default:
        throw new HttpError(400, '不支持的操作');
    }
  } catch (e) {
    return handleError(e);
  }
}
