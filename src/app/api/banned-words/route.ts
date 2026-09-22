import { requireUser } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import { getActiveProfile, PROFILE_KIND } from '@/lib/rewrite/profile';
import { readBannedPack } from '@/lib/rewrite/banned';

export const dynamic = 'force-dynamic';

/**
 * 当前生效的违禁词表（供界面**实时高亮**用）。
 *
 * 为什么要给前端再扫一遍：命中标记必须是"按当前正文重算"的，而不是生成时写死的快照 ——
 * 编导改掉命中词之后高亮要立刻消失（生成时的标记做不到这一点，因为它记的是那一刻的正文）。
 * 服务端在生成/重新生成时也会扫一次并写进问题清单，两处同源（都调 scanBannedWords）。
 *
 * 没有配置资料包时返回空列表 + configured=false，**不是错误** ——
 * 没上传违禁词包是合法状态，界面据此不显示任何高亮。
 */
export async function GET() {
  try {
    const user = await requireUser();
    const profile = await getActiveProfile(user.id, PROFILE_KIND.BANNED);
    if (!profile) {
      return ok({ configured: false, versionNo: null, title: '', entries: [] });
    }
    const pack = readBannedPack(profile.profileJson);
    return ok({
      configured: true,
      versionNo: profile.versionNo,
      title: profile.title,
      entries: pack.entries.map((e) => ({ text: e.text, category: e.category })),
    });
  } catch (e) {
    return handleError(e);
  }
}
