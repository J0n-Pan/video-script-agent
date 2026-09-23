import { prisma } from '@/lib/db';
import { hashPassword, requireUser, verifyPassword } from '@/lib/auth';
import { fail, handleError, ok, readJson } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * 修改自己的密码。
 * 这是「首次登录强制改密」的落点：初始口令由安装包统一分发，
 * 编导登录后必须换成一个自己的口令，之后 mustChangePassword 置 false，
 * 业务接口才放行（拦截在 requireUser 里）。
 */
export async function POST(req: Request) {
  try {
    // 必须显式放行：未改密的会话此刻只能调改密和登出
    const user = await requireUser({ allowStalePassword: true });
    const body = await readJson<{ oldPassword?: string; newPassword?: string }>(req);
    const oldPassword = body.oldPassword ?? '';
    const newPassword = body.newPassword ?? '';
    if (!oldPassword || !newPassword) return fail(400, '请填写原密码和新密码');
    if (newPassword.length < 8) return fail(400, '新密码至少 8 位');
    if (newPassword === oldPassword) return fail(400, '新密码不能与原密码相同');

    const me = await prisma.user.findUnique({ where: { id: user.id } });
    if (!me) return fail(401, '账号不存在');
    if (!verifyPassword(oldPassword, me.passwordHash)) return fail(400, '原密码不正确');

    await prisma.user.update({
      where: { id: me.id },
      data: { passwordHash: hashPassword(newPassword), mustChangePassword: false },
    });
    return ok({ changed: true });
  } catch (e) {
    return handleError(e);
  }
}
