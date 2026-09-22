import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import { getAvatarJob, avatarAdapterSummary } from '@/lib/avatar/service';
import { AVATAR_STATUS_LABEL } from '@/lib/avatar/types';
import { isAvatarWorkerRunning } from '@/lib/worker-lock';

export const dynamic = 'force-dynamic';

/**
 * 数字人任务状态、作品关联与错误（§9）。
 *
 * 除任务本身外，还回传两件「决定用户下一步该做什么」的环境事实：
 *   - `adapter.mode`：mock 适配器**不会真的提交到平台**，必须让界面说清，
 *     否则用户会去平台翻记录、以为是平台出了问题（2026-09-21 实测踩到）；
 *   - `avatarWorkerRunning`：数字人任务是独立进程处理的，进程没起就会一直停在「排队中」。
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const job = await getAvatarJob(user.id, params.id);
    if (!job) throw new HttpError(404, '数字人任务不存在或无权访问');
    return ok({
      ...job,
      statusLabel: AVATAR_STATUS_LABEL[job.status] ?? job.status,
      adapter: avatarAdapterSummary(),
      avatarWorkerRunning: isAvatarWorkerRunning(),
    });
  } catch (e) {
    return handleError(e);
  }
}
