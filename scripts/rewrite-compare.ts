/**
 * 改写模型横向实测（2026-09-20）：同一份参考稿 + 同一份资料包，跑多个模型做对比。
 *
 * 目的：选模型不该拍脑袋。改写是创作任务，成本和 ASR/视觉不是一个量级 ——
 * 单次生成即使上旗舰模型也只有几毛钱，所以要用**实际输出**决定，而不是只看单价。
 *
 * 只读 + dryRun：不写 RewriteJob / RewriteRevision，只记 ModelUsage 之外的耗时与费用估算，
 * 因此可以放心重复跑。会产生真实模型费用（每次约几分到几毛）。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/rewrite-compare.ts                     # 默认跑 flash 与 3.7-plus
 *   node node_modules/tsx/dist/cli.mjs scripts/rewrite-compare.ts --models=qwen3.8-flash,qwen3.7-plus,qwen3.8-max
 *   node node_modules/tsx/dist/cli.mjs scripts/rewrite-compare.ts --video=<视频ID> --count=2
 *   node node_modules/tsx/dist/cli.mjs scripts/rewrite-compare.ts --owner=editor
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { buildRewriteInput, generateRewrite } from '../src/lib/rewrite/service';
import { cfg } from '../src/lib/config';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};

const MODELS = (flag('models') ?? 'qwen3.8-flash,qwen3.7-plus').split(',').map((s) => s.trim()).filter(Boolean);
const OWNER = flag('owner') ?? 'maintainer';
const COUNT = Number(flag('count') ?? 3);
const VIDEO_ID = flag('video');
const PLATFORM = flag('platform') ?? cfg.rewrite.platform;

const prisma = new PrismaClient();

async function pickVideo(ownerId: string): Promise<string> {
  if (VIDEO_ID) return VIDEO_ID;
  const candidates = await prisma.video.findMany({
    where: { ownerId, deletedAt: null, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    include: { revisions: { where: { isCurrent: true }, include: { segments: true } } },
  });
  const hit = candidates.find((v) => (v.revisions[0]?.segments.length ?? 0) >= 4);
  if (!hit) throw new Error('找不到有 ≥4 个可用分段的已完成视频，请用 --video=<ID> 指定');
  return hit.id;
}

async function main() {
  const owner = await prisma.user.findUnique({ where: { username: OWNER } });
  if (!owner) throw new Error(`未找到用户 ${OWNER}`);

  const videoId = await pickVideo(owner.id);
  const video = await prisma.video.findUnique({ where: { id: videoId } });

  // 先组装输入（不调模型，零费用），失败要在这里就报出来，别等跑完两家才发现没资料包
  const built = await buildRewriteInput({
    ownerId: owner.id,
    sourceVideoId: videoId,
    platform: PLATFORM,
    variantCount: COUNT,
  });

  console.log('=== 实测输入 ===');
  console.log(`参考视频：${video?.title ?? video?.sourceTitle ?? videoId}`);
  console.log(`参考版本：${built.sourceRevisionId}（${built.refs.length} 段）`);
  console.log(`参考段标签：${built.refs.map((r) => r.tag || '未标注').join(' / ')}`);
  console.log(`资料包：v${built.ipProfileVersionNo}`);
  console.log(`平台：${built.input.platformLabel}／生成 ${COUNT} 篇`);
  console.log(`整段与分段一致性：${built.transcriptConsistent ? '一致' : '不一致 → ' + built.transcriptNotice}`);
  if (built.transcriptNotice) console.log('（本次使用分段版本，该提示不会自动修改源数据）');

  const dir = path.join(process.cwd(), 'data', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(dir, `rewrite-compare-${stamp}.md`);
  const md: string[] = [
    `# 改写模型横向实测 ${stamp}`,
    '',
    `- 参考视频：${video?.title ?? video?.sourceTitle ?? videoId}（${videoId}）`,
    `- 参考版本：${built.sourceRevisionId}，共 ${built.refs.length} 段`,
    `- 资料包版本：v${built.ipProfileVersionNo}`,
    `- 平台：${built.input.platformLabel}，生成 ${COUNT} 篇`,
    '',
    '## 参考稿（结构基准）',
    '',
    ...built.refs.map((r) => `**[${r.orderIndex}] ${r.tag}**\n\n${r.copyText}\n`),
    '',
  ];

  const summary: Array<{ model: string; ok: boolean; ms: number; input?: number; output?: number; cost: number | null; chars: number; error?: string }> = [];

  for (const model of MODELS) {
    console.log(`\n=== ${model} ===`);
    const t0 = Date.now();
    try {
      const r = await generateRewrite({
        ownerId: owner.id,
        sourceVideoId: videoId,
        platform: PLATFORM,
        variantCount: COUNT,
        model,
        dryRun: true,
      });
      const ms = Date.now() - t0;
      const totalChars = r.variants.reduce((a, v) => a + v.charCount, 0);
      console.log(`耗时 ${(ms / 1000).toFixed(1)}s ｜ 版本 ${r.variants.length}/${COUNT} ｜ 合计 ${totalChars} 字`);
      console.log(
        `tokens：入 ${r.inputTokens ?? '?'} / 出 ${r.outputTokens ?? '?'}` +
          (r.thinkingTokens ? ` / 思考 ${r.thinkingTokens}` : '') +
          (r.usageMissing ? '（模型未返回用量 → 费用待核对）' : ''),
      );
      console.log(
        r.estimatedCost == null
          ? '费用：无法估算（模型未返回用量或该模型未配置单价）'
          : `费用：约 ¥${r.estimatedCost.toFixed(4)}（按配置单价估算，以账单为准）`,
      );
      for (const v of r.variants) {
        console.log(
          `  第 ${v.variantNo} 版：${v.segments.length} 段 / ${v.charCount} 字 / 预计 ${Math.round(v.estimatedDurationMs / 1000)}s` +
            (v.diffSummary ? ` ｜ ${v.diffSummary}` : '') +
            (v.blockedReason ? ` ｜ 未生成：${v.blockedReason}` : ''),
        );
      }
      const errs = r.problems.filter((p) => p.severity === 'error');
      const warns = r.problems.filter((p) => p.severity !== 'error');
      if (errs.length) for (const p of errs) console.log(`  ✗ [${p.code}] ${p.message}`);
      if (warns.length) for (const p of warns) console.log(`  ! [${p.code}] ${p.message}`);

      md.push(
        `## ${model}`,
        '',
        `- 耗时 ${(ms / 1000).toFixed(1)}s，合计 ${totalChars} 字`,
        `- tokens：入 ${r.inputTokens ?? '?'} / 出 ${r.outputTokens ?? '?'}${r.thinkingTokens ? ` / 思考 ${r.thinkingTokens}` : ''}`,
        `- 费用估算：${r.estimatedCost == null ? '无法估算' : '¥' + r.estimatedCost.toFixed(4)}`,
        '',
      );
      for (const v of r.variants) {
        md.push(`### 第 ${v.variantNo} 版（${v.charCount} 字，预计 ${Math.round(v.estimatedDurationMs / 1000)}s）`);
        if (v.diffSummary) md.push(`差异说明：${v.diffSummary}`);
        md.push('');
        for (const s of v.segments) md.push(`**[${s.orderIndex}] ${s.tag}**\n\n${s.copyText}\n`);
        if (v.blockedReason) md.push(`> 未生成：${v.blockedReason}`);
        md.push('');
      }
      if (r.problems.length) {
        md.push('问题项：', '');
        for (const p of r.problems) md.push(`- [${p.severity}] ${p.code}：${p.message}`);
        md.push('');
      }
      summary.push({
        model,
        ok: true,
        ms,
        input: r.inputTokens,
        output: r.outputTokens,
        cost: r.estimatedCost,
        chars: totalChars,
      });
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`✗ 失败（${(ms / 1000).toFixed(1)}s）：${msg}`);
      md.push(`## ${model}`, '', `失败：${msg}`, '');
      summary.push({ model, ok: false, ms, cost: null, chars: 0, error: msg });
    }
  }

  // 用量与费用是判断「值不值」的关键，单独从库外补一次汇总
  const usageRows = await prisma.modelUsage.findMany({
    where: { capability: 'REWRITE', modelId: { in: MODELS } },
    orderBy: { startedAt: 'desc' },
    take: MODELS.length * 4,
  });
  md.push('## 用量明细（最近若干次改写调用）', '');
  for (const u of usageRows) {
    md.push(
      `- ${u.modelId}｜${u.startedAt?.toISOString() ?? ''}｜in ${u.inputTokens ?? '?'} / out ${u.outputTokens ?? '?'}` +
        (u.thinkingTokens ? ` / thinking ${u.thinkingTokens}` : '') +
        `｜${u.estimatedCost == null ? '费用待核对' : '约 ¥' + u.estimatedCost.toFixed(4)}`,
    );
  }

  md.push('## 汇总', '', '| 模型 | 结果 | 耗时 | 入/出 tokens | 合计字数 | 费用估算 |', '| --- | --- | --- | --- | --- | --- |');
  for (const s of summary) {
    md.push(
      `| ${s.model} | ${s.ok ? '成功' : '失败'} | ${(s.ms / 1000).toFixed(1)}s | ${s.input ?? '?'} / ${s.output ?? '?'} | ${s.chars} | ${
        s.cost == null ? '—' : '¥' + s.cost.toFixed(4)
      } |`,
    );
  }

  fs.writeFileSync(outFile, md.join('\n'), 'utf8');
  console.log('\n=== 汇总 ===');
  for (const s of summary) {
    console.log(
      `${s.model.padEnd(16)} ${s.ok ? '成功' : '失败'}  ${(s.ms / 1000).toFixed(1)}s  ${s.chars} 字  ${
        s.cost == null ? '费用未知' : '¥' + s.cost.toFixed(4)
      }`,
    );
  }
  console.log(`\n完整输出（含参考稿与各家全文）：${outFile}`);
}

main()
  .catch((e) => {
    console.error('实测失败：', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
