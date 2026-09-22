import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import { getRewriteJob, getCurrentSelection, viewVariantsOfJob } from '@/lib/rewrite/service';
import { latestAvatarJobIdForRewriteJob } from '@/lib/avatar/service';
import { REWRITE_PLATFORM_LABEL } from '@/lib/rewrite/rules';

export const dynamic = 'force-dynamic';

/**
 * 创作任务详情（§9）：任务状态 + 各版本当前生效修订 + 参考稿对照 + 当前选定。
 *
 * 参考稿从**任务快照**取，不回读 ScriptRevision —— 这样界面看到的就是本次生成真正用的基准，
 * 即使编导后来改了原稿也不会让「对照」失真（A11）。
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const job = await getRewriteJob(user.id, params.id);
    if (!job) throw new HttpError(404, '创作任务不存在或无权访问');

    let snap: Record<string, any> = {};
    try {
      snap = JSON.parse(job.inputSnapshot || '{}');
    } catch {
      snap = {};
    }
    const refs: Array<{ id: string; orderIndex: number; tag: string; copyText: string }> = Array.isArray(snap.refSegments)
      ? snap.refSegments
      : [];

    const variants = await viewVariantsOfJob(job.id);
    const selection = await getCurrentSelection(user.id, job.id);
    // 刷新/重进页面后仍能看到同一条数字人任务（否则卡片只活在组件内存里）
    const avatarJobId = await latestAvatarJobIdForRewriteJob(user.id, job.id);

    return ok({
      id: job.id,
      status: job.status,
      stage: job.stage,
      platform: job.platform,
      platformLabel: REWRITE_PLATFORM_LABEL(job.platform),
      variantCount: job.variantCount,
      modelId: job.modelId,
      promptVersion: job.promptVersion,
      ruleVersion: job.ruleVersion,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      sourceVideo: job.sourceVideo
        ? { id: job.sourceVideo.id, title: job.sourceVideo.title, sourceTitle: job.sourceVideo.sourceTitle, durationMs: job.sourceVideo.durationMs }
        : null,
      // 来源视频被删除后仍可查看已生成的稿件（A22）
      sourceMissing: !job.sourceVideo,
      ipProfile: job.ipProfile ? { id: job.ipProfile.id, versionNo: job.ipProfile.versionNo, title: job.ipProfile.title } : null,
      sourceRevisionId: job.sourceRevisionId,
      refs,
      // 快照里记了当时的整段一致性判断；老任务缺字段时不误报为不一致
      transcriptConsistent: snap.transcriptConsistent !== false,
      transcriptNotice: typeof snap.transcriptNotice === 'string' ? snap.transcriptNotice : '',
      variants,
      selection: selection
        ? { id: selection.id, variantId: selection.variantId, revisionId: selection.revisionId, createdAt: selection.createdAt }
        : null,
      avatarJobId,
    });
  } catch (e) {
    return handleError(e);
  }
}
