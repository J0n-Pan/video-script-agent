import fs from 'node:fs';
import { fail, handleError } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { qrPath, readLoginStatus } from '@/lib/sources/muse-health';

export const dynamic = 'force-dynamic';

/**
 * 二维码图片（worker 无头浏览器取回后落盘，这里原样转发给浏览器）。
 *
 * 为什么不让前端直接去拉微信那个图片地址：
 *   1. 那个地址带一次性 ticket，暴露到前端没有意义；
 *   2. 由本端点统一加 no-store，避免浏览器缓存到上一轮的旧码；
 *   3. 前端只认一个同源地址，页面不依赖浏览器的外网可达性。
 *
 * 注意：**扫码仍然发生在 worker 的 Playwright 上下文里**。
 * 这里转发的只是「图」，不是登录动作 —— 扫码后 cookie 落进 worker 里
 * **该用户自己**的会话文件，这正是抓取能恢复的原因。
 *
 * 2026-09-22：二维码按用户取（`users/<自己的 id>/qr.jpg`）。
 * 不传 userId、也不接受 userId 参数 —— 只能看自己那张码，
 * 否则就成了「用别人的二维码登录别人的账号」。
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();

    const status = readLoginStatus(user.id);
    if (status.phase !== 'WAITING_SCAN' && status.phase !== 'STARTING') {
      return fail(404, '当前没有等待扫码的登录，请先点击「开始扫码登录」。');
    }

    const file = qrPath(user.id);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return fail(404, '二维码尚未生成，请稍候重试。');
    }
    if (buf.length === 0) return fail(404, '二维码文件为空，请点击「刷新二维码」。');

    // 前端用 ?t=<qrAt> 破缓存；这里再兜一层 no-store
    const url = new URL(req.url);
    const t = url.searchParams.get('t') ?? '';

    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(buf.length),
        'cache-control': 'no-store, no-cache, must-revalidate',
        'x-qr-at': status.qrAt ?? '',
        'x-qr-req': t,
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
