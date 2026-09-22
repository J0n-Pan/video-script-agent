import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { regenerateRewrite } from '@/lib/rewrite/service';

export const dynamic = 'force-dynamic';

/**
 * 主动重新生成（§9）。
 *
 * - variantNos 不传 = 全部版本；传了就只重跑指定版本；
 * - **保留旧稿**：对目标版本追加新修订，历史修订仍在库中；
 * - 不复用前端传入的模型 —— 用任务当时锁定的模型，保证同一任务内的稿件风格可比（要换模型请新建任务）。
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = await readJson<{ variantNos?: number[] }>(req);
    const variantNos = Array.isArray(body.variantNos)
      ? body.variantNos.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
      : [];

    const r = await regenerateRewrite({ ownerId: user.id, jobId: params.id, variantNos });
    if (r.regeneratedVariantNos.length === 0) {
      throw new HttpError(502, '没有任何版本重新生成成功，已保留原稿；请查看问题项后重试');
    }
    return ok(r);
  } catch (e) {
    return handleError(e);
  }
}
