import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { saveVariantRevision, type SaveRevisionSegmentInput } from '@/lib/rewrite/service';

export const dynamic = 'force-dynamic';

/**
 * 编导编辑后显式保存（§9 / A10）。
 *
 * 乐观锁：请求必须带**界面打开时**的基准修订 id。若该版本已被其它会话改过，
 * 返回 409 而不是强行覆盖 —— 别人的修改不会被悄悄丢弃，本地未保存内容也还在。
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = await readJson<{ baseRevisionId?: string; segments?: SaveRevisionSegmentInput[] }>(req);
    if (!body.baseRevisionId) throw new HttpError(400, '缺少 baseRevisionId（保存需要基准版本以检测冲突）');
    if (!Array.isArray(body.segments)) throw new HttpError(400, '缺少 segments');

    const r = await saveVariantRevision({
      ownerId: user.id,
      variantId: params.id,
      baseRevisionId: body.baseRevisionId,
      segments: body.segments,
    });
    if (!r.ok) {
      if (r.conflict) throw new HttpError(409, r.message);
      throw new HttpError(400, r.message);
    }
    return ok(r);
  } catch (e) {
    return handleError(e);
  }
}
