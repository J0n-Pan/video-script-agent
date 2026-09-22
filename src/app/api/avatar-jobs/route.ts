import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { createAvatarJob, avatarAdapterSummary } from '@/lib/avatar/service';

export const dynamic = 'force-dynamic';

/**
 * 为选定稿件创建数字人任务（§9）。
 *
 * 只创建任务并入队，**提交动作由独立的数字人 worker 执行** —— 平台等待可能十几分钟，
 * 放在 HTTP 请求里会把连接拖死，也会阻塞用户的其它操作（A21）。
 *
 * idempotencyKey 由前端在「一次点击」时生成：双击或重复请求命中同一键就回放原任务，不产生第二次提交（A16）。
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await readJson<{ revisionId?: string; idempotencyKey?: string | null }>(req);
    if (!body.revisionId) throw new HttpError(400, '缺少 revisionId（必须提交已选定的稿件修订）');

    const r = await createAvatarJob({
      ownerId: user.id,
      revisionId: body.revisionId,
      idempotencyKey: body.idempotencyKey ?? null,
    });
    return ok({ ...r, adapter: avatarAdapterSummary() });
  } catch (e) {
    return handleError(e);
  }
}
