/**
 * IP 资料包导入 / 换版（2026-09-20 需求迭代 §6）。
 *
 * 行为：
 * - 解析资料文件（.docx 走内置零依赖解析；.txt/.md 直读）→ 调模型整理成结构化资料包 → 落库为新版本；
 * - **版本只追加不覆盖**：新版本生效，旧版本标记 SUPERSEDED 但内容保留，历史生成任务的输入可复现；
 * - 同一份文件（sha256 相同）默认拒绝重复导入，加 --force 才强制新建一版。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/rewrite-profile.ts <资料文件> [选项]
 *
 * 选项：
 *   --dry                只解析文件，不调模型、不落库（先看抽得出多少内容，无费用）
 *   --skip-structure     不调模型，沿用当前版本的结构化结果，只更新原文
 *   --force              文件内容与当前版本相同也强制新建一版
 *   --owner=<用户名>      资料归属用户，默认 maintainer
 *   --title=<标题>        资料包标题，默认取文件名
 *   --note=<备注>         版本备注（例如「用户 09-20 提供的新版话术」）
 *   --model=<模型名>      整理用模型，默认 REWRITE_MODEL
 *   --show=<n>            打印前 n 条事实抽样（默认 8，便于人工核对是否编造）
 */
import { PrismaClient } from '@prisma/client';
import { importProfile, getActiveProfile, IP_SECTIONS, readProfileSource } from '../src/lib/rewrite/profile';
import { cfg } from '../src/lib/config';

const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith('--'));
if (!fileArg) {
  console.error('用法：node node_modules/tsx/dist/cli.mjs scripts/rewrite-profile.ts <资料文件> [--dry|--force|--skip-structure|--owner=..|--title=..|--note=..|--model=..|--show=n]');
  process.exit(1);
}
// 显式收窄：模块级 const 的收窄不会跨函数边界保留
const file: string = fileArg;
const flag = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const SKIP_STRUCTURE = args.includes('--skip-structure');
const OWNER = flag('owner') ?? 'maintainer';
const SHOW = Number(flag('show') ?? 8);

const prisma = new PrismaClient();

async function main() {
  const owner = await prisma.user.findUnique({ where: { username: OWNER } });
  if (!owner) {
    console.error(`未找到用户 ${OWNER}：先跑一次 npm run seed，或用 --owner=<用户名> 指定`);
    process.exit(1);
  }

  console.log(`资料文件：${file}`);
  console.log(`归属用户：${owner.username}（${owner.id}）`);
  console.log(`模型：${cfg.rewrite.model}${DRY ? '（--dry：不调用）' : ''}`);

  // 先本地解析一遍，把「抽出来多少」和「调模型」解耦，避免白花钱
  const src = readProfileSource(file);
  console.log(
    `本地解析：段落 ${src.paragraphCount} / 表格 ${src.tableCount} / 字符 ${src.text.length} / sha256 ${src.sha256.slice(0, 12)}…`,
  );
  if (SHOW > 0) {
    console.log('原文抽样：');
    for (const line of src.text.split('\n').filter((l) => l.trim()).slice(0, 3)) {
      console.log(`  ${line.slice(0, 90)}${line.length > 90 ? '…' : ''}`);
    }
  }

  const before = await getActiveProfile(owner.id);
  console.log(before ? `当前生效版本：v${before.versionNo}（${before.sourceFileName ?? '未知来源'}）` : '当前没有资料包版本');

  const r = await importProfile({
    ownerId: owner.id,
    filePath: file,
    title: flag('title'),
    note: flag('note'),
    dryRun: DRY,
    force: FORCE,
    skipStructure: SKIP_STRUCTURE,
    model: flag('model'),
    // 长文档会分块多次调用模型，逐步打印，避免看起来像卡住
    onProgress: (msg) => console.log('  …' + msg),
  });

  console.log('');
  console.log(r.ok ? '✓ ' + r.message : '✗ ' + r.message);
  if (r.chunkCount) console.log(`结构化分块数：${r.chunkCount}${r.chunkCount > 1 ? '（分块抽取 + 合并去重）' : ''}`);
  if (r.sectionCounts) {
    console.log('板块条目数：');
    for (const s of IP_SECTIONS) {
      console.log(`  ${s.label.padEnd(12, '　')} ${r.sectionCounts[s.label] ?? 0}`);
    }
  }
  if (r.usage) {
    const u = r.usage;
    if (u.usageMissing) {
      console.log('用量：模型未返回用量 → 费用待核对');
    } else {
      const p = cfg.pricing.rewriteModels[cfg.rewrite.model];
      const cost = p && u.inputTokens != null && u.outputTokens != null
        ? (u.inputTokens / 1e6) * p.inputPerMillion + (u.outputTokens / 1e6) * p.outputPerMillion
        : null;
      console.log(
        `用量：输入 ${u.inputTokens ?? '?'} / 输出 ${u.outputTokens ?? '?'} tokens` +
          (cost == null ? '' : ` → 约 ¥${cost.toFixed(4)}（按 ${cfg.rewrite.model} 单价估算）`),
      );
    }
  }
  // 兜底过滤有剔除时明确说出来：静默丢弃会让资料包看起来「少了点什么」却查不出原因
  if (r.droppedEcho?.length) {
    console.log(`⚠ 兜底过滤剔除了 ${r.droppedEcho.length} 条「疑似抄入工作要求」的条目：`);
    for (const t of r.droppedEcho) console.log(`    ${t}`);
    console.log('  （提示词已加自检；若持续出现，说明结构化提示词还需要收紧）');
  }
  if (r.revisionId) console.log(`版本 ID：${r.revisionId}`);
  if (!r.ok) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('导入失败：', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
