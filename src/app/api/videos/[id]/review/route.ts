import { requireUser } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { markReviewed } from '@/lib/services/script';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = await readJson<{ revisionId: string; acknowledgeProblems?: boolean }>(req);
    const r = await markReviewed({
      videoId: params.id,
      ownerId: user.id,
      revisionId: body.revisionId,
      acknowledgeProblems: Boolean(body.acknowledgeProblems),
    });
    return ok(r);
  } catch (e) {
    return handleError(e);
  }
}
