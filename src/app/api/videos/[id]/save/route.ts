import { requireUser } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { saveRevision, type SegmentInput } from '@/lib/services/script';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = await readJson<{
      baseRevisionId: string;
      segments: SegmentInput[];
      sceneOverview?: string;
      transcriptText?: string;
    }>(req);
    const r = await saveRevision({
      videoId: params.id,
      ownerId: user.id,
      baseRevisionId: body.baseRevisionId,
      segments: body.segments ?? [],
      sceneOverview: body.sceneOverview,
      transcriptText: body.transcriptText,
    });
    return ok(r);
  } catch (e) {
    return handleError(e);
  }
}
