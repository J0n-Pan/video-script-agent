import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../src/lib/config';
import {
  MIN_MEDIA_SCORE,
  openMuseBrowser,
  inspectMusePage,
  sessionInfo,
  isSiteAssetUrl,
  scoreCandidate,
} from '../src/lib/sources/muse-browser';
import { TencentMuseSourceAdapter } from '../src/lib/sources/tencent-muse';

/**
 * 腾讯妙思抓取诊断（真实业务场景排查用）。
 *
 * 用法：
 *   npm run muse:probe -- "https://admuse.qq.com/#/..."
 *   npm run muse:probe -- "https://admuse.qq.com/#/..." --headed    # 有头观察，便于看登录墙/弹窗
 *   npm run muse:probe -- "https://admuse.qq.com/#/..." --all       # 列出全部候选媒体地址
 *   npm run muse:probe -- "https://admuse.qq.com/#/..." --download  # 再跑一遍正式适配器，验证真实下载
 *
 * 它调用的是与解析进程完全同源的 inspectMusePage，因此结论可直接外推到正式抓取。
 */

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) ?? args.find((a) => a.startsWith('--url='))?.slice(6);
const HEADED = args.includes('--headed');
const SHOW_ALL = args.includes('--all');
const DO_DOWNLOAD = args.includes('--download');
const NAV_MODE = args.includes('--nav');
/** --click=原料库 可重复：打开页面后先依次点击这些文案，便于切页签排查 */
const CLICKS = args.filter((a) => a.startsWith('--click=')).map((a) => a.slice('--click='.length));

/** 妙思左侧导航的文案白名单：只点这些，避免误触发业务操作 */
const NAV_WORDS = ['首页', '灵感', '资产', '画布', '图片', '视频', '数字人', '全部', '我的', '作品', '素材库', '内容资产'];

function bar(title: string) {
  console.log(`\n── ${title} ──`);
}

function line(tag: string, label: string, extra = '') {
  console.log(`  ${tag.padEnd(6)} ${label}${extra ? '  ' + extra : ''}`);
}

/**
 * 依次点开左侧导航，记录跳转后的地址。
 * 妙思是 hash 路由的单页应用，只有点一遍才知道「资产 / 成品库」等页面的真实地址，
 * 摸清后才能拿到单条素材的链接。
 */
async function discoverRoutes(page: any, startUrl: string): Promise<Array<[string, string]>> {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.muse.navTimeoutMs });
  await new Promise((r) => setTimeout(r, 2500));
  const navTexts: string[] = await page
    .evaluate((words: string[]) => {
      const out: string[] = [];
      document.querySelectorAll('a, button, div[role="button"], li, span, div').forEach((el) => {
        const t = (el.textContent ?? '').trim();
        if (t && t.length <= 6 && words.includes(t) && (el as HTMLElement).offsetParent !== null) out.push(t);
      });
      return Array.from(new Set(out));
    }, NAV_WORDS)
    .catch(() => []);

  const rows: Array<[string, string]> = [];
  for (const t of navTexts) {
    const clicked: boolean = await page
      .evaluate((txt: string) => {
        const nodes = Array.from(document.querySelectorAll('a, button, div[role="button"], li, span')) as HTMLElement[];
        const target = nodes.find((el) => (el.textContent ?? '').trim() === txt && el.offsetParent !== null);
        if (!target) return false;
        target.click();
        return true;
      }, t)
      .catch(() => false);
    if (!clicked) {
      rows.push([t, '（未点中）']);
      continue;
    }
    await new Promise((r) => setTimeout(r, 2200));
    rows.push([t, page.url()]);
  }
  return rows;
}

if (!url && !NAV_MODE) {
  console.log('\n用法：npm run muse:probe -- "<妙思单条素材链接>" [--headed] [--all] [--download]');
  console.log('      npm run muse:probe -- --nav            # 只做导航路由发现，摸清资产/成品库地址\n');
  process.exit(2);
}
const targetUrl = url ?? cfg.muse.loginUrl;

(async () => {
  const started = Date.now();
  console.log('\n══ 腾讯妙思素材抓取诊断 ══');

  bar('配置');
  const info = sessionInfo();
  line('链接', targetUrl);
  line('会话文件', info.path);
  line(
    '会话状态',
    info.exists ? `存在，${info.cookies} 条 cookie，更新于 ${info.mtime?.toISOString().slice(0, 19)}` : '不存在（需先执行 npm run muse:login）',
  );
  line('抓取开关', `MUSE_FETCH_ENABLED=${cfg.muse.fetchEnabled}`);
  line('运行模式', HEADED ? '有头（可观察页面）' : '无头（与解析进程一致）');
  line('域名白名单', cfg.muse.allowedHosts.join('、'));
  if (CLICKS.length) line('预点击', CLICKS.join(' → '));

  const outDir = path.resolve('data/tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const shotPath = path.join(outDir, `muse-probe-${stamp}.png`);
  const jsonPath = path.join(outDir, `muse-probe-${stamp}.json`);

  let browser: Awaited<ReturnType<typeof openMuseBrowser>> | null = null;
  try {
    browser = await openMuseBrowser({
      headless: !HEADED,
      storageState: info.exists ? cfg.muse.storageState : null,
    });
    const page = await browser.context.newPage();

    // 路由发现模式：只摸地址，不做媒体检查
    if (NAV_MODE) {
      const rows = await discoverRoutes(page, targetUrl);
      await page.screenshot({ path: shotPath }).catch(() => null);
      bar('导航路由发现');
      for (const [t, u] of rows) console.log(`  ${t.padEnd(8)} → ${u}`);
      bar('留档');
      line('截图', shotPath);
      console.log('');
      return;
    }

    const insp = await inspectMusePage({
      page,
      url: targetUrl,
      navTimeoutMs: cfg.muse.navTimeoutMs,
      waitMs: cfg.muse.waitMs,
      clicks: CLICKS.length ? CLICKS : undefined,
    });

    await page.screenshot({ path: shotPath, fullPage: false }).catch(() => null);

    bar('结论');
    line('打开页面', insp.finalUrl === targetUrl ? '正常' : `发生跳转 → ${insp.finalUrl}`);
    line('素材页', insp.materialReached ? '已进入目标素材详情页' : '未进入目标素材详情页（会被正式抓取判为失败）');
    line('页面标题', insp.pageTitle || '（空）');
    line('素材标题', insp.title ?? '（未取到，正式解析将沿用人工填写的标题）');
    line('登录态', insp.loginWall ? '出现登录引导 → 需重新 npm run muse:login' : '未出现登录引导');
    line('媒体地址', insp.best ? `命中（${insp.best.kind}）` : '未命中 → 正式抓取会走页面下载入口兜底');
    if (insp.best) line('最佳候选', insp.best.url.slice(0, 160), `来源：${insp.best.from}`);

    bar('候选媒体地址（按证据分排序，分 ≤ 0 不会被选中）');
    const list = [...insp.candidates].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    if (!list.length) console.log('  （无）');
    for (const [i, c] of (SHOW_ALL ? list : list.slice(0, 8)).entries()) {
      const size = c.contentLength ? ` / ${(c.contentLength / 1024 / 1024).toFixed(2)}MB` : '';
      const deco = isSiteAssetUrl(c.url) ? '  ← 站点装饰素材，永不采纳' : '';
      console.log(
        `  ${String(i + 1).padStart(2)} 分${String(scoreCandidate(c)).padStart(4)}  [${c.kind}] ${c.from}${c.contentType ? ' / ' + c.contentType : ''}${size}${deco}`,
      );
      console.log(`     ${c.url.slice(0, 200)}`);
    }
    if (!SHOW_ALL && list.length > 8) console.log(`  …另有 ${list.length - 8} 条，用 --all 查看`);
    line(
      '评分下限',
      insp.best
        ? `通过（最佳候选 ${scoreCandidate(insp.best)} 分，下限 ${MIN_MEDIA_SCORE}）`
        : `未通过（下限 ${MIN_MEDIA_SCORE}）→ 不硬下站内装饰/宣传素材等无关文件`,
    );
    if (insp.rejectedBest) {
      line(
        '被排除',
        `分数最高的候选是站点装饰素材（${scoreCandidate(insp.rejectedBest)} 分）`,
        insp.rejectedBest.url.split('/').pop() ?? '',
      );
    }

    bar('页面 video 元素');
    if (!insp.videoSrcs.length) console.log('  （未找到 video 元素）');
    for (const s of insp.videoSrcs) console.log(`  ${s.slice(0, 200)}`);

    bar('页面可见操作入口');
    console.log(insp.visibleActions.length ? '  ' + insp.visibleActions.join(' / ') : '  （无）');

    bar('页面文字片段（前 500 字）');
    console.log('  ' + insp.bodySnippet.replace(/\n+/g, ' ⏎ ').slice(0, 500));

    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          url: targetUrl,
          finalUrl: insp.finalUrl,
          pageTitle: insp.pageTitle,
          materialTitle: insp.title,
          loginWall: insp.loginWall,
          materialReached: insp.materialReached,
          minMediaScore: MIN_MEDIA_SCORE,
          candidates: insp.candidates.map((c) => ({
            ...c,
            score: scoreCandidate(c),
            siteAsset: isSiteAssetUrl(c.url),
          })),
          best: insp.best,
          rejectedBest: insp.rejectedBest,
          videoSrcs: insp.videoSrcs,
          visibleActions: insp.visibleActions,
        },
        null,
        2,
      ),
      'utf8',
    );
    bar('留档');
    line('截图', shotPath);
    line('详情', jsonPath);

    if (DO_DOWNLOAD) {
      bar('正式适配器下载验证');
      const probeVideoId = `probe-${Date.now()}`;
      const r = await new TencentMuseSourceAdapter().fetch({ videoId: probeVideoId, url: targetUrl });
      if (r.ok) {
        const size = fs.statSync(r.localPath).size;
        line('结果', '成功');
        line('文件', r.localPath);
        line('大小', `${(size / 1024 / 1024).toFixed(2)} MB`);
        line('原视频标题', r.sourceTitle ?? '（未取到，将落为「未提供」）');
        console.log(`\n  素材已缓存到 data/media/${probeVideoId}/，可删：${probeVideoId}\n`);
      } else {
        line('结果', `失败 [${r.code}]`);
        line('原因', r.message);
        line('建议', r.recovery);
      }
    }

    bar('耗时');
    line('总计', `${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log('');
  } catch (e) {
    console.log('');
    line('失败', (e as Error).message);
    if (/Executable doesn't exist|browserType.launch/i.test((e as Error).message)) {
      line('建议', '浏览器运行时未安装，执行：npx playwright install chromium');
    }
    if (/Timeout|timeout/i.test((e as Error).message)) {
      line('建议', '可加大 MUSE_NAV_TIMEOUT_MS / MUSE_WAIT_MS 后重试，或用 --headed 观察页面卡在哪一步');
    }
    process.exit(1);
  } finally {
    await browser?.close();
  }
})();
