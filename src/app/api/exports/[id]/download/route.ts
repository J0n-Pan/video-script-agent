import fs from 'node:fs';
import { Readable } from 'node:stream';
import { requireUser } from '@/lib/auth';
import { handleError, fail } from '@/lib/api';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 导出文件下载必须鉴权（PRD 9 / 11.2）。
 *
 * 失败原因必须区分开（2026-09-16 修复）：
 * 之前无论哪种情况都返回「导出文件不存在或无权访问」，一旦前端传了 undefined 或错账号，
 * 排查时无法定位。现在分别给出记录不存在 / 不属于当前账号 / 文件已被清理三种说明。
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    if (!params.id || params.id === 'undefined' || params.id === 'null') {
      return fail(400, '下载地址缺少导出记录标识，请回到导出页重新导出后再下载');
    }
    const record = await prisma.exportRecord.findUnique({ where: { id: params.id } });
    if (!record) return fail(404, '导出记录不存在（可能已被清理，例如包含的任务被删除），请重新导出');
    if (record.ownerId !== user.id) {
      return fail(403, '该导出文件不属于当前登录账号，请用导出时的账号登录后下载');
    }
    if (!record.filePath || !fs.existsSync(record.filePath)) {
      return fail(410, '导出文件已被清理（可能因为关联视频被删除），请重新导出');
    }
    const stream = fs.createReadStream(record.filePath);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.fileName)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
