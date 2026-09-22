import { requireUser } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import { reconcileAvatarJob } from '@/lib/avatar/service';

export const dynamic = 'force-dynamic';

/**
 * 重新核对平台记录（§9）。
 *
 * **不等同于重新提交**：只查平台现状并据此推进状态，查到已完成就取回成品。
 * 这是「结果不明 → 结果待核对」任务的正规出路 —— 靠核对而不是靠重试来消除不确定性，
 * 避免重复提交造成重复计费（A16）。
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const r = await reconcileAvatarJob(user.id, params.id);
    return ok(r);
  } catch (e) {
    return handleError(e);
  }
}
