/**
 * 回填存量记录的「原视频标题」（2026-09-16 新增字段，只补数据不改业务代码）。
 *
 * - 本地导入：原视频标题 = 原文件名（fileName），可直接回填；
 * - 链接导入：原视频标题 = 网页标题，需要重新打开素材页读取，默认跳过，
 *   加 --fetch 才执行（会打开无头浏览器，耗时取决于条目数；不调用任何模型、不产生模型费用）。
 *
 * 已存在 sourceTitle 的记录默认不覆盖；加 --force 才重写。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/backfill-source-title.ts            # 只回填本地文件名
 *   node node_modules/tsx/dist/cli.mjs scripts/backfill-source-title.ts --fetch    # 连链接标题一起回填
 */
import { PrismaClient } from '@prisma/client';
import { openMuseBrowser, waitForAppReady, readMaterialTitle } from '../src/lib/sources/muse-browser';

const args = process.argv.slice(2);
const DO_FETCH = args.includes('--fetch');
const FORCE = args.includes('--force');

const prisma = new PrismaClient();

async function main() {
  let localFixed = 0;
  let museFixed = 0;
  let skipped = 0;
  let failed = 0;

  // ---- 1. 本地导入：原文件名 ----
  const locals = await prisma.video.findMany({
    where: { sourceType: 'LOCAL', deletedAt: null, fileName: { not: null } },
  });
  for (const v of locals) {
    if (v.sourceTitle && !FORCE) {
      skipped += 1;
      continue;
    }
    await prisma.video.update({ where: { id: v.id }, data: { sourceTitle: v.fileName } });
    localFixed += 1;
    console.log(`  本地  ${v.id}  →  ${v.fileName}`);
  }

  // ---- 2. 链接导入：网页标题（需 --fetch）----
  const muses = await prisma.video.findMany({
    where: { sourceType: 'TENCENT_MUSE', deletedAt: null, sourceUrl: { not: null } },
  });
  const needFetch = muses.filter((v) => FORCE || !v.sourceTitle);

  if (needFetch.length === 0) {
    console.log('  链接导入：没有需要回填的记录');
  } else if (!DO_FETCH) {
    console.log(`  链接导入：${needFetch.length} 条待回填，未加 --fetch，跳过（这些记录的原视频标题会显示「未提供」）`);
  } else {
    const byUrl = new Map<string, typeof needFetch>();
    for (const v of needFetch) {
      const u = v.sourceUrl!;
      byUrl.set(u, [...(byUrl.get(u) ?? []), v]);
    }
    console.log(`  链接导入：${needFetch.length} 条记录、${byUrl.size} 个不同链接，开始读取网页标题…`);

    const b = await openMuseBrowser({ headless: true });
    try {
      for (const [url, list] of byUrl) {
        try {
          const page = await b.context.newPage();
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await waitForAppReady(page);
          await page.waitForTimeout(4000);
          const title = await readMaterialTitle(page);
          await page.close();
          if (!title) {
            failed += 1;
            console.log(`  失败  ${url}  →  页面未取到标题（可能素材已下线或需要重新登录）`);
            continue;
          }
          for (const v of list) {
            await prisma.video.update({ where: { id: v.id }, data: { sourceTitle: title } });
            museFixed += 1;
            console.log(`  链接  ${v.id}  →  ${title}`);
          }
        } catch (e) {
          failed += 1;
          console.log(`  失败  ${url}  →  ${(e as Error).message}`);
        }
      }
    } finally {
      await b.close();
    }
  }

  console.log(`\n完成：本地回填 ${localFixed} 条，链接回填 ${museFixed} 条，跳过 ${skipped} 条，失败 ${failed} 条。`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('回填异常：', e);
  await prisma.$disconnect();
  process.exit(1);
});
