/**
 * 形式取值迁移（2026-09-16 需求方口径）。
 *
 * 「形式」由 7 项收敛为 4 项，历史记录按下表回填：
 *   混剪                      → 混剪      （判定逻辑本身没变，仅数值不变）
 *   ai视频                    → AI数字人
 *   真人口播 / 真人访谈        → 真人
 *   有ai片段 / 其他及简短说明  → 其他
 *   待复核                    → 其他      （原「无法可靠估计」语义改由依据字段承载）
 *
 * 幂等：已在新取值里的记录原样跳过，可重复执行。
 * 建议先 `cp data/app.db data/backup/app-<日期>-before-form-merge.db` 再执行。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/migrate-form-values.ts            # 试运行，只打印
 *   node node_modules/tsx/dist/cli.mjs scripts/migrate-form-values.ts --apply     # 实际写入
 */
import { PrismaClient } from '@prisma/client';
import { FORM, FORM_LABEL } from '../src/lib/constants';

const APPLY = process.argv.includes('--apply');

/** 旧取值 → 新取值 */
const MIGRATION: Record<string, string> = {
  [FORM.MIXED_CUT]: FORM.MIXED_CUT,
  ai视频: FORM.AI_AVATAR,
  真人口播: FORM.REAL_PERSON,
  真人访谈: FORM.REAL_PERSON,
  有ai片段: FORM.OTHER,
  其他及简短说明: FORM.OTHER,
  待复核: FORM.OTHER,
};

const VALID = new Set<string>(Object.values(FORM));

async function main() {
  const prisma = new PrismaClient();
  try {
    const before = await prisma.classification.groupBy({ by: ['category'], _count: { _all: true } });
    const total = before.reduce((n, r) => n + r._count._all, 0);
    console.log(`${APPLY ? '[写入]' : '[试运行]'} 待处理分类记录 ${total} 条`);
    console.log('\n迁移前分布：');
    for (const r of before.sort((a, b) => b._count._all - a._count._all)) {
      const to = MIGRATION[String(r.category)];
      const tag = to === undefined ? '（非旧取值，将跳过并提示）' : to === r.category ? '（不变）' : `→ ${to}`;
      console.log(`  ${JSON.stringify(r.category)} ×${r._count._all} ${tag}`);
    }

    let changed = 0;
    let unknown = 0;
    for (const r of before) {
      const from = String(r.category);
      if (VALID.has(from)) continue; // 已是新取值
      const to = MIGRATION[from];
      if (!to) {
        unknown += r._count._all;
        console.log(`\n注意：取值 ${JSON.stringify(from)} 不在迁移表内，已跳过（共 ${r._count._all} 条）。`);
        continue;
      }
      if (APPLY) {
        const res = await prisma.classification.updateMany({
          where: { category: from },
          data: { category: to, categoryLabel: FORM_LABEL[to] },
        });
        changed += res.count;
      } else {
        changed += r._count._all;
      }
      console.log(`  ${from} → ${to}：${r._count._all} 条${APPLY ? ' 已写入' : ''}`);
    }

    console.log(`\n合计${APPLY ? '已迁移' : '待迁移'} ${changed} 条${unknown ? `，跳过 ${unknown} 条未知取值` : ''}。`);

    if (APPLY) {
      const after = await prisma.classification.groupBy({ by: ['category'], _count: { _all: true } });
      console.log('\n迁移后分布：');
      for (const r of after.sort((a, b) => b._count._all - a._count._all)) {
        console.log(`  ${JSON.stringify(r.category)} ×${r._count._all}`);
      }
      const bad = after.filter((r) => !VALID.has(String(r.category)));
      if (bad.length) {
        console.log(`\n仍有 ${bad.length} 个取值不在新口径内，请检查：${bad.map((b) => b.category).join(' / ')}`);
        process.exitCode = 1;
      } else {
        console.log('\n全部记录已落在新口径（混剪 / AI数字人 / 真人 / 其他）内。');
      }
    } else {
      console.log('\n试运行结束，未写入任何数据。加 --apply 才会实际写入。');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('迁移失败：', e);
  process.exit(1);
});
