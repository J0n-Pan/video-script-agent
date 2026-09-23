import { cookies } from 'next/headers';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from './db';

const COOKIE = 'vsa_session';
const TTL_DAYS = 14;

export function hashPassword(pw: string) {
  return bcrypt.hashSync(pw, 10);
}

export function verifyPassword(pw: string, hash: string) {
  return bcrypt.compareSync(pw, hash);
}

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: string;
  /** 用了装机初始口令的账号，首次登录必须先改掉（内测分发：不让一个口令长期通用） */
  mustChangePassword: boolean;
};

export async function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86_400_000);
  await prisma.session.create({ data: { token, userId, expiresAt } });
  cookies().set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  return token;
}

export async function destroySession() {
  const token = cookies().get(COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { token } });
  }
  cookies().delete(COOKIE);
}

/** 后端会话校验：登录态失效即拒绝，不依赖前端隐藏入口（PRD 2.1 实现约定） */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;
  const s = await prisma.session.findUnique({ where: { token }, include: { user: true } });
  if (!s) return null;
  if (s.expiresAt.getTime() < Date.now()) {
    await prisma.session.deleteMany({ where: { token } });
    return null;
  }
  if (s.user.status !== 'ACTIVE') return null;
  return {
    id: s.user.id,
    username: s.user.username,
    displayName: s.user.displayName,
    role: s.user.role,
    mustChangePassword: s.user.mustChangePassword,
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 后端会话校验：登录态失效即拒绝，不依赖前端隐藏入口（PRD 2.1 实现约定）。
 *
 * 默认还会拦住「用了初始口令但还没改密」的会话（409）：
 * 强制改密不能只做在前端——否则改密页只是一道障眼法，直接调接口照样能用初始口令读写数据。
 * 因此需要放行的接口（改密本身、登出）必须显式声明 allowStalePassword。
 */
export async function requireUser(opts?: { allowStalePassword?: boolean }): Promise<SessionUser> {
  const u = await getCurrentUser();
  if (!u) throw new HttpError(401, '未登录或登录态已失效');
  if (u.mustChangePassword && !opts?.allowStalePassword) {
    throw new HttpError(409, '首次登录请先修改密码');
  }
  return u;
}

/** 归属鉴权：编导仅访问本人任务、媒体、截图与导出文件（PRD 7.4 / 11.2） */
export async function requireVideo(ownerId: string, videoId: string) {
  const video = await prisma.video.findFirst({
    where: { id: videoId, ownerId, deletedAt: null },
  });
  if (!video) throw new HttpError(404, '任务不存在或无权访问');
  return video;
}
