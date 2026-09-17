import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { cachePathFor, safeExt, baseFileName, fileSize } from '../storage';
import { probeMedia } from '../ffmpeg';
import {
  cookieHeaderFor,
  downloadHlsWithFfmpeg,
  downloadWithContext,
  inspectMusePage,
  loadPlaywright,
  MIN_MEDIA_SCORE,
  openMuseBrowser,
  scoreCandidate,
  tryBrowserDownload,
  type MediaCandidate,
} from './muse-browser';
import { attachMuseHarvest, fetchMuseInsight, type MuseHarvest, type MuseInsight } from './muse-insight';
import type { SourceAdapter, SourceFetchResult } from './types';

/**
 * 逐个试下载的候选上限。候选按证据分降序，真正能用的通常在第 1~2 个；
 * 设上限是为了避免把整页相关推荐（可达十几个）全下一遍，白耗流量与时间。
 */
const MAX_CANDIDATE_TRIES = 4;

/**
 * 腾讯妙思素材链接来源适配器（PRD 3 / 10.4）。
 *
 * 真实抓取路径：复用编导扫码登录一次的专用会话，无头打开素材页，
 * 三路捕获媒体地址（网络响应 / 接口 JSON / 页面 video 元素），
 * 再用「带 cookie 的流式下载 → 浏览器下载事件」两级兜底取回原文件。
 *
 * 捕获逻辑集中在 muse-browser.inspectMusePage，与 `npm run muse:probe` 完全同源，
 * 因此诊断结论即解析进程内的真实行为。
 *
 * 失败一律给出可执行的下一步（重新登录 / 本地补传 / 修正链接），
 * 不把「页面结构变化」伪装成获取成功。
 */
export class TencentMuseSourceAdapter implements SourceAdapter {
  readonly kind = 'TENCENT_MUSE' as const;

  async checkAvailability(): Promise<{ ok: true } | Extract<SourceFetchResult, { ok: false }>> {
    if (!cfg.muse.fetchEnabled) {
      return {
        ok: false,
        code: 'UNSUPPORTED_ADAPTER',
        message:
          '腾讯妙思真实抓取未启用（MUSE_FETCH_ENABLED=false）。执行 npm run muse:login 完成一次扫码登录，' +
          '再把 MUSE_FETCH_ENABLED 改为 true 并重启解析进程；期间请使用本地视频补传。',
        recovery: 'SUPPLEMENT',
      };
    }
    if (!fs.existsSync(cfg.muse.storageState)) {
      return {
        ok: false,
        code: 'SESSION_MISSING',
        message:
          '未找到腾讯妙思登录会话（data/muse-session/state.json）。请执行 npm run muse:login 扫码登录一次，或直接本地补传视频。',
        recovery: 'RELOGIN',
      };
    }
    if (!(await loadPlaywright())) {
      return {
        ok: false,
        code: 'UNSUPPORTED_ADAPTER',
        message:
          '未安装 playwright 运行时，无法执行妙思抓取。请在项目目录执行 npm install playwright && npx playwright install chromium，或使用本地补传。',
        recovery: 'SUPPLEMENT',
      };
    }
    return { ok: true };
  }

  async fetch(input: { videoId: string; url?: string | null }): Promise<SourceFetchResult> {
    const url = (input.url ?? '').trim();
    if (!url) {
      return { ok: false, code: 'INVALID_URL', message: '未提供腾讯妙思链接', recovery: 'FIX_INPUT' };
    }
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, code: 'INVALID_URL', message: '链接格式无法解析', recovery: 'FIX_INPUT' };
    }
    // 只允许约定域名，不把任意输入当作服务器路径或内部网络地址读取（PRD 11.2）
    if (!cfg.muse.allowedHosts.includes(u.hostname)) {
      return {
        ok: false,
        code: 'INVALID_URL',
        message: `仅支持 ${cfg.muse.allowedHosts.join('、')} 域名下的素材链接，当前为 ${u.hostname}`,
        recovery: 'FIX_INPUT',
      };
    }
    // 必须可定位到单条素材，不对首页自动批量抓取
    if (!locatesSingleMaterial(u)) {
      return {
        ok: false,
        code: 'ABUSE_LIST_PAGE',
        message: '该链接指向素材列表/首页，无法定位到单条视频。请粘贴单条素材的链接。',
        recovery: 'FIX_INPUT',
      };
    }

    const avail = await this.checkAvailability();
    if (!avail.ok) return avail;

    const downloaded: any[] = [];
    let lastError = '';
    let browser: Awaited<ReturnType<typeof openMuseBrowser>> | null = null;

    try {
      browser = await openMuseBrowser({ headless: cfg.muse.headless });
      const page = await browser.context.newPage();
      // 有些素材页会自行触发下载，先接住，避免漏掉
      page.on('download', (d: any) => downloaded.push(d));
      // 板块采集要在导航前挂好：详情页首屏会自行请求 ranking_detail/get
      const harvest = attachMuseHarvest(page);

      const insp = await inspectMusePage({
        page,
        url,
        navTimeoutMs: cfg.muse.navTimeoutMs,
        waitMs: cfg.muse.waitMs,
      });

      if (insp.loginWall) {
        return {
          ok: false,
          code: 'SESSION_EXPIRED',
          message:
            '腾讯妙思登录态已失效（页面弹出登录框）。请重新执行 npm run muse:login 扫码登录，或本地补传视频。' +
            ' 注意：登录态失效时页面只剩站点装饰素材，若不做校验会抓到一段约 9 秒的宣传片，因此这里直接判失败。',
          recovery: 'RELOGIN',
        };
      }

      // 链接被弹回首页/其他页：没进到目标素材，任何页面上的媒体地址都不能当结果
      if (!insp.materialReached) {
        return {
          ok: false,
          code: 'MATERIAL_NOT_REACHED',
          message:
            `打开链接后未进入该素材详情页（当前停在 ${insp.finalUrl || '未知地址'}）。` +
            '常见原因是妙思登录态已失效，或该素材已下架/无权限。请重新扫码登录后重试，或确认链接指向单条素材。',
          recovery: 'RELOGIN',
        };
      }

      const dest = cachePathFor(input.videoId, safeExt(extFromUrl(insp.best?.url ?? '')) || '.mp4');
      // 板块与素材时长先取：时长用来校验「下到的到底是不是这条素材」。
      // 详情页同时挂着相关推荐，只按地址证据下单有可能拿到别的视频。
      const insight = await fetchMuseInsight({ page, url, harvest });
      const expectedSec = insight.durationSec ?? 0;

      // 按证据分从高到低试候选：装饰/站点素材已在候选打分与主播放器两处排除
      const ranked = rankCandidates([...(insp.best ? [insp.best] : []), ...insp.candidates]).filter(
        (c) => scoreCandidate(c) >= MIN_MEDIA_SCORE,
      );
      let acceptPath = '';
      for (const c of ranked.slice(0, MAX_CANDIDATE_TRIES)) {
        const candPath = cachePathFor(input.videoId, safeExt(extFromUrl(c.url)) || '.mp4');
        try {
          await downloadWithContext(browser.context, c.url, candPath, url);
          if (fileSize(candPath) <= 0) {
            lastError = '直链下载结果为空';
            continue;
          }
        } catch (e) {
          // HLS 需用 ffmpeg 拉流拼片，且必须透传登录 cookie
          if (c.kind === 'hls') {
            try {
              const ffmpegPath = (await import('ffmpeg-static')).default as unknown as string;
              await downloadHlsWithFfmpeg(
                ffmpegPath,
                c.url,
                candPath,
                await cookieHeaderFor(browser.context, c.url),
                url,
              );
              if (fileSize(candPath) <= 0) {
                lastError = `HLS 合并结果为空（${c.url.slice(0, 60)}）`;
                continue;
              }
            } catch (e2) {
              lastError = `直链失败（${(e as Error).message}）；HLS 合并失败（${(e2 as Error).message}）`;
              continue;
            }
          } else {
            lastError = `直链下载失败（${(e as Error).message}）`;
            continue;
          }
        }

        // 时长校验：与网页标注明显不符的候选直接排除，不交付错误素材
        const mismatch = await durationMismatchNote(candPath, expectedSec);
        if (mismatch) {
          lastError = `候选${mismatch}，已排除`;
          continue;
        }
        acceptPath = candPath;
        break;
      }

      if (acceptPath) {
        return await okWithInsight(harvest, page, url, acceptPath, insp.title, input.videoId, insight);
      }
      if (ranked.length === 0) lastError = lastError || '未在页面中发现可下载的媒体地址';

      // 下载二级：页面自行触发的下载
      if (downloaded.length) {
        try {
          await downloaded[0].saveAs(dest);
          const mismatch = await durationMismatchNote(dest, expectedSec);
          if (fileSize(dest) > 0 && !mismatch) {
            return await okWithInsight(harvest, page, url, dest, insp.title, input.videoId);
          }
          if (mismatch) lastError = `页面触发的下载${mismatch}，已排除`;
        } catch {
          /* 落到点击兜底 */
        }
      }

      // 下载三级：点页面「下载」按钮并接收下载事件（走浏览器自身登录态，最耐改版）
      try {
        const got = await tryBrowserDownload(page, dest, 25_000);
        if (got && fileSize(dest) > 0) {
          const mismatch = await durationMismatchNote(dest, expectedSec);
          if (!mismatch) return await okWithInsight(harvest, page, url, dest, insp.title, input.videoId);
          lastError = `${lastError}；页面下载入口产出的文件${mismatch}`;
        } else {
          lastError = `${lastError}；页面下载入口也未产出文件`;
        }
      } catch (e) {
        lastError = `${lastError}；页面下载入口失败（${(e as Error).message}）`;
      }

      return {
        ok: false,
        code: 'MEDIA_NOT_FOUND',
        message:
          `未能取回该妙思素材：${lastError}。` +
          `（已探测到 ${insp.candidates.length} 个候选地址、${insp.videoSrcs.length} 个 video 元素` +
          (insp.rejectedBest
            ? `；分数最高的一条是站点装饰素材「${insp.rejectedBest.url.split('/').pop() ?? ''}」，已被排除`
            : '') +
          '）请确认该素材仍可访问，或本地补传视频。',
        recovery: 'SUPPLEMENT',
      };
    } catch (e) {
      return {
        ok: false,
        code: 'DOWNLOAD_FAILED',
        message: `妙思获取失败：${(e as Error).message}。已保留原链接，可稍后重试或本地补传。`,
        recovery: 'SUPPLEMENT',
      };
    } finally {
      await browser?.close();
    }
  }
}

/** 链接需能定位到单条素材：带 id 类参数，或路径/哈希里含长标识 */
function locatesSingleMaterial(u: URL): boolean {
  const tail = u.hash + u.search;
  if (/(?:^|[#&/?])(id|materialId|creativeId|itemId|assetId|videoId|detailId)=[^&]+/i.test(tail)) return true;
  // 兼容 path 形式：/asset/video/<32位十六进制或长数字>
  const m = /(?:[#/?])([0-9a-f]{16,}|\d{8,})(?:[/?#]|$)/i.exec(tail + u.pathname);
  return Boolean(m);
}

/** 从媒体地址取容器扩展名；命中不到时返回空串，由调用方回退到 .mp4 */
function extFromUrl(u: string): string {
  try {
    return path.extname(u.split('#')[0].split('?')[0]).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 候选排序：按证据分从高到低，并按地址去重。
 *
 * 必要性：详情页同时挂着官网宣传片、相关推荐与素材本体，`insp.candidates` 是
 * 「页面出现过的一切媒体地址」的原始堆积。不做排序就按出现顺序试下载，
 * 很可能先下到推荐位的别的视频（能下成功、文件也完整），属于静默取错文件。
 */
function rankCandidates(list: MediaCandidate[]): MediaCandidate[] {
  const seen = new Set<string>();
  const uniq = list.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  return uniq.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

/**
 * 读本地文件时长（秒）。读不出返回 0 —— 交由调用方按「无法校验」处理，
 * 不因为 ffprobe 失败就否定一个本来可用的候选。
 */
async function probeDurationSec(file: string): Promise<number> {
  try {
    const info = await probeMedia(file);
    return info.durationMs / 1000;
  } catch {
    return 0;
  }
}

/**
 * 下载文件与网页标注时长是否吻合。
 *
 * 容差取「1.5 秒」与「标注时长的 8%」的较大者：妙思页面上标注的是一个整数秒，
 * 而文件时长精确到毫秒，且同一条素材的不同转码版本可能差零点几秒，卡太死会误杀。
 */
function durationMatches(gotSec: number, expectedSec: number): boolean {
  const tol = Math.max(1.5, expectedSec * 0.08);
  return Math.abs(gotSec - expectedSec) <= tol;
}

/**
 * 时长校验的统一入口：不吻合时返回一句可读说明，吻合或无法校验时返回空串。
 *
 * 「无法校验」（网页没给时长 / ffprobe 读不出）一律放行 —— 拿不到判据时
 * 不该否定一个已经下载成功的候选，但只要有判据就必须用上。
 */
async function durationMismatchNote(file: string, expectedSec: number): Promise<string> {
  if (expectedSec <= 0) return '';
  const gotSec = await probeDurationSec(file);
  if (gotSec <= 0) return '';
  if (durationMatches(gotSec, expectedSec)) return '';
  return `文件时长 ${gotSec.toFixed(1)}s 与网页标注的 ${expectedSec.toFixed(1)}s 明显不符`;
}

/**
 * 取回视频成功后再采集原网页板块（人群分析 / 视频分镜或高光时序 title / 创意标签）。
 * 采集同源复用素材页已发出的接口响应；失败不影响取视频结果：insight 为空值并带原因说明。
 * `preInsight` 为已经取到的那一份（含素材时长校验用过的字段），传进来就不再重复采集。
 */
async function okWithInsight(
  harvest: MuseHarvest,
  page: any,
  url: string,
  dest: string,
  title: string | undefined,
  videoId: string,
  preInsight?: MuseInsight,
): Promise<SourceFetchResult> {
  const insight = preInsight ?? (await fetchMuseInsight({ page, url, harvest }));
  return {
    ok: true,
    localPath: dest,
    fileName: baseFileName(`${title || videoId}${path.extname(dest)}`),
    sourceTitle: title,
    insight,
  };
}
