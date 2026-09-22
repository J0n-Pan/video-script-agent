import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { prisma } from '@/lib/db';
import { cfg } from '@/lib/config';
import { buildRewriteInput, generateRewrite, listRewriteJobs } from '@/lib/rewrite/service';
import { isPlatform, REWRITE_PLATFORMS, REWRITE_PLATFORM_LABEL } from '@/lib/rewrite/rules';
import { getActiveProfile } from '@/lib/rewrite/profile';

export const dynamic = 'force-dynamic';

/**
 * 从已保存的参考版本创建创作任务（需求文档 §9 / §4.1）。
 *
 * 约束：
 * - 只消费**已保存**的分析结果，不重复跑语音/视觉/整理（A01）；
 * - clientKey 幂等：双击或重复请求返回同一任务（A16 的同款思路）；
 * - 归属校验：参考视频必须属于当前用户。
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = await readJson<{
      sourceRevisionId?: string | null;
      platform?: string;
      variantCount?: number;
      ipProfileRevisionId?: string | null;
      clientKey?: string | null;
    }>(req);

    const platform = body.platform && isPlatform(body.platform) ? body.platform : cfg.rewrite.platform;
    if (body.platform && !isPlatform(body.platform)) {
      throw new HttpError(400, `平台取值非法：${body.platform}；可选 ${REWRITE_PLATFORMS.join(' / ')}`);
    }
    const variantCount = Math.max(1, Math.min(Number(body.variantCount) || cfg.rewrite.variantCount, 10));

    const r = await generateRewrite({
      ownerId: user.id,
      sourceVideoId: params.id,
      sourceRevisionId: body.sourceRevisionId ?? null,
      platform,
      variantCount,
      ipProfileRevisionId: body.ipProfileRevisionId ?? null,
      clientKey: body.clientKey ?? null,
    });
    return ok(r);
  } catch (e) {
    return handleError(e);
  }
}

/**
 * 生成页首屏：参考稿预览 + 资料包版本 + 已有创作任务列表。
 *
 * 为什么把「预览」和「列表」放一个接口：进入页面时两者都需要，
 * 且预览会因「没有资料包 / 参考正文为空」而不可用 —— 这种情况要作为**可读提示**返回，
 * 不能直接 500，否则编导看不到原因，也看不到历史任务。
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const video = await prisma.video.findFirst({
      where: { id: params.id, ownerId: user.id, deletedAt: null },
      include: { classification: true },
    });
    if (!video) throw new HttpError(404, '任务不存在或无权访问');

    const jobs = await listRewriteJobs(user.id, video.id);
    const profile = await getActiveProfile(user.id);

    const base = {
      videoId: video.id,
      title: video.title ?? '',
      sourceTitle: video.sourceTitle ?? '',
      durationMs: video.durationMs ?? null,
      formLabel: video.classification?.categoryLabel ?? '未识别',
      status: video.status,
      platform: cfg.rewrite.platform,
      platformLabel: REWRITE_PLATFORM_LABEL(cfg.rewrite.platform),
      platforms: REWRITE_PLATFORMS.map((p) => ({ value: p, label: REWRITE_PLATFORM_LABEL(p) })),
      variantCount: cfg.rewrite.variantCount,
      model: cfg.rewrite.model,
      ipProfile: profile
        ? { id: profile.id, versionNo: profile.versionNo, title: profile.title, factCount: countFacts(profile.profileJson) }
        : null,
      jobs,
    };

    // 参考稿不可用的原因要如实说清（§5.3 / A06），不用空数据糊过去
    try {
      const built = await buildRewriteInput({
        ownerId: user.id,
        sourceVideoId: video.id,
        platform: cfg.rewrite.platform,
        variantCount: cfg.rewrite.variantCount,
      });
      // 参考时间码只用于原片定位与对照；改写稿本身不产出真实时间码（只有估算时长）
      const withTime = await prisma.scriptRevision.findFirst({
        where: { id: built.sourceRevisionId },
        include: { segments: { orderBy: { orderIndex: 'asc' } } },
      });
      const timeById = new Map((withTime?.segments ?? []).map((s) => [s.id, { startMs: s.startMs, endMs: s.endMs }]));

      return ok({
        ...base,
        ready: true,
        blockedReason: '',
        preview: {
          sourceRevisionId: built.sourceRevisionId,
          sourceRevisionVersionNo: built.sourceRevisionVersionNo,
          ipProfileRevisionId: built.ipProfileId,
          ipProfileVersionNo: built.ipProfileVersionNo,
          transcriptConsistent: built.transcriptConsistent,
          transcriptNotice: built.transcriptNotice,
          insightAvailable: Boolean(built.sourceInsightText),
          refs: built.refs.map((r) => ({
            orderIndex: r.orderIndex,
            tag: r.tag,
            copyText: r.copyText,
            startMs: timeById.get(r.id)?.startMs ?? null,
            endMs: timeById.get(r.id)?.endMs ?? null,
          })),
        },
      });
    } catch (e) {
      return ok({
        ...base,
        ready: false,
        blockedReason: e instanceof Error ? e.message : String(e),
        preview: null,
      });
    }
  } catch (e) {
    return handleError(e);
  }
}

function countFacts(profileJson: string): number {
  try {
    const o = JSON.parse(profileJson || '{}');
    return Array.isArray(o?.facts) ? o.facts.length : 0;
  } catch {
    return 0;
  }
}
