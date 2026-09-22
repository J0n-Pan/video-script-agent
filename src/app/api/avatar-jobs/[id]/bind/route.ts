import { requireUser, HttpError } from '@/lib/auth';
import { fail, handleError, ok, readJson } from '@/lib/api';
import { bindAvatarJobWork } from '@/lib/avatar/service';

export const dynamic = 'force-dynamic';

/**
 * 把平台上的某条作品**绑定**到这条数字人任务上（2026-09-22 新增）。
 *
 * 场景：编导在平台上把作品改了名（平台会给名字追加 `_<账号内序号>`，人也可以整条改名），
 * 而我们原先只靠「唯一作品名」对账 —— 名字一改就再也认不出那条作品，一条已经出片的任务
 * 会被判成「查不到作品」。平台**作品 ID 不随改名变化**，所以补一个按 ID 重新关联的入口。
 *
 * 只接受 `{ workId, workName }` 其一，服务端会去平台作品列表里核实它真实存在再写库
 * —— 前端传什么就绑什么是不行的，那等于让一个笔误把任务指到别人的作品上。
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = await readJson<{ workId?: string; workName?: string }>(req);
    const r = await bindAvatarJobWork(user.id, params.id, { workId: body.workId, workName: body.workName });
    return ok(r);
  } catch (e) {
    /**
     * 绑定失败几乎都是「操作前提不满足」—— 状态不对、ID 填错、平台上找不到那条作品。
     * 这些都要原文透给编导看（他得据此改操作），所以归 400 而不是 500；
     * 真正的服务端异常仍走统一出口（不暴露堆栈）。
     */
    if (e instanceof HttpError) return handleError(e);
    if (e instanceof Error) return fail(400, e.message);
    return handleError(e);
  }
}
