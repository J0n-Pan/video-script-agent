import { NextResponse } from 'next/server';
import { HttpError } from './auth';

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

/** 统一错误出口：不向前端暴露堆栈，只给出可操作说明 */
export function handleError(e: unknown) {
  if (e instanceof HttpError) return fail(e.status, e.message);
  const msg = (e as Error)?.message ?? '未知错误';
  console.error('[api]', e);
  return fail(500, `服务端处理失败：${msg}`);
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}
