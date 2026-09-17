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
    return ok({ username: user.username, displayName: user.displayName, role: user.role });
  } catch (e) {
    return handleError(e);
  }
}
