/**
 * 改写链路真实跑一次（走 service 路径，不是桩），并打印成可读的对照结果。
 *
 * 用途：
 *   1) 端到端验证 dashscope 改写适配器 + 结构校验 + 落库（`verify-rewrite` 用的是桩，不烧钱但也测不到真实模型）；
 *   2) 在库里留一条可在页面浏览的改写任务（`/tasks/<视频id>/rewrite`）。
 *
 * 用法：
 *   npm run rewrite:demo -- <ownerId> <sourceVideoId>     # 真实生成一次（产生模型费用，约 ¥0.012/轮）
 *   npm run rewrite:demo -- --job=<jobId>                 # 只回看已生成的任务，**不调用模型、不产生费用**
 *
 * 为什么提供 --job 回看：核对真实模型的输出常常要看第二遍，
 * 不该为了再看一眼就再花一次钱。
 */
import '../src/lib/load-env';
import { prisma } from '../src/lib/db';
import { cfg } from '../src/lib/config';
import { generateRewrite, getRewriteJob, viewVariantsOfJob } from '../src/lib/rewrite/service';
import { getActiveProfile } from '../src/lib/rewrite/profile';

const args = process.argv.slice(2);
const jobArg = args.find((a) => a.startsWith('--job='))?.slice('--job='.length) ?? '';
const positional = args.filter((a) => !a.startsWith('--'));
const OWNER = positional[0] ?? '';
const VIDEO_ID = positional[1] ?? '';

function printVariants(views: Awaited<ReturnType<typeof viewVariantsOfJob>>) {
  for (const v of views) {
    console.log(
      `\n----- 第 ${v.variantNo} 篇 | ${v.charCount} 字 | 约 ${Math.round(v.estimatedDurationMs / 1000)} 秒 | ` +
        `${v.blockedReason || '通过'} | 修订数 ${v.revisionCount ?? 1} -----`
    );
    console.log('差异摘要：', v.diffSummary || '（无）');
    if (v.problemFlags?.length) console.log('问题标记：', v.problemFlags.join(', '));
    for (const s of v.segments) {
      console.log(`  [${s.orderIndex}] ${s.tag}${s.factRefs?.length ? ' «' + s.factRefs.join(',') + '»' : ''}`);
      console.log('      ' + s.copyText);
    }
  }
}

async function main() {
  // ---- 回看模式：零费用 ----
  if (jobArg) {
    const job = await prisma.rewriteJob.findUnique({ where: { id: jobArg } });
    if (!job) {
      console.error('找不到任务：', jobArg);
      process.exitCode = 1;
      return;
    }
    console.log('=== 任务回看 ===');
    console.log('jobId =', job.id, '| 状态', job.status, '| 模型', job.modelId);
    console.log('提示词版本', job.promptVersion, '| 规则版本', job.ruleVersion, '| 平台', job.platform, '| 来源视频', job.sourceVideoId);
    printVariants(await viewVariantsOfJob(job.id));
    console.log('\n页面地址：/tasks/' + job.sourceVideoId + '/rewrite');
    return;
  }

  if (!OWNER || !VIDEO_ID) {
    console.error('用法：npm run rewrite:demo -- <ownerId> <sourceVideoId>  或  --job=<jobId>');
    process.exitCode = 1;
    return;
  }

  // ---- 生成模式：会调用真实模型 ----
  console.log('模型 =', cfg.rewrite.model, '| 版本数 =', cfg.rewrite.variantCount, '| 平台 =', cfg.rewrite.platform);
  const profile = await getActiveProfile(OWNER);
  console.log('资料包 =', profile ? `v${profile.versionNo} ${profile.title}` : '（无）');

  const t0 = Date.now();
  const r = await generateRewrite({
    ownerId: OWNER,
    sourceVideoId: VIDEO_ID,
    sourceRevisionId: null,
    platform: cfg.rewrite.platform,
    variantCount: cfg.rewrite.variantCount,
    ipProfileRevisionId: null,
    clientKey: 'demo-' + Date.now(),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== 生成完成 ${dt}s | jobId=${r.jobId} | 模型=${r.model} ===`);
  console.log('估算费用 ¥' + (r.estimatedCost ?? '?'), '| tokens 入', r.inputTokens, '出', r.outputTokens, '思考', r.thinkingTokens ?? '-');
  if (r.transcriptNotice) console.log('参考稿提示：', r.transcriptNotice);
  for (const p of r.problems) console.log(`  [${p.severity}] ${p.code}：${p.message}`);

  // dryRun 的结果没有 jobId；本脚本只走非 dryRun 路径，这里兜一下类型
  const jobId = r.jobId;
  if (!jobId) throw new Error('生成未返回任务 ID（非预期：本脚本不使用 dryRun）');

  const job = await getRewriteJob(OWNER, jobId);
  console.log('\n=== 落库状态 ===', job?.status, '| 阶段', job?.stage ?? '-');
  const views = await viewVariantsOfJob(jobId);
  console.log('落库版本数 =', views.length, '| 各版本段数 =', views.map((v) => v.segments.length).join(','));
  printVariants(views);
  console.log('\n回看这条任务（不再花钱）：npm run rewrite:demo -- --job=' + jobId);
  console.log('页面地址：/tasks/' + VIDEO_ID + '/rewrite');
}

main()
  .catch((e) => {
    console.error('失败：', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
