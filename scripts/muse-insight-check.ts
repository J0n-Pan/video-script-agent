import { cfg } from '../src/lib/config';
import { openMuseBrowser, sessionInfo, waitForAppReady } from '../src/lib/sources/muse-browser';
import { attachMuseHarvest, fetchMuseInsight } from '../src/lib/sources/muse-insight';

/**
 * 妙思原网页板块采集自检：只跑采集这一段（填充工作台「视频分析」栏），
 * 不触发视频下载与模型调用。
 *
 * 用法：npm run muse:insight -- "<妙思单条素材链接>"
 * 说明：板块内容只对灵感广场榜单内素材提供；不在榜单内的素材会返回空值 + 原因。
 */

const url = process.argv.slice(2).find((a) => !a.startsWith('--'));

(async () => {
  if (!url) {
    console.log('\n用法：npm run muse:insight -- "<妙思单条素材链接>"\n');
    process.exit(2);
  }
  const info = sessionInfo();
  console.log('\n══ 妙思基本信息板块采集自检 ══');
  console.log(`  链接  ${url}`);
  console.log(`  会话  ${info.exists ? `${info.cookies} 条 cookie` : '不存在，需 npm run muse:login'}\n`);

  let browser: Awaited<ReturnType<typeof openMuseBrowser>> | null = null;
  try {
    browser = await openMuseBrowser({ headless: cfg.muse.headless, storageState: info.exists ? cfg.muse.storageState : null });
    const page = await browser.context.newPage();
    // 收割器必须在导航前挂上（详情页首屏会自行请求 ranking_detail/get）
    const harvest = attachMuseHarvest(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.muse.navTimeoutMs });
    await waitForAppReady(page);

    const ins = await fetchMuseInsight({ page, url, harvest, onLog: (m) => console.log(`  · ${m}`) });

    console.log('\n── 采集结果 ──');
    console.log(`  取到内容   ${ins.fetched ? '是' : '否（按空值处理）'}`);
    console.log(`  性别特征   ${ins.gender.join('、') || '空'}`);
    console.log(`  年龄特征   ${ins.age.join('、') || '空'}`);
    console.log(
      `  分镜/高光  ${ins.shotTitles.length ? ins.shotTitles.join('｜') : '空'}` +
        (ins.shotTitles.length ? `（来源 ${ins.shotTitleSource}）` : ''),
    );
    console.log(`  创意标签   ${ins.creativeTags.length ? ins.creativeTags.map((t) => `${t.label}=${t.values.join('/')}`).join('；') : '空'}`);
    console.log(`  说明       ${ins.note || '—'}`);
    console.log('');
  } catch (e) {
    console.log(`\n  失败：${(e as Error).message}\n`);
    process.exit(1);
  } finally {
    await browser?.close();
  }
})();
