import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../src/lib/config';
import { openMuseBrowser, sessionInfo, waitForAppReady } from '../src/lib/sources/muse-browser';

/**
 * 妙思素材详情页「板块内容」探针（只读，不改任何业务代码）。
 *
 * 目的：确认详情页是否提供 人群分析 / 视频分镜分析 / 高光时序分析 / 创意标签 等板块，
 * 以及这些板块在接口 JSON 里的真实键名与取值形态，为「脚本整理新逻辑」定契约。
 *
 * 用法：
 *   npm run muse:blocks -- "https://admuse.qq.com/#/idea/detail/video/<id>"
 *   npm run muse:blocks -- "<链接>" --headed
 *   npm run muse:blocks -- "<链接>" --grep=人群,分镜,标签     # 自定义关键词
 */

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const HEADED = args.includes('--headed');
const GREP = (
  args.find((a) => a.startsWith('--grep='))?.slice(7) ??
  '人群,性别,年龄,分镜,高光,标签,创意,audience,gender,age,label,script,summary,shot,highlight,time_series,storyboard'
).split(',');

const outDir = path.resolve('data/tmp/muse-blocks');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

type JsonRecord = {
  url: string;
  status: number;
  method: string;
  postData?: string;
  body: unknown;
};

/** 递归找「键名或字符串值」命中关键词的路径，返回 [路径, 值] */
function hunt(node: unknown, words: string[], p = '$', out: Array<[string, unknown]> = [], depth = 0): Array<[string, unknown]> {
  if (depth > 12 || out.length > 400) return out;
  if (node == null) return out;
  if (Array.isArray(node)) {
    node.slice(0, 60).forEach((v, i) => hunt(v, words, `${p}[${i}]`, out, depth + 1));
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (words.some((w) => k.toLowerCase().includes(w.toLowerCase()))) out.push([`${p}.${k}`, v]);
      hunt(v, words, `${p}.${k}`, out, depth + 1);
    }
    return out;
  }
  if (typeof node === 'string' && node.length <= 120) {
    if (words.some((w) => node.includes(w))) out.push([p, node]);
  }
  return out;
}

(async () => {
  if (!url) {
    console.log('\n用法：npm run muse:blocks -- "<妙思单条素材链接>" [--headed] [--grep=人群,分镜]\n');
    process.exit(2);
  }
  console.log('\n══ 妙思详情页板块探针 ══');
  const info = sessionInfo();
  console.log(`  链接   ${url}`);
  console.log(`  会话   ${info.exists ? `${info.cookies} 条 cookie` : '不存在，需 npm run muse:login'}`);
  console.log(`  关键词 ${GREP.join('、')}\n`);

  const records: JsonRecord[] = [];
  let browser: Awaited<ReturnType<typeof openMuseBrowser>> | null = null;
  try {
    browser = await openMuseBrowser({ headless: !HEADED, storageState: info.exists ? cfg.muse.storageState : null });
    const page = await browser.context.newPage();

    page.on('response', async (res: any) => {
      try {
        const ct: string = res.headers?.()?.['content-type'] ?? '';
        if (!/json/i.test(ct)) return;
        const body = await res.json().catch(() => null);
        if (body != null) {
          const req = res.request?.();
          records.push({
            url: res.url(),
            status: res.status(),
            method: req?.method?.() ?? 'GET',
            postData: req?.postData?.() ?? undefined,
            body,
          });
        }
      } catch {
        /* 忽略无法解析的响应 */
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.muse.navTimeoutMs });
    await waitForAppReady(page);
    // 详情页板块多为懒加载：滚动一遍触发请求
    for (let i = 0; i < 6; i += 1) {
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9))).catch(() => null);
      await new Promise((r) => setTimeout(r, 1200));
    }
    await new Promise((r) => setTimeout(r, 3000));

    const fullText: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const shot = path.join(outDir, `blocks-${stamp}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => null);

    const jsonPath = path.join(outDir, `blocks-${stamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({ url, pageUrl: page.url(), jsonCount: records.length, records }, null, 2), 'utf8');
    const txtPath = path.join(outDir, `blocks-${stamp}.txt`);
    fs.writeFileSync(txtPath, fullText, 'utf8');

    console.log('── 页面可见板块标题（文字全量已落盘）──');
    const lines = fullText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    console.log(`  共 ${lines.length} 行；含关键词的行：`);
    for (const l of lines) {
      if (GREP.some((w) => l.includes(w))) console.log(`    · ${l.slice(0, 120)}`);
    }
    console.log('\n── 文字前 40 行 ──');
    lines.slice(0, 40).forEach((l, i) => console.log(`  ${String(i + 1).padStart(2)}  ${l.slice(0, 110)}`));

    console.log(`\n── 妙思域接口调用（含 POST 参数）──`);
    for (const r of records.filter((x) => /admuse\.qq\.com/.test(x.url))) {
      const endpoint = r.url.split('?')[0].replace('https://admuse.qq.com', '');
      console.log(`  ${r.method.padEnd(4)} ${endpoint}`);
      if (r.postData) console.log(`        body: ${r.postData.slice(0, 400)}`);
    }

    console.log(`\n── 接口 JSON 命中（共捕获 ${records.length} 个 JSON 响应）──`);
    let hit = 0;
    for (const r of records) {
      const found = hunt(r.body, GREP);
      // 键名命中一律保留（即使值是对象/数组）；值命中只保留叶子
      const meaningful = found.filter(([p, v]) => {
        const lastKey = p.split('.').pop() ?? '';
        const keyHit = GREP.some((w) => lastKey.toLowerCase().includes(w.toLowerCase()));
        return keyHit || v == null || typeof v !== 'object';
      });
      if (!meaningful.length) continue;
      hit += 1;
      console.log(`\n  ▸ ${r.url.slice(0, 150)}`);
      for (const [p, v] of meaningful.slice(0, 25)) {
        console.log(`      ${p} = ${JSON.stringify(v)?.slice(0, 160)}`);
      }
    }
    if (!hit) console.log('  （无命中：板块可能来自页面静态渲染或未登录可见范围之外）');

    console.log('\n── 留档 ──');
    console.log(`  截图 ${shot}`);
    console.log(`  文字 ${txtPath}`);
    console.log(`  JSON ${jsonPath}\n`);
  } catch (e) {
    console.log(`\n  失败：${(e as Error).message}\n`);
    process.exit(1);
  } finally {
    await browser?.close();
  }
})();
