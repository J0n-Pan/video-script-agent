import fs from 'node:fs';
import { Readable } from 'node:stream';
import { requireUser, HttpError } from '@/lib/auth';
import { handleError } from '@/lib/api';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * 已完成数字人视频的鉴权预览 / 下载（§9）。
 *
 * 两条硬要求：
 * 1. **归属鉴权**：查得到任务不等于能拿视频，必须走 job.ownerId 这一层（A19）；
 * 2. **只读本地持久化文件**：不接受任何客户端传入的路径，文件来自 GeneratedVideoAsset（§7.5）。
 *
 * 支持 Range 请求，否则浏览器里拖动进度条会一直重新下载整个文件。
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const asset = await prisma.generatedVideoAsset.findFirst({
      where: { avatarVideoJobId: params.id, job: { ownerId: user.id } },
      include: { job: { select: { businessName: true } } },
    });
    if (!asset) throw new HttpError(404, '成品不存在或无权访问');
    if (asset.status !== 'READY') throw new HttpError(409, `成品状态为 ${asset.status}，暂不可下载：${asset.failReason ?? ''}`);
    if (!fs.existsSync(asset.filePath)) throw new HttpError(410, '成品文件已不在服务器上（可能被清理），请重新生成或核对平台记录');

    const stat = fs.statSync(asset.filePath);
    const asAttachment = new URL(req.url).searchParams.get('download') === '1';
    const fileName = asset.fileName || `${asset.job.businessName}.mp4`;
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      // 私有内容，禁止中间层缓存
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${asAttachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    };

    const range = req.headers.get('range');
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        }
        const stream = fs.createReadStream(asset.filePath, { start, end });
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          },
        });
      }
    }

    const stream = fs.createReadStream(asset.filePath);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(stat.size) },
    });
  } catch (e) {
    return handleError(e);
  }
}
