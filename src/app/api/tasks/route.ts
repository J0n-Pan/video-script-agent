import { requireUser } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { prisma } from '@/lib/db';
import { submitBatch, type SubmitRow } from '@/lib/services/submit';
import { queuePosition } from '@/lib/queue';
import { STAGE_LABEL, VIDEO_STATUS_LABEL, REVIEW_STATUS_LABEL } from '@/lib/constants';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await readJson<{ clientKey: string; rows: SubmitRow[] }>(req);
    const result = await submitBatch(user.id, body.clientKey, body.rows ?? []);
    return ok(result);
  } catch (e) {
    return handleError(e);
  }
}

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') ?? '').trim();
    const status = url.searchParams.get('status') ?? '';
    const review = url.searchParams.get('review') ?? '';

    const videos = await prisma.video.findMany({
      where: {
        ownerId: user.id,
        deletedAt: null,
        ...(status ? { status } : {}),
        ...(q ? { OR: [{ title: { contains: q } }, { fileName: { contains: q } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        classification: true,
        revisions: { where: { isCurrent: true }, select: { id: true, reviewStatus: true, versionNo: true } },
      },
      take: 300,
    });

    const rows = [];
    for (const v of videos) {
      const rev = v.revisions[0];
      if (review && (rev?.reviewStatus ?? 'NOT_REVIEWED') !== review) continue;
      rows.push({
        id: v.id,
        seq: v.seq,
        title: v.title,
        fileName: v.fileName,
        originalPath: v.originalPath,
        sourceType: v.sourceType,
        sourceUrl: v.sourceUrl,
        durationMs: v.durationMs,
        status: v.status,
        statusLabel: VIDEO_STATUS_LABEL[v.status] ?? v.status,
        currentStage: v.currentStage,
        currentStageLabel: v.currentStage ? STAGE_LABEL[v.currentStage] ?? v.currentStage : null,
        form: v.classification?.categoryLabel ?? null,
        formCategory: v.classification?.category ?? null,
        manualOverride: v.classification?.manualOverride ?? false,
        aiRatio: v.classification?.aiRatio ?? null,
        ratioEstimated: v.classification?.ratioEstimated ?? null,
        reviewStatus: rev?.reviewStatus ?? null,
        reviewStatusLabel: rev ? REVIEW_STATUS_LABEL[rev.reviewStatus] : null,
        currentRevisionId: rev?.id ?? null,
        versionNo: rev?.versionNo ?? null,
        problemFlags: JSON.parse(v.problemFlags || '[]'),
        createdAt: v.createdAt,
        queuePosition: v.status === 'QUEUED' ? await queuePosition(v.id, user.id) : null,
      });
    }
    return ok({ rows });
  } catch (e) {
    return handleError(e);
  }
}
