import fs from 'node:fs';
import { readUserArg, resolveMuseTarget, type MuseTarget } from './_muse-target';
import { prisma } from '../src/lib/db';
import path from 'node:path';
import { cfg } from '../src/lib/config';
import { openMuseBrowser, sessionInfo, waitForAppReady } from '../src/lib/sources/muse-browser';

/**
 * 妙思素材详情「板块内容」重放探针（只读）。
 *
 * 背景：`#/idea/detail/video/<id>` 打开时前端会调用
 *   POST /intelligent/api/v1/inspiration/ranking_detail/get
 *   body: { creative_id, creative_type:"CREATIVE_TYPE_VIDEO", user_id, date_range, uid, account_id }
 * 该接口返回体里含 audience_taste / video_script_summary / label_info / click_time_series
 * 等板块字段。若 creative_id 不在当前榜单过滤范围内，接口会返回空骨架。
 *
 * 因此本脚本先从榜单列表拿一条真实存在的素材，再用它重放详情接口，
 * 以确认这些板块的真实字段名与取值形态。
 *
 * 用法：npm run muse:detail -- [--headed] [--creative=<id>] [--date-range=7]
 */

const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const CREATIVE = args.find((a) => a.startsWith('--creative='))?.slice(11);
const DATE_RANGE = Number(args.find((a) => a.startsWith('--date-range='))?.slice(13) ?? 7);
const SCAN = Number(args.find((a) => a.startsWith('--scan='))?.slice(7) ?? 0);
const FIND = args.find((a) => a.startsWith('--find='))?.slice(7);
const CLICK_FIRST = args.includes('--click-first');

const outDir = path.resolve('data/tmp/muse-blocks');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const KEYS_OF_INTEREST = [
  'audience_taste',
  'video_script_summary',
  'label_info',
  'click_time_series',
  'floating_zone',
  'metrics_list',
];

function brief(v: unknown, n = 1800): string {
  const s = JSON.stringify(v, null, 2) ?? String(v);
  return s.length > n ? s.slice(0, n) + `\n…（共 ${s.length} 字符）` : s;
}

(async () => {
  console.log('\n══ 妙思详情接口重放探针 ══');
  const target = await resolveMuseTarget(readUserArg(args));
  console.log(`  会话归属：${target.displayName}（${target.username}）`);
  const info = sessionInfo(target.storageStatePath);
  console.log(`  会话  ${info.exists ? `${info.cookies} 条 cookie` : '不存在，需 npm run muse:login'}`);
  console.log(`  模式  ${HEADED ? '有头' : '无头'}\n`);

  let browser: Awaited<ReturnType<typeof openMuseBrowser>> | null = null;
  try {
    browser = await openMuseBrowser({ headless: !HEADED, storageState: info.exists ? target.storageStatePath : null });
    const page = await browser.context.newPage();

    const captured: Array<{ url: string; body: any; postData?: string }> = [];
    page.on('response', async (res: any) => {
      try {
        const ct: string = res.headers?.()?.['content-type'] ?? '';
        if (!/json/i.test(ct) || !/admuse\.qq\.com/.test(res.url())) return;
        const body = await res.json().catch(() => null);
        if (body) captured.push({ url: res.url(), body, postData: res.request?.()?.postData?.() ?? undefined });
      } catch {
        /* 忽略 */
      }
    });

    // 1) 打开灵感榜单，拿到一条真实素材
    await page.goto('https://admuse.qq.com/#/idea', { waitUntil: 'domcontentloaded', timeout: cfg.muse.navTimeoutMs });
    await waitForAppReady(page);
    await new Promise((r) => setTimeout(r, 6000));

    const listRec = captured.find((c) => /inspiration\/ranking_list\/get/.test(c.url));
    const list: any[] = listRec?.body?.data?.list ?? [];
    console.log(`── 榜单列表 ──  捕获 ${list.length} 条`);
    const sample = list[0];
    if (!sample) {
      console.log('  未取到榜单数据，无法重放。可改用 --creative=<id> 指定。');
    } else {
      console.log(`  样例素材：${sample.title?.slice(0, 40)}`);
      console.log(`    creative_id=${sample.creative_id}  ranking_id=${sample.ranking_id}  account_id=${sample.account_id}`);
      console.log(`    video_id=${sample.video?.video_id}  duration=${sample.video?.duration}s`);
    }

    // 2) 取一份带 uid/account_id 的请求参数作为底座
    const baseRec = captured.find((c) => c.postData && /"account_id"/.test(c.postData));
    const base = baseRec ? JSON.parse(baseRec.postData!) : {};
    const uid = String(base.uid ?? '');
    const accountId = String(base.account_id ?? '');
    console.log(`\n── 参数底座 ──  uid=${uid}  account_id=${accountId}`);

    // 3) 重放详情接口
    const candidates: Array<{ label: string; body: Record<string, unknown> }> = [];
    if (CREATIVE) {
      candidates.push({
        label: `--creative=${CREATIVE}`,
        body: { creative_id: Number(CREATIVE), creative_type: 'CREATIVE_TYPE_VIDEO', date_range: DATE_RANGE },
      });
    }
    if (sample) {
      candidates.push({
        label: '列表首条（creative_id）',
        body: {
          creative_id: sample.creative_id,
          creative_type: 'CREATIVE_TYPE_VIDEO',
          ranking_id: sample.ranking_id,
          user_id: sample.account_id,
          date_range: DATE_RANGE,
        },
      });
      candidates.push({
        label: '列表首条（带 ranking_id + video_id）',
        body: {
          creative_id: sample.creative_id,
          creative_type: 'CREATIVE_TYPE_VIDEO',
          ranking_id: sample.ranking_id,
          video_id: sample.video?.video_id,
          user_id: sample.account_id,
          date_range: DATE_RANGE,
        },
      });
    }

    const results: any[] = [];
    for (const cand of candidates) {
      const payload = { ...cand.body, uid, account_id: accountId };
      const res = await page
        .evaluate(
          async (p: any) => {
            const r = await fetch('/intelligent/api/v1/inspiration/ranking_detail/get', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(p),
            });
            return { status: r.status, json: await r.json().catch(() => null) };
          },
          payload,
        )
        .catch((e: Error) => ({ status: 0, json: { error: e.message } }));

      console.log(`\n── 重放：${cand.label} ──`);
      console.log(`  请求体 ${JSON.stringify(payload)}`);
      console.log(`  HTTP ${res.status}`);
      const data = res.json?.data;
      if (!data) {
        console.log(`  返回：${brief(res.json, 300)}`);
      } else {
        const filled = Object.entries(data).filter(([, v]) => {
          if (v == null) return false;
          if (Array.isArray(v)) return v.length > 0;
          if (typeof v === 'object') return Object.keys(v as object).length > 0;
          return v !== '' && v !== 0;
        });
        console.log(`  非空字段（${filled.length}/${Object.keys(data).length}）：${filled.map(([k]) => k).join(', ')}`);
        console.log(`  标题：${data.title || '(空)'}`);
        for (const k of KEYS_OF_INTEREST) {
          console.log(`\n  ▸ ${k} =`);
          console.log(
            brief(data[k], 2200)
              .split('\n')
              .map((l) => '      ' + l)
              .join('\n'),
          );
        }
      }
      results.push({ label: cand.label, payload, response: res.json });
    }

    // 3.7) 反查模式：给定 creative_id，扫各榜单条件看它能否被找到（决定板块能否取到）
    if (FIND) {
      console.log(`\n── 反查 creative_id=${FIND} 是否在榜 ──`);
      const listRec2 = captured.find((c) => /ranking_list\/get/.test(c.url));
      const baseList: any = listRec2?.postData ? JSON.parse(listRec2.postData) : {};
      let found: any = null;
      for (const dr of [1, 3, 7, 30]) {
        for (const tmpl of [[720, 721], []]) {
          const body = { ...baseList, date_range: dr, page_size: 100, page_index: 1, creative_template_id_list: tmpl };
          const res = await page
            .evaluate(
              async (p: any) => {
                const r = await fetch('/intelligent/api/v1/inspiration/ranking_list/get', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(p),
                });
                return await r.json().catch(() => null);
              },
              body,
            )
            .catch(() => null);
          const l: any[] = res?.data?.list ?? [];
          const hit = l.find((x) => String(x.creative_id) === String(FIND));
          console.log(`  date_range=${String(dr).padEnd(2)} 模板=${tmpl.length ? '720,721' : '全部'}  → ${l.length} 条  ${hit ? '★ 命中' : ''}`);
          if (hit && !found) {
            found = hit;
            console.log(`      标题 ${hit.title}`);
            console.log(`      ranking_id=${hit.ranking_id} account_id=${hit.account_id} video_id=${hit.video?.video_id}`);
          }
        }
      }
      if (found) {
        const payload = {
          creative_id: Number(FIND),
          creative_type: 'CREATIVE_TYPE_VIDEO',
          ranking_id: found.ranking_id,
          user_id: found.account_id,
          date_range: 7,
          uid,
          account_id: accountId,
        };
        const res = await page
          .evaluate(
            async (p: any) => {
              const r = await fetch('/intelligent/api/v1/inspiration/ranking_detail/get', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(p),
              });
              return await r.json().catch(() => null);
            },
            payload,
          )
          .catch(() => null);
        const d = res?.data ?? {};
        const nonEmpty = (v: any) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v);
        console.log(`\n  详情接口：${nonEmpty(d.label_info) ? '人群/标签有值' : '空'} / ${Array.isArray(d.video_script_summary) ? d.video_script_summary.length : 0} 条分镜 / ${Array.isArray(d.click_time_series) ? d.click_time_series.length : 0} 条时序`);
        console.log(`  label_info: ${brief(d.label_info, 800)}`);
      } else {
        console.log('  → 未在任何榜单条件中命中：该素材无法通过公开榜单接口取到板块内容');
      }
    }

    // 3.5) 覆盖率扫描：板块内容在各素材上的实际有值比例
    if (SCAN > 0 && list.length) {
      console.log(`\n── 板块覆盖率扫描（前 ${Math.min(SCAN, list.length)} 条）──`);
      const stat: Record<string, number> = {};
      const rows: any[] = [];
      for (const it of list.slice(0, SCAN)) {
        const payload = {
          creative_id: it.creative_id,
          creative_type: 'CREATIVE_TYPE_VIDEO',
          ranking_id: it.ranking_id,
          user_id: it.account_id,
          date_range: DATE_RANGE,
          uid,
          account_id: accountId,
        };
        const res = await page
          .evaluate(
            async (p: any) => {
              const r = await fetch('/intelligent/api/v1/inspiration/ranking_detail/get', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(p),
              });
              return await r.json().catch(() => null);
            },
            payload,
          )
          .catch(() => null);
        const d = res?.data ?? {};
        const nonEmpty = (v: any) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v);
        for (const k of KEYS_OF_INTEREST) if (nonEmpty(d[k])) stat[k] = (stat[k] ?? 0) + 1;
        const li = d.label_info;
        // 高光时序结构：只打印一次样例，便于定字段
        if (Array.isArray(d.click_time_series) && d.click_time_series.length && !(globalThis as any).__ctsShown) {
          (globalThis as any).__ctsShown = true;
          console.log(`\n  ▸ click_time_series 样例（${d.click_time_series.length} 条，取前 3）：`);
          console.log(brief(d.click_time_series.slice(0, 3), 1200).split('\n').map((l) => '      ' + l).join('\n'));
          console.log(`  ▸ 同期 video_script_summary（${Array.isArray(d.video_script_summary) ? d.video_script_summary.length : 0} 条）`);
          console.log('');
        }
        if (Array.isArray(d.video_script_summary) && d.video_script_summary.length && !(globalThis as any).__vssShown) {
          (globalThis as any).__vssShown = true;
          console.log(`\n  ▸ video_script_summary 样例（取第 1 条全部键）：`);
          console.log(brief(d.video_script_summary[0], 900).split('\n').map((l) => '      ' + l).join('\n'));
          console.log('');
        }
        rows.push({
          title: String(it.title ?? '').slice(0, 22),
          video_script_summary: Array.isArray(d.video_script_summary) ? d.video_script_summary.length : 0,
          click_time_series: Array.isArray(d.click_time_series) ? d.click_time_series.length : 0,
          audience_taste: nonEmpty(d.audience_taste) ? 'y' : '-',
          label_info: nonEmpty(li) ? Object.keys(li).filter((k) => (Array.isArray(li[k]) ? li[k].length : li[k])).length + '键' : '-',
          core_gender: Array.isArray(li?.core_gender) ? li.core_gender.join('/') : '-',
          core_age: Array.isArray(li?.core_age) ? li.core_age.join('/') : '-',
        });
      }
      for (const r of rows) console.log('  ' + JSON.stringify(r));
      console.log(`  ── 有值素材数 / ${Math.min(SCAN, list.length)}：`);
      for (const k of KEYS_OF_INTEREST) console.log(`     ${k.padEnd(22)} ${stat[k] ?? 0}`);
    }

    // 3.9) 从榜单点进详情，确认详情页 URL 形态与板块是否真实渲染
    if (CLICK_FIRST && sample) {
      console.log(`\n── 从榜单点进详情（验证 URL 形态与页面渲染）──`);
      const before = page.url();
      const clicked = await page
        .evaluate((title: string) => {
          const nodes = Array.from(document.querySelectorAll('div, article, li, a')) as HTMLElement[];
          const t = nodes.find(
            (el) =>
              el.offsetParent !== null &&
              (el.textContent ?? '').includes(title) &&
              (el.textContent ?? '').trim().length < 400,
          );
          if (!t) return false;
          t.click();
          return true;
        }, String(sample.title ?? ''))
        .catch(() => false);
      console.log(`  点击首条素材：${clicked ? '已触发' : '未找到可点元素'}`);
      console.log(`  点击前 URL ${before}`);
      await new Promise((r) => setTimeout(r, 6000));
      console.log(`  点击后 URL ${page.url()}`);
      const txt: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      const wanted = ['人群', '性别', '年龄', '分镜', '高光', '创意标签', '标签', '脚本'];
      const hits = txt.split(/\n+/).map((s) => s.trim()).filter(Boolean).filter((l) => wanted.some((w) => l.includes(w)));
      console.log(`  页面命中板块词的行（${hits.length}）：`);
      hits.slice(0, 25).forEach((l) => console.log(`    · ${l.slice(0, 100)}`));
      const shot2 = path.join(outDir, `detail-click-${stamp}.png`);
      await page.screenshot({ path: shot2, fullPage: false }).catch(() => null);
      const txt2 = path.join(outDir, `detail-click-${stamp}.txt`);
      fs.writeFileSync(txt2, txt, 'utf8');
      console.log(`  截图 ${shot2}`);
      console.log(`  文字 ${txt2}`);
    }

    const outPath = path.join(outDir, `detail-replay-${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ uid, accountId, sample, results }, null, 2), 'utf8');
    console.log(`\n── 留档 ──\n  ${outPath}\n`);
  } catch (e) {
    console.log(`\n  失败：${(e as Error).message}\n`);
    await prisma.$disconnect();

    process.exit(1);
  } finally {
    await browser?.close();
  }
})();
