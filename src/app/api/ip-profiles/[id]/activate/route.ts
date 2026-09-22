import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * 把某个历史版本重新置为生效版本（§6）。
 *
 * 用途：换文档后想回到上一版；或发现新版本抽取/解析效果不如旧版。
 * 只改 status，**不动任何内容** —— 已生成任务的输入快照仍按各自锁定的版本 ID 取值（A11）。
 *
 * ⚠️ `updateMany` 的 where 必须带 `kind: target.kind`：
 * 两类资料包（IP 事实 / 违禁词）共用一张表，漏掉 kind 会让「把违禁词包设为生效」
 * 顺手把 IP 资料包置为历史版本，改写随后会因为找不到生效资料包而整个失败。
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const target = await prisma.ipProfileRevision.findFirst({ where: { id: params.id, ownerId: user.id } });
    if (!target) throw new HttpError(404, '资料包版本不存在或无权访问');
    if (target.status === 'ACTIVE') {
      return ok({ id: target.id, versionNo: target.versionNo, kind: target.kind, status: 'ACTIVE', changed: false });
    }

    const r = await prisma.$transaction(async (tx) => {
      await tx.ipProfileRevision.updateMany({
        where: { ownerId: user.id, kind: target.kind, status: 'ACTIVE' },
        data: { status: 'SUPERSEDED' },
      });
      return tx.ipProfileRevision.update({ where: { id: target.id }, data: { status: 'ACTIVE' } });
    });

    return ok({ id: r.id, versionNo: r.versionNo, kind: r.kind, status: r.status, changed: true });
  } catch (e) {
    return handleError(e);
  }
}
