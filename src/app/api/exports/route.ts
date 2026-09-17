import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok, readJson } from '@/lib/api';
import { prisma } from '@/lib/db';
import { createExport, normalizeExportKind, validateExport, type ExportRequestItem } from '@/lib/export/service';
import { EXPORT_KIND_LABEL } from '@/lib/constants';

export const dynamic = 'force-dynamic';

/**
 * 导出确认页：
 * - confirm=false：只校验，逐项说明不可导出原因，禁止静默少导出；
 * - confirm=true ：按 kind 生成文件（SCRIPT 信息流脚本 / LIBRARY 信息流素材库）。
 * 两种响应以 stage 区分（VALIDATE / BLOCKED / DONE），前端必须按 stage 处理。
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await readJson<{ items: ExportRequestItem[]; confirm?: boolean; kind?: string }>(req);
    const items = (body.items ?? []).filter((i) => i?.videoId);
    if (items.length === 0) throw new HttpError(400, '未选择任何视频');
    const kind = normalizeExportKind(body.kind);

    if (!body.confirm) {
      const v = await validateExport(user.id, items);
      return ok({ stage: 'VALIDATE', kind, kindLabel: EXPORT_KIND_LABEL[kind], exportable: v.exportable.length, blocked: v.blocked });
    }
    const r = await createExport(user.id, items, kind);
    if (!r.ok) return ok({ stage: 'BLOCKED', kind, blocked: r.blocked });
    return ok({
      stage: 'DONE',
      kind,
      kindLabel: EXPORT_KIND_LABEL[kind],
      exportId: r.exportId,
      fileName: r.fileName,
      itemCount: r.itemCount,
      downloadUrl: `/api/exports/${r.exportId}/download`,
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const list = await prisma.exportRecord.findMany({
      where: { ownerId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { items: true },
    });
    return ok({
      rows: list.map((e) => ({
        id: e.id,
        fileName: e.fileName,
        itemCount: e.itemCount,
        status: e.status,
        createdAt: e.createdAt,
        downloadUrl: `/api/exports/${e.id}/download`,
      })),
    });
  } catch (e) {
    return handleError(e);
  }
}
