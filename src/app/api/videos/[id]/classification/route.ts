import { requireUser } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { overrideClassification } from '@/lib/services/script';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = await readJson<{ category: string }>(req);
    const r = await overrideClassification({
      videoId: params.id,
      ownerId: user.id,
      operator: user.displayName || user.username,
      category: body.category,
    });
    return ok(r);
  } catch (e) {
    return handleError(e);
  }
}
