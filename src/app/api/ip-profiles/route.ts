import fs from 'node:fs';
import path from 'node:path';
import { requireUser, HttpError } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import { prisma } from '@/lib/db';
import { cfg, ensureDirs } from '@/lib/config';
import { importProfile, isProfileKind, IP_SECTIONS, PROFILE_KIND, type ProfileKind } from '@/lib/rewrite/profile';
import { countBannedEntries, readBannedPack } from '@/lib/rewrite/banned';

export const dynamic = 'force-dynamic';

const ALLOWED_EXT = ['.docx', '.dotx', '.txt', '.md', '.markdown'];

/**
 * 从 query/form 里取资料包类型。非法值直接 400 ——
 * 静默回落到 IP 会让「以为在上传违禁词、实际改了事实资料包」，比报错危险得多。
 */
function readKind(v: unknown): ProfileKind {
  if (v == null || v === '') return PROFILE_KIND.IP;
  if (isProfileKind(v)) return v;
  throw new HttpError(400, `资料包类型非法：${String(v)}；只能是 IP 或 BANNED`);
}

/**
 * 资料包版本列表（§6）。
 * 换文档 = 新版本，版本只追加不覆盖；这里只列元信息，不回传全文（原文可能很大）。
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const kind = readKind(new URL(req.url).searchParams.get('kind'));
    const rows = await prisma.ipProfileRevision.findMany({
      where: { ownerId: user.id, kind },
      orderBy: { versionNo: 'desc' },
      select: {
        id: true,
        versionNo: true,
        title: true,
        status: true,
        sourceFileName: true,
        note: true,
        createdAt: true,
        profileJson: true,
      },
    });
    return ok({
      kind,
      // IP 资料包有固定板块；违禁词资料包的分类来自文档本身，所以从生效版本里读
      sections: kind === PROFILE_KIND.IP ? IP_SECTIONS.map((s) => ({ key: s.key, label: s.label })) : [],
      categories: kind === PROFILE_KIND.BANNED ? readActiveCategories(rows) : [],
      rows: rows.map((r) => {
        const parsed = safeParse(r.profileJson);
        const sectionCounts: Record<string, number> = {};
        if (kind === PROFILE_KIND.IP) {
          // profileJson 是 JSON 字符串，形状由 kind 决定；这里显式声明成字典再取，
          // 不能靠推断（unknown 索引会退化成 {} 并报 TS7053）
          const sectionsObj = (parsed?.sections ?? {}) as Record<string, unknown>;
          for (const s of IP_SECTIONS) {
            sectionCounts[s.label] = Array.isArray(sectionsObj[s.key]) ? (sectionsObj[s.key] as unknown[]).length : 0;
          }
        } else {
          for (const e of Array.isArray(parsed?.entries) ? parsed.entries : []) {
            const c = String((e as { category?: string })?.category ?? '未分类');
            sectionCounts[c] = (sectionCounts[c] ?? 0) + 1;
          }
        }
        return {
          id: r.id,
          versionNo: r.versionNo,
          title: r.title,
          status: r.status,
          sourceFileName: r.sourceFileName,
          note: r.note,
          createdAt: r.createdAt,
          // 两个字段同义：IP 资料包叫「事实数」、违禁词资料包叫「词条数」，前端按 kind 取用
          factCount: Array.isArray(parsed?.facts) ? parsed.facts.length : countBannedEntries(r.profileJson),
          entryCount: countBannedEntries(r.profileJson),
          sectionCounts,
        };
      }),
    });
  } catch (e) {
    return handleError(e);
  }
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(json || '{}');
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 生效版本里的分类（供界面显示"分类明细"表头） */
function readActiveCategories(rows: Array<{ status: string; profileJson: string }>): string[] {
  const active = rows.find((r) => r.status === 'ACTIVE');
  return active ? readBannedPack(active.profileJson).categories : [];
}

/**
 * 导入资料包新版本（§6 / A11）。
 *
 * 为什么同步等待：IP 资料包结构化要调一次模型（约 30~60s），但这是**低频的一次性操作**，
 * 放在后台队列里反而要多做一套进度查询。这里直接等，失败原因（格式不支持、内容为空、
 * 与当前版本完全相同）都能直接回给编导。
 *
 * 违禁词资料包（kind=BANNED）走本地解析，不调模型、瞬间完成；
 * 它额外支持 `preview=1` 只解析不落库 —— 解析方向（哪个是分类、哪个是词条）需要肉眼先核对一遍。
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const form = await req.formData();
    const kind = readKind(form.get('kind'));
    const preview = String(form.get('preview') ?? '') === '1';
    const file = form.get('file');
    if (!(file instanceof File)) throw new HttpError(400, '请上传资料文件（.docx / .txt / .md）');

    const ext = path.extname(file.name || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      throw new HttpError(
        400,
        `不支持的资料格式 ${ext || '(无扩展名)'}：请提供 .docx（推荐）、.txt 或 .md；老式 .doc/.wps 请先另存为 .docx`,
      );
    }

    ensureDirs();
    const tmp = path.join(cfg.tmpDir, `ip-profile-upload-${Date.now()}${ext}`);
    fs.writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));

    try {
      const r = await importProfile({
        ownerId: user.id,
        filePath: tmp,
        kind,
        title: String(form.get('title') ?? '').trim() || undefined,
        note: String(form.get('note') ?? '').trim() || undefined,
        // 同名文件重复导入默认拒绝，避免出现一堆内容相同的版本；force=1 显式允许
        force: String(form.get('force') ?? '') === '1',
        dryRun: preview,
      });
      if (!r.ok) throw new HttpError(400, r.message);
      return ok(r);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件清理失败不影响导入结果 */
      }
    }
  } catch (e) {
    return handleError(e);
  }
}
