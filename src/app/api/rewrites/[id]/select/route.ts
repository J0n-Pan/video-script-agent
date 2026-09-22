import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { selectRewriteRevision } from '@/lib/rewrite/service';

export const dynamic = 'force-dynamic';

/**
 * 选定一个已保存修订（§9 / A12）。
 * 只有**已保存且当前生效**的修订才能被选定 —— 界面上未保存的编辑不能直接用于视频。
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = await readJson<{ revisionId?: string }>(req);
    if (!body.revisionId) throw new HttpError(400, '缺少 revisionId');
    const r = await selectRewriteRevision({ ownerId: user.id, jobId: params.id, revisionId: body.revisionId });
    return ok(r);
  } catch (e) {
    return handleError(e);
  }
}
