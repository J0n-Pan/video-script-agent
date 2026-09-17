import fs from 'node:fs';
import { Readable } from 'node:stream';
import { requireUser } from '@/lib/auth';
import { handleError, fail } from '@/lib/api';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
};

/**
 * 播放使用主机保存的视频副本（PRD 3.4 / 11.1）：
 * 原文件移动、临时链接失效不影响复核。后端做账号归属校验，支持 Range 拖动进度。
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const video = await prisma.video.findFirst({
      where: { id: params.id, ownerId: user.id, deletedAt: null },
      include: { media: true },
    });
    if (!video) return fail(404, '任务不存在或无权访问');
    const media = video.media;
    if (!media || media.status !== 'READY' || !fs.existsSync(media.cachePath)) {
      return fail(409, '主机视频副本不可用，请重新获取或本地补传');
    }
    const stat = fs.statSync(media.cachePath);
    const ext = media.cachePath.slice(media.cachePath.lastIndexOf('.')).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    const range = req.headers.get('range');

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || end < start) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
      }
      const stream = fs.createReadStream(media.cachePath, { start, end });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
      });
    }

    const stream = fs.createReadStream(media.cachePath);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
