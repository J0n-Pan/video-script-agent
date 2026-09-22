import { requireUser } from '@/lib/auth';
import { fail, handleError, ok } from '@/lib/api';
import { listPlatformWorks } from '@/lib/avatar/service';

export const dynamic = 'force-dynamic';

/**
 * 只读平台「我的作品」列表（2026-09-22 新增）。
 *
 * 界面用它渲染「绑定平台作品」的点选列表：编导在平台上改了名之后，
 * 唯一能把任务和作品重新对上的线索就是这张列表（平台作品 ID + 当前作品名 + 状态 + 提交时间）。
 *
 * 注意这里是**真实访问平台**（打开有头/无头浏览器读列表），不是读本地缓存：
 * 编导刚改完名就要能立刻看到新名字，缓存会让这个入口失去意义。
 */
export async function GET(req: Request) {
  try {
    await requireUser();
    const limit = Number(new URL(req.url).searchParams.get('limit') ?? 20);
    const r = await listPlatformWorks(Number.isFinite(limit) ? limit : 20);
    return ok(r);
  } catch (e) {
    // 会话失效、适配器不支持这类「原因明确」的错误直接透给界面（400），不吞成 500
    if (e instanceof Error && !('status' in e)) return fail(400, e.message);
    return handleError(e);
  }
}
