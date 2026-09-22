import { prisma } from '@/lib/db';
import { createSession, verifyPassword } from '@/lib/auth';
import { fail, handleError, ok, readJson } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await readJson<{ username?: string; password?: string }>(req);
    const username = (body.username ?? '').trim();
    const password = body.password ?? '';
    if (!username || !password) return fail(400, '请输入账号和密码');

    const user = await prisma.user.findUnique({ where: { username } });
    // 无效凭证不泄露账号详情
    if (!user || user.status !== 'ACTIVE' || !verifyPassword(password, user.passwordHash)) {
      return fail(401, '账号或密码不正确');
    }
    await createSession(user.id);
    // 带上自己的 id：登录页要用它清掉「本浏览器已检查过妙思」的记忆，
    // 让「每次登录工作台后自动检查妙思登录态」成立（见 src/lib/muse-ui.ts）
    return ok({ id: user.id, username: user.username, displayName: user.displayName, role: user.role });
  } catch (e) {
    return handleError(e);
  }
}
