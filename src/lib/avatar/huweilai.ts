// 鲲之益数字人 Playwright 适配器（2026-09-20）。
//
// ⚠️ 联调状态（2026-09-21 更新，别误读）：
// 会话已用真实账号扫码打通，**页面结构已用多轮探针核对**（_scratch/probe-*.log），
// 本文件的 SELECTORS 与交互顺序按真实 DOM 写。**全链路已真实跑通**：
//   2026-09-21 真实提交两次 —— 首次被平台判「创作失败」（平台间歇性故障，同账号自测也 2 成 2 败），
//   重提一次即成功：`12856` 17:52 提交 → 18:03:58 创作完成，成品 243.67MB / 73.68s / 1216×2160，
//   一路走到 `FETCHING → SUCCEEDED` 并把成品落盘 `data/avatars/<业务名>.mp4`。
// 因此这几条不再是「尚未验证」，改选择器时别当成没跑过的代码：
//   · 提交 → 「先填完必填项、再等按钮可用、不可用就明确报错」，绝不点 disabled 按钮后谎报「结果不明」；
//   · 提交后拿不到作品 ID 时 → 按**唯一作品名**回作品列表确认（见 confirmSubmittedByName）；
//   · 查询/取回 → 按平台作品 ID 找，找不到**必须回退作品名**（ID 是读回来的，读写之间可能对不上）；
//   · 取回 → 优先行内下载入口；没有就退到「读媒体地址 + 会话 cookie 下载」。
// 想在不花钱的前提下验证选择器，仍可用 `npm run avatar:smoke`（preflight，只填不提交）。
// 成品已经出来后那一段（卡片/播放器/下载完整性）由 `npm run verify:avatar-video` 守着。
//
// 探针核实到的真实结构（改选择器前先看这段）：
//   · 登录态 = **localStorage.token**，不是 cookie；会话文件 data/avatar-session/state.json；
//   · 文本输入 = `textarea[placeholder="请输入文本"]`；
//   · 形象列表 = 左侧平铺的 `div.list > div.item`，名字在 `div.item > div.name`（**不是按钮、不是弹层**）；
//     选中状态靠面板上的「当前形象：<名字>」确认；
//   · 音色入口 = `div.choose-btn.choose-voice-btn`（**是 div 不是 button**，`button:has-text` 命中 0）；
//     点击后弹 **Arco Modal**（标题「发音人」，内含 我的/公用 两个页签 + 配音列表 + 取消/确定），
//     选完必须点「确定」，光按 Escape 关不掉；
//   · 背景音乐入口 = `div.choose-btn.choose-bg-btn`；
//   · 参数 = `div.slider-item`（内有 `div.label`，文案「口播语速」「口播音量」）；
//   · 作品列表 = 真 `tr.arco-table-tr`；表头 ID/作品名称/视频封面/分身/端类型/完成状态/提交时间/结束时间/操作；
//     状态文案为「创作完成 / 创作中 / 创作失败」；
//   · **成品媒体在阿里云 OSS**（kzyszross.oss-cn-beijing.aliyuncs.com），**不在** aigc.huweilai.cn
//     → 白名单必须放 OSS 域名，否则会被 AVATAR_URL_HOST_REJECTED 拒掉；
//   · 成品 mp4 地址需点行内「播放视频」后才出现在 `<video src>`；封面列只是 `?x-oss-process=video/snapshot` 的 jpg。
//
// 与妙思的关系：同一套 playwright 运行时，但**会话完全独立**（data/avatar-session/state.json）。
// 两个站点不同账号，共用会话文件会互相覆盖登录态。

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cfg } from '../config';
import { loadPlaywright } from '../sources/muse-browser';
import {
  AvatarError,
  type AvatarAdapter,
  type AvatarAsset,
  type AvatarAssistResult,
  type AvatarFetchResult,
  type AvatarPreflightResult,
  type AvatarPreflightStep,
  type AvatarQueryResult,
  type AvatarSubmitInput,
  type AvatarSubmitResult,
  type AvatarWorkRow,
} from './types';

/**
 * 页面选择器候选表。
 * 每项给多个候选并按顺序尝试，全部失败才报错 —— 单个选择器写死是抓取类工作的主要返工来源。
 * **联调时只改这里。**
 */
const SELECTORS = {
  /** 登录态判断：出现这些文案说明被弹回登录页 */
  loginWall: ['扫码登录', '请登录', '登录后继续', '微信扫码', '账号登录', '登录 / 注册', '手机号登录'],
  /** 登录凭据位置（localStorage 键名）—— 鲲之益用的是 token 而不是 cookie */
  tokenStorageKey: 'token',

  /** 文本输入区（探针实测精确 placeholder） */
  textInput: [
    'textarea[placeholder="请输入文本"]',
    'textarea[placeholder*="请输入文本"]',
    'textarea[placeholder*="文本"]',
    'textarea[placeholder*="文案"]',
    '.ql-editor',
    'div[contenteditable="true"]',
  ],

  /**
   * 作品名称输入框。
   * 探针实测 placeholder 是**「请输入视频名称」** —— 不是「作品名」。
   * 所以必须把「视频名称」放第一个；靠泛化的 `placeholder*="名称"` 去兜是危险的：
   * 页面里 `请输入名称搜索`（成片保存至）、`请输入名称`（隐藏弹层）都含「名称」，
   * 一旦 DOM 顺序变化就会把作品名填到文件夹搜索框里。
   */
  workName: [
    'input[placeholder="请输入视频名称"]',
    'input[placeholder*="视频名称"]',
    'input[placeholder*="作品名"]',
    'input[placeholder*="作品名称"]',
  ],
  /**
   * 「成片保存至」文件夹选择框（**必填**）。
   * 探针实测：placeholder 是「请输入名称搜索」，点开后弹 `arco-trigger-popup` 列出账号下的文件夹
   * （李威数字人 / 夏总 / 凡哥 / 陈伟鸿 / … / 新建文件夹）。
   * 不选它，「生成视频」按钮一直是 disabled —— 这是提交前唯一容易漏掉的必填项。
   */
  /**
   * 「成片保存至」文件夹选择框（**必填**）。
   *
   * 探针实测结构（2026-09-20）：
   *   <div class="save-directory">
   *     <span>成片保存至：</span><div class="serach">
   *       <span class="arco-select-view" title="李威数字人">      ← 选中后 title = 文件夹名
   *         <input class="arco-select-view-input" placeholder="请输入名称搜索">
   *         <span class="arco-select-view-value">李威数字人</span>  ← 选中后这里才有文本
   *
   * ⚠️ 两个坑（都踩过）：
   * ① 选中后**那个 input 会从 DOM 里消失**（加了 `arco-select-view-input-hidden`，且 placeholder 变成文件夹名），
   *    所以不能用 `input[placeholder*="名称搜索"]` 当锚点去回读；
   * ② 用 `div.arco-select` 做祖先匹配也拿不到 —— 实际类名是 `arco-select-view`，容器类名是 `save-directory`（拼写就是 serach）。
   * 因此统一以 `div.save-directory` 为锚点：点它的输入框，读它的 `arco-select-view-value` / `title`。
   */
  saveFolderRoot: 'div.save-directory',
  saveFolderBox: [
    'div.save-directory input.arco-select-view-input',
    'div.save-directory span.arco-select-view',
    'input[placeholder="请输入名称搜索"]',
  ],
  saveFolderValue: [
    'div.save-directory span.arco-select-view-value',
    'div.save-directory span.arco-select-view',
  ],
  /** Arco Select 的下拉层（文件夹列表在这里）。首选 select-dropdown：那是真正承载选项的容器 */
  folderDropdown: 'div.arco-select-dropdown:visible',
  folderPopup: 'div.arco-select-dropdown:visible, div.arco-trigger-popup:visible',

  /** 形象列表：左侧平铺卡片（`div.list > div.item`），名字节点 `div.item > div.name` */
  avatarList: ['div.list', '[class*="avatar"] div.list'],
  avatarItem: 'div.item',
  avatarNameNode: 'div.name',
  /** 面板上显示当前所选形象的文案（用于「选完必须确认」的校验） */
  currentAvatarLabels: ['当前形象', '已选形象'],
  /** 音色弹层触发器：是 div 不是 button，所以 text= 兜底比 button:has-text 更可靠 */
  voiceTriggerCss: ['div.choose-btn.choose-voice-btn', 'div.choose-btn-wrap div.choose-voice-btn'],
  voiceTriggerText: ['选择音色', '音色'],
  /** 背景音乐触发器。**目前只做「已经开着就关掉」的尝试**（真实形态是 div 按钮 + 弹层，不是 switch），
   *  所以暂未直接使用；留给后续真正实现「选背景音乐」时用，别当成死代码删掉。 */
  bgmTriggerCss: ['div.choose-btn.choose-bg-btn', 'div.choose-btn-wrap div.choose-bg-btn'],
  bgmTriggerText: ['选择音乐', '背景音乐'],
  /** 音色弹层（Arco Modal） */
  /**
   * 弹层选择器**必须带 `:visible`**。
   * 创建页 DOM 里同时挂着好几个 `div.arco-modal`（隐藏的「新增文件夹」排在前、可见的「发音人」排在后），
   * 用 `.first()` 会稳定地取到**隐藏的那个**，于是 isVisible 永远 false ——
   * 实测就是这样误报「点了音色入口但没弹出弹层」，而其实弹层已经开了。
   */
  modal: 'div.arco-modal:visible',
  modalBody: 'div.arco-modal:visible div.arco-modal-body',
  modalTitleEl: 'div.arco-modal-title',

  /** 参数行：`div.slider-item` 内含 `div.label`（口播语速 / 口播音量） */
  paramItem: 'div.slider-item',
  speedLabel: ['口播语速', '语速'],
  volumeLabel: ['口播音量', '音量'],

  /** 字幕 / 断句区域（探针见 `div.subtitles-textarea > div.actions > div.item`「智能断句」） */
  subtitleArea: 'div.subtitles-textarea',
  subtitleLabel: ['智能断句', '字幕'],

  /** 提交按钮：需求要「一整条口播」，所以排除任何带「分段 / 拆分」的按钮 */
  submit: ['生成视频', '立即生成', '开始生成', '确认生成', '提交生成'],
  /** 提交按钮仍禁用时，页面上可能出现的「还缺什么」提示 */
  submitDisabledHints: ['请选择分身', '请选择形象', '请输入文本', '请选择音色'],

  /** 作品列表：真的 arco 表格行 */
  workRow: ['tr.arco-table-tr', 'tr', '[class*="row"]', '[class*="card"]'],
  /** 行内打开播放器（成品 mp4 地址点开后才出现在 <video src>） */
  playButton: ['播放视频', '播放', '预览'],
  videoEl: 'video',
  downloadButton: ['下载', '下载视频', '导出'],
} as const;

/**
 * 「我的作品」列表的表头关键词 → 列含义。
 *
 * 为什么按表头找列、不写死 `td[0..6]`：探针实测（2026-09-22）当前顺序是
 * `ID / 作品名称 / 视频封面 / 分身 / 端类型 / 完成状态 / 提交时间 / 结束时间 / 操作`，
 * 但平台加一列（比如插个「时长」）就会让所有下标错位，而错位后的后果是**静默取错值** ——
 * 比如把端类型当成状态。按表头文案定位，加列不再影响取值。
 */
const WORK_COLUMN_HINTS = {
  id: ['ID'],
  name: ['作品名称', '作品名'],
  status: ['完成状态', '状态'],
  submitTime: ['提交时间', '创建时间'],
} as const;

/**
 * 解析平台作品列表里的提交时间（`2026-09-22 11:17`）为毫秒。
 *
 * 平台显示的是**北京时间**，所以显式按 +08:00 解析；拿不到秒就补 `:00`。
 * 解析不出来返回 undefined —— 时间线判据宁可少一条证据，也不能拿错时间当证据。
 */
function parseWorkSubmittedAt(s: string): number | undefined {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s ?? '');
  if (!m) return undefined;
  const pad = (v: string) => v.padStart(2, '0');
  const iso = `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${m[6] ?? '00'}+08:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * 成品媒体允许的域名后缀。
 *
 * 为什么需要后缀白名单而不是只列精确域名：平台把成品放在**阿里云 OSS 的公网 bucket** 上
 * （探针实测 kzyszross.oss-cn-beijing.aliyuncs.com），bucket 名和 region 都可能变；
 * 而 `AVATAR_ALLOWED_HOSTS` 里如果只写 aigc.huweilai.cn，成品链接会被直接拒掉。
 * 云存储厂商域名属于「平台自己的存储」，与站点主域同级可信，所以按后缀放行。
 */
const MEDIA_HOST_SUFFIXES = ['.aliyuncs.com', '.myqcloud.com', '.qcloudimg.com', '.cos.ap-'];

/** 提交结果的「不明」判定窗口：超过这个时间没拿到作品 ID 就进入待核对，不猜、不重提 */
const SUBMIT_CONFIRM_MS = 60_000;

/**
 * 提交后「从响应/URL 里捞作品 ID」的窗口。
 *
 * 为什么单独拆出来并缩短到 15 秒：平台点提交后**整页跳转到作品页**，URL 上不带 id，
 * 响应体也不一定是 JSON（实测两条路都捞不到，白等满 60 秒）。真正可靠的判据是
 * 「作品列表里出现了自己的唯一作品名」—— 见 confirmSubmittedByName()。
 */
const SUBMIT_ID_SNIFF_MS = 15_000;

/** 按作品名确认提交时的轮询：列表写入有延迟，给它几次机会 */
const CONFIRM_ATTEMPTS = 4;
const CONFIRM_INTERVAL_MS = 4_000;

/** 等提交按钮可用的上限。超时即报错，**不回退成「点了再说」** */
const SUBMIT_ENABLE_WAIT_MS = 30_000;

/**
 * 创建页表单就绪上限。
 *
 * 2026-09-22 实测：连续快速建任务时创建页会偶发**整页空白** —— 截图只有 6.7KB 纯白，
 * 而正常渲染是 267KB。那次直接抛出「创建页上找不到文本输入区」，把人往选择器上带，
 * 其实页面压根没渲染出来。所以这里先轮询表单，等不到就重载一次再等。
 */
const CREATE_FORM_WAIT_MS = 30_000;

type Ctx = { browser: any; context: any; page: any; close: () => Promise<void> };

async function openAvatarBrowser(opts: { headless: boolean }): Promise<Ctx> {
  const pw = await loadPlaywright();
  if (!pw) throw new AvatarError('AVATAR_PLAYWRIGHT_MISSING', '未安装 playwright 运行时，无法访问鲲之益平台');

  const statePath = cfg.avatar.storageState;
  const browser = await pw.chromium.launch({
    headless: opts.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    storageState: fs.existsSync(statePath) ? statePath : undefined,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(cfg.avatar.actionTimeoutMs);
  page.setDefaultNavigationTimeout(cfg.avatar.navTimeoutMs);

  return {
    browser,
    context,
    page,
    close: async () => {
      try {
        await context.close();
      } catch {
        /* 忽略 */
      }
      try {
        await browser.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/**
 * 截图存到临时目录，返回路径。
 *
 * ⚠️ 必须 **await**：早期版本写成 `page.screenshot(...).catch()` 不 await，
 * 结果报错分支里 `finally { ctx.close() }` 先把浏览器关了，截图一张都没落盘 ——
 * 而截图恰恰是判断「平台页面到底变成了什么样」的唯一线索（实测踩过，全空目录）。
 * 截图失败不影响主流程，所以整体吞异常、返回 undefined。
 */
async function shot(page: any, tag: string): Promise<string | undefined> {
  try {
    const dir = path.join(cfg.tmpDir, 'avatar-shots');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${tag}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    return p;
  } catch {
    return undefined;
  }
}

/** 依次尝试候选选择器，返回第一个可见的元素；全部失败返回 null */
async function firstVisible(page: any, candidates: readonly string[], timeoutMs = 8000): Promise<any | null> {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: timeoutMs })) return loc;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** 按可见文本找可点击元素（按钮 / 标签 / 卡片都可能是不同标签名） */
async function firstByText(page: any, texts: readonly string[], timeoutMs = 8000): Promise<any | null> {
  for (const t of texts) {
    for (const tmpl of [`button:has-text("${t}")`, `[role="button"]:has-text("${t}")`, `text="${t}"`]) {
      try {
        const loc = page.locator(tmpl).first();
        if (await loc.isVisible({ timeout: timeoutMs })) return loc;
      } catch {
        /* 试下一个候选 */
      }
    }
  }
  return null;
}

/** CSS 候选 → 文本候选 依次尝试（音色/音乐入口是 div，只试 button:has-text 会全部落空） */
async function firstByCssOrText(
  page: any,
  css: readonly string[],
  texts: readonly string[],
  timeoutMs = 8000,
): Promise<any | null> {
  const byCss = await firstVisible(page, css, timeoutMs);
  if (byCss) return byCss;
  return firstByText(page, texts, timeoutMs);
}

/**
 * 登录态检测。
 * 除登录墙文案外，**必须**补一个硬信号：鲲之益的凭据是 localStorage.token 而不是 cookie，
 * 用 cookie 判断会假报「会话可用」——这是上一轮踩过的坑（avatar:login --check 假通过）。
 */
async function detectLoginWall(page: any): Promise<boolean> {
  const url = page.url();
  if (/\/login|\/signin|\/auth/i.test(url)) return true;
  const hasToken = await page
    .evaluate(
      `(() => { try { return !!localStorage.getItem(${JSON.stringify(SELECTORS.tokenStorageKey)}); } catch { return false; } })()`,
    )
    .catch(() => false);
  if (hasToken) return false;
  for (const t of SELECTORS.loginWall) {
    try {
      if (await page.locator(`text=${t}`).first().isVisible({ timeout: 1500 })) return true;
    } catch {
      /* 未出现 */
    }
  }
  // 既没有 token、也没有登录墙文案：按「会话不可用」处理比放行更安全（放行会跑出错乱的失败）
  return true;
}

export class HuweilaiAvatarAdapter implements AvatarAdapter {
  readonly mode = 'playwright' as const;

  private url(p: string) {
    return new URL(p, cfg.avatar.baseUrl).toString();
  }

  /** 打开创建页并等渲染（SPA，domcontentloaded 之后还要等表单挂载） */
  private async gotoCreate(ctx: Ctx): Promise<void> {
    await ctx.page.goto(this.url(cfg.avatar.createPath), { waitUntil: 'domcontentloaded' });
    // 探针实测：4.5s 后表单与形象列表才稳定，2.5s 偶发取不到
    await ctx.page.waitForTimeout(4500);

    const walled = async (): Promise<boolean> => detectLoginWall(ctx.page);
    const throwWalled = () => {
      throw new AvatarError('AVATAR_NEEDS_LOGIN', '鲲之益会话已失效，请重新扫码登录（npm run avatar:login -- --force）');
    };
    if (await walled()) throwWalled();

    // 表单就绪轮询 + 空白页重载（原因见 CREATE_FORM_WAIT_MS 注释）
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deadline = Date.now() + CREATE_FORM_WAIT_MS;
      while (Date.now() < deadline) {
        if (await firstVisible(ctx.page, SELECTORS.textInput, 500)) return;
        if (await walled()) throwWalled();
        await ctx.page.waitForTimeout(1000).catch(() => undefined);
      }
      if (attempt === 0) {
        const p = await shot(ctx.page, 'create-form-blank');
        console.warn(
          `[avatar] 创建页 ${CREATE_FORM_WAIT_MS / 1000} 秒内没渲染出表单（疑似空白页${p ? `，已截图 ${p}` : ''}），重载一次`,
        );
        await ctx.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
        await ctx.page.waitForTimeout(4000);
        if (await walled()) throwWalled();
      }
    }
    // 两轮都没等到：不再在这里报错，交给 locateTextBox 给出统一口径（含截图）
    console.warn('[avatar] 创建页重载后仍未渲染出表单，交给文本区定位逻辑判定');
  }

  async checkLogin() {
    if (!fs.existsSync(cfg.avatar.storageState)) {
      return {
        ok: false,
        message: `未找到鲲之益登录会话（${cfg.avatar.storageState}）。请执行 npm run avatar:login 扫码登录一次。`,
      };
    }
    const ctx = await openAvatarBrowser({ headless: cfg.avatar.headless });
    try {
      await ctx.page.goto(this.url(cfg.avatar.createPath), { waitUntil: 'domcontentloaded' });
      await ctx.page.waitForTimeout(3000);
      const walled = await detectLoginWall(ctx.page);
      return walled
        ? { ok: false, message: '鲲之益会话已失效（无登录令牌或出现登录墙），请重新扫码登录' }
        : { ok: true, message: '鲲之益会话可用（有登录令牌，未出现登录墙）' };
    } finally {
      await ctx.close();
    }
  }

  /**
   * 定位默认形象与音色。
   * 关键：**统计匹配数量**，只有恰好 1 个才算可用；0 个（找不到）或 ≥2 个（重名）都报错（A13）。
   * 形象与音色的匹配方式不同（前者是平铺列表里的名字节点，后者是弹层里的条目），所以分开统计。
   */
  async resolveAssets(): Promise<{ avatar: AvatarAsset; voice: AvatarAsset; message: string }> {
    const ctx = await openAvatarBrowser({ headless: cfg.avatar.headless });
    try {
      await this.gotoCreate(ctx);

      const avatar = await this.countAvatar(ctx, cfg.avatar.avatarName);
      if (avatar.matched !== 1) {
        throw new AvatarError(
          'AVATAR_ASSET_NOT_UNIQUE',
          avatar.matched === 0
            ? `平台上找不到形象「${cfg.avatar.avatarName}」；不会改用其他人物（A13）`
            : `平台上匹配到 ${avatar.matched} 个形象叫「${cfg.avatar.avatarName}」，存在重名；不会猜一个（A13）`,
        );
      }

      const voice = await this.countVoice(ctx, cfg.avatar.voiceName);
      if (voice.matched !== 1) {
        throw new AvatarError(
          'AVATAR_ASSET_NOT_UNIQUE',
          voice.matched === 0
            ? `平台上找不到音色「${cfg.avatar.voiceName}」；不会改用其他声音（A13）`
            : `平台上匹配到 ${voice.matched} 个音色叫「${cfg.avatar.voiceName}」，存在重名；不会猜一个（A13）`,
        );
      }
      return { avatar, voice, message: '默认形象与音色均唯一匹配' };
    } finally {
      await ctx.close();
    }
  }

  /** 统计形象名匹配数：只数左侧列表里的名字节点，避免把「当前形象」回显也算进去 */
  private async countAvatar(ctx: Ctx, name: string): Promise<AvatarAsset> {
    const list = await firstVisible(ctx.page, SELECTORS.avatarList, 6000);
    if (!list) {
      throw new AvatarError(
        'AVATAR_PICKER_NOT_FOUND',
        `创建页上找不到形象列表（试过：${SELECTORS.avatarList.join(' / ')}）。` +
          `真实页面结构可能变了，需在 src/lib/avatar/huweilai.ts 的 SELECTORS 中校正。`,
      );
    }
    const names = await list.locator(SELECTORS.avatarNameNode).allInnerTexts().catch(() => [] as string[]);
    const hit = names.filter((t: string) => t.trim() === name);
    return { name, matched: hit.length, raw: `列表内 ${names.length} 个形象，精确同名 ${hit.length} 个` };
  }

  /**
   * 统计音色匹配数：必须打开弹层才能看到音色列表。
   * 弹层是 Arco Modal（标题「发音人」），**只统计可见弹层的 body**，
   * 否则会把页面里其他被隐藏的 trigger-popup（文件夹树等）里的同名文本一起数进来。
   */
  private async countVoice(ctx: Ctx, name: string): Promise<AvatarAsset> {
    const opened = await this.openVoiceModal(ctx);
    try {
      const body = ctx.page.locator(SELECTORS.modalBody).first();
      // 用 getByText(exact) 计数，不用 page.evaluate 注入字符串：
      // 注入版的返回值在实测里拿到过 undefined（导致 `undefined.length` 直接崩），
      // 而且 tsx 给具名函数注入 __name 也会在页面上下文报错 —— 走 Playwright 自带文本匹配最稳。
      const matched = await body
        .getByText(name, { exact: true })
        .count()
        .catch(() => 0);
      const bodyText: string = (await body.innerText().catch(() => '')) || '';
      return {
        name,
        matched,
        raw: `音色弹层（${opened.title}）内精确同名节点 ${matched} 个；正文：${bodyText.replace(/\s+/g, ' ').slice(0, 120)}`,
      };
    } finally {
      await this.closeModal(ctx);
    }
  }

  /** 打开音色弹层，返回标题；失败抛错并保留截图 */
  private async openVoiceModal(ctx: Ctx): Promise<{ title: string }> {
    const trigger = await firstByCssOrText(ctx.page, SELECTORS.voiceTriggerCss, SELECTORS.voiceTriggerText, 6000);
    if (!trigger) {
      const p = await shot(ctx.page, 'no-voice-trigger');
      throw new AvatarError(
        'AVATAR_PICKER_NOT_FOUND',
        `创建页上找不到音色入口（CSS 试过：${SELECTORS.voiceTriggerCss.join(' / ')}；文案试过：${SELECTORS.voiceTriggerText.join(' / ')}）` +
          `${p ? `；已截图 ${p}` : ''}`,
      );
    }
    await trigger.click();
    await ctx.page.waitForTimeout(1500);
    const modal = ctx.page.locator(SELECTORS.modal).first();
    if (!(await modal.isVisible({ timeout: 4000 }).catch(() => false))) {
      const p = await shot(ctx.page, 'no-voice-modal');
      throw new AvatarError('AVATAR_PICKER_NOT_FOUND', `点了音色入口但没有弹出音色弹层${p ? `（已截图 ${p}）` : ''}`);
    }
    const title = (await modal.locator(SELECTORS.modalTitleEl).first().innerText().catch(() => '')) || '(无标题)';
    return { title: title.trim() };
  }

  /** 关掉弹层：点「取消」；Escape 关不掉 Arco Modal（探针实测），所以优先点按钮 */
  private async closeModal(ctx: Ctx): Promise<void> {
    const modal = ctx.page.locator(SELECTORS.modal).first();
    if (!(await modal.isVisible({ timeout: 800 }).catch(() => false))) return;
    const cancel = modal.locator('button:has-text("取消")').first();
    if (await cancel.isVisible({ timeout: 1200 }).catch(() => false)) {
      await cancel.click().catch(() => undefined);
    } else {
      const closeBtn = modal.locator('div.arco-modal-close-btn').first();
      await closeBtn.click({ timeout: 1500 }).catch(() => undefined);
    }
    await ctx.page.waitForTimeout(600);
  }

  async submit(input: AvatarSubmitInput): Promise<AvatarSubmitResult> {
    const ctx = await openAvatarBrowser({ headless: cfg.avatar.headless });
    try {
      const submitBtn = await this.prepareDraft(ctx, input);

      /**
       * 提交前必须等按钮**可用**。
       * 探针实测：必填项没填完时 `生成视频` 是 disabled —— 点它不会发出任何请求。
       * 旧实现直接 click 再等 60s，结果报「已提交但拿不到 ID，进入待核对」，
       * 这是**谎报**（其实什么都没提交），会让编导去平台上找一个根本不存在的作品。
       */
      if (!(await this.waitSubmitEnabled(ctx, submitBtn, SUBMIT_ENABLE_WAIT_MS))) {
        const p = await shot(ctx.page, 'submit-disabled');
        const hint = await this.readDisabledHint(ctx);
        throw new AvatarError(
          'AVATAR_SUBMIT_DISABLED',
          `生成按钮一直处于禁用状态，**未提交任何任务**${hint ? `（页面提示：${hint}）` : ''}` +
            `；请核对形象/音色/文本是否都已选填完整${p ? `；已截图 ${p}` : ''}`,
        );
      }

      // 监听提交请求，尽量从响应里拿平台作品 ID —— 拿不到就进「结果待核对」，绝不重提
      let vendorJobId: string | undefined;
      const sniff = (resp: any) => {
        try {
          const u = resp.url();
          if (!/create|generate|submit|task|video/i.test(u) || resp.request().method() !== 'POST') return;
          resp
            .json()
            .then((j: any) => {
              const id = j?.data?.id ?? j?.data?.task_id ?? j?.data?.video_id ?? j?.id ?? j?.taskId;
              if (id && !vendorJobId) vendorJobId = String(id);
            })
            .catch(() => undefined);
        } catch {
          /* 响应不是 JSON，忽略 */
        }
      };
      ctx.page.on('response', sniff);

      await submitBtn.click();
      await ctx.page.waitForTimeout(3000);

      const deadline = Date.now() + SUBMIT_ID_SNIFF_MS;
      while (!vendorJobId && Date.now() < deadline) {
        // 提交后页面常会跳转到作品页；从 URL 里也可能抓到 ID
        const m = ctx.page.url().match(/[?&](?:id|taskId|task_id|videoId)=([\w-]+)/);
        if (m) vendorJobId = m[1];
        if (vendorJobId) break;
        await ctx.page.waitForTimeout(1500);
      }
      ctx.page.off('response', sniff);

      /**
       * 两条快路都捞不到 ID 时，**不要直接判「结果不明」**。
       *
       * 2026-09-21 真实提交实测：平台提交成功后整页跳转到作品页，URL 不带 id、
       * 响应体也不是 JSON，于是旧逻辑把一次**已经成功**的提交标成「结果待核对」，
       * 编导看到「未收到平台作品 ID」就以为没提交 —— 而平台上已经有作品在「创作中」了。
       *
       * 可靠判据是**唯一作品名**：提交前我们给这次任务生成了带修订号与时间戳的作品名
       * （VSA-<revId尾6>-r<修订号>-<时间戳>），平台会在这上面追加一个账号内序号后缀，
       * 所以用「包含」匹配即可。列表里出现它 = 确定提交成功。
       */
      if (!vendorJobId) {
        const confirmed = await this.confirmSubmittedByName(ctx, input.businessName);
        if (confirmed) {
          return {
            vendorJobId: confirmed.vendorJobId,
            message:
              `已提交：作品列表中已出现「${confirmed.name}」` +
              `（平台状态：${confirmed.status}${confirmed.vendorJobId ? `，平台作品 ID：${confirmed.vendorJobId}` : ''}）`,
          };
        }
      }

      if (!vendorJobId) {
        const p = await shot(ctx.page, 'submit-uncertain');
        // 这里**不能**随便给个成功或失败：真实状态未知，必须交给「结果待核对」按作品名查（§7.4）
        return {
          message: '提交后未收到平台作品 ID，结果不明；已进入「结果待核对」，不会自动重复提交',
          uncertain: true,
          screenshotPath: p,
        };
      }
      return { vendorJobId, message: `已提交，平台作品 ID：${vendorJobId}` };
    } catch (e) {
      if (e instanceof AvatarError) throw e;
      const p = await shot(ctx.page, 'submit-error');
      throw new AvatarError(
        'AVATAR_SUBMIT_FAILED',
        `${e instanceof Error ? e.message : String(e)}${p ? `（已截图 ${p}）` : ''}`,
        { uncertain: true }, // 提交阶段异常：状态可能已改变，按「待核对」处理最安全
      );
    } finally {
      await ctx.close();
    }
  }

  /**
   * 只填表不提交的预检 —— **不消耗平台额度**。
   * 用途：真实提交前验证「选择器是否还和平台一致」「必填项能不能填全」。
   * 提交按钮仍禁用时也照实报告（那说明还有必填项没填上），不会为了「看起来通过」而放宽判定。
   */
  async preflight(input: AvatarSubmitInput): Promise<AvatarPreflightResult> {
    const ctx = await openAvatarBrowser({ headless: cfg.avatar.headless });
    const steps: AvatarPreflightStep[] = [];
    try {
      const submitBtn = await this.prepareDraft(ctx, input, steps);
      const enabled = !(await submitBtn.isDisabled().catch(() => true));
      const hint = enabled ? undefined : await this.readDisabledHint(ctx);
      steps.push({
        name: '提交按钮可用',
        ok: enabled,
        detail: enabled ? '可提交' : `仍为禁用${hint ? `（页面提示：${hint}）` : ''}，说明还有必填项没填上`,
      });
      const ok = steps.every((s) => s.ok);
      const p = await shot(ctx.page, ok ? 'preflight-ok' : 'preflight-incomplete');
      return {
        ok,
        steps,
        submitEnabled: enabled,
        message: ok
          ? '预检通过：表单可填完整、提交按钮可用（**未提交**，无额度消耗）'
          : '预检未完全通过：部分步骤有问题，详见 steps；**未提交**',
        screenshotPath: p,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      steps.push({ name: '预检中断', ok: false, detail: msg });
      const p = await shot(ctx.page, 'preflight-error');
      return {
        ok: false,
        steps,
        submitEnabled: false,
        message: `预检失败：${msg}（**未提交任何任务**）`,
        screenshotPath: p,
      };
    } finally {
      await ctx.close();
    }
  }

  /**
   * 填表到「提交前」：步骤 1~5 + 定位提交按钮，返回该按钮（**不点击**）。
   * 抽出来是为了让 preflight（零额度预检）与 submit（真提交）共用**同一份**填表逻辑 ——
   * 否则「预检通过」就不等于「提交能走通」，联调又退化成靠猜。
   */
  private async prepareDraft(ctx: Ctx, input: AvatarSubmitInput, steps?: AvatarPreflightStep[]): Promise<any> {
    const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      try {
        const r = await fn();
        steps?.push({ name, ok: true, detail: 'ok' });
        return r;
      } catch (e) {
        steps?.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };

    await phase('打开创建页并确认登录', () => this.gotoCreate(ctx));

    // ---- 1. 填文本（只填正文，不含标签/时间码/内部编号 —— A14）----
    const box = await phase('定位文本输入区', () => this.locateTextBox(ctx));

    await phase(`填入文本（${input.text.length} 字）`, () => this.fillText(ctx, box, input.text));

    // ---- 2. 形象（列表点选，然后校验「当前形象」回显）----
    await phase(`选择形象「${input.avatarName}」`, async () => {
      const c = await this.countAvatar(ctx, input.avatarName);
      if (c.matched !== 1) {
        throw new AvatarError(
          'AVATAR_ASSET_NOT_UNIQUE',
          `形象「${input.avatarName}」匹配到 ${c.matched} 个（${c.raw}）；必须唯一匹配，不会静默换人（A13）`,
        );
      }
      await this.pickAvatar(ctx, input.avatarName);
    });

    // ---- 3. 音色（弹层点选 + 点「确定」）----
    await phase(`选择音色「${input.voiceName}」`, async () => {
      const c = await this.countVoice(ctx, input.voiceName);
      if (c.matched !== 1) {
        throw new AvatarError(
          'AVATAR_ASSET_NOT_UNIQUE',
          `音色「${input.voiceName}」匹配到 ${c.matched} 个（${c.raw}）；必须唯一匹配，不会静默换声音（A13）`,
        );
      }
      await this.pickVoice(ctx, input.voiceName);
    });

    // ---- 4. 参数（语速 / 音量 / 字幕；找不到控件就跳过，默认值本就是 1.0）----
    await phase(`设置参数（语速 ${input.speed} / 音量 ${input.volume} / 字幕 ${input.subtitle ? '开' : '关'}）`, async () => {
      await this.setParamByLabel(ctx, SELECTORS.speedLabel, String(input.speed));
      await this.setParamByLabel(ctx, SELECTORS.volumeLabel, String(input.volume));
      await this.setSwitch(ctx, SELECTORS.subtitleLabel, input.subtitle);
      // 背景音乐：真实页面上是个「选择音乐」的 div 按钮 + 弹层，不是 switch，
      // 这里只做「已经开着就关掉」的尝试；控件形态对不上就跳过，绝不乱点（宁可不动也不要改错配置）
      await this.setSwitch(ctx, SELECTORS.bgmTriggerText, input.bgm);
    });

    // ---- 5. 成片保存至（**必填**，不选它提交按钮一直是禁用的）----
    await phase(`选择成片保存文件夹「${cfg.avatar.saveFolder}」`, async () => {
      await this.setSaveFolder(ctx, cfg.avatar.saveFolder);
    });

    // ---- 6. 作品名（核对与防重依据）----
    await phase(`填写作品名「${input.businessName}」`, () =>
      this.fillWorkName(ctx, input.businessName, { required: false }),
    );

    // ---- 7. 定位提交按钮（**不点击**）----
    return phase('定位提交按钮', async () => {
      const btn = await firstByText(ctx.page, SELECTORS.submit, 6000);
      if (!btn) {
        const p = await shot(ctx.page, 'no-submit-button');
        throw new AvatarError(
          'AVATAR_SUBMIT_NOT_FOUND',
          `找不到生成按钮（试过：${SELECTORS.submit.join(' / ')}）${p ? `；已截图 ${p}` : ''}`,
        );
      }
      return btn;
    });
  }

  /** 定位文本输入区（自动提交与人工接手共用，报错文案只此一份） */
  private async locateTextBox(ctx: Ctx): Promise<any> {
    const el = await firstVisible(ctx.page, SELECTORS.textInput, 6000);
    if (!el) {
      const p = await shot(ctx.page, 'no-text-input');
      throw new AvatarError(
        'AVATAR_TEXT_INPUT_NOT_FOUND',
        `创建页上找不到文本输入区（试过：${SELECTORS.textInput.join(' / ')}）${p ? `；已截图 ${p}` : ''}`,
      );
    }
    return el;
  }

  /**
   * 填文案 + 回读校验（自动提交与人工接手共用）。
   *
   * 回读校验不是多余的：填不进去时「生成视频」会一直禁用，早失败比等到「按钮不可用」强
   * （探针踩过这个坑：填完按钮仍 disabled，查半天才发现文本压根没进去）。
   *
   * ⚠️ 它只能校验**输入框里的值**。平台在**提交之后**会把句末标点归一成逗号
   * （2026-09-21 实测：库内 386 字含 `。`×12 / `？`×2 / `、`×1，平台上变成 385 字、38 个逗号），
   * 那一步发生在平台自己的生成管线里 —— 已实测「填入后立刻回读 / 等 2.5 秒 / 失焦」三种时机都原样保留，
   * 说明不是我们发送环节改的。所以这里**不能**因为标点形态不同就报错。
   */
  private async fillText(ctx: Ctx, box: any, text: string): Promise<void> {
    await box.click();
    await box.fill(text).catch(async () => {
      // contenteditable 不支持 fill，退回键盘输入
      await ctx.page.keyboard.press('Control+A');
      await ctx.page.keyboard.type(text, { delay: 2 });
    });
    const got = await box.inputValue().catch(() => null);
    if (got !== null && got.trim() !== text.trim()) {
      const p = await shot(ctx.page, 'text-not-filled');
      throw new AvatarError(
        'AVATAR_TEXT_INPUT_FAILED',
        `文本没填进输入框（期望 ${text.length} 字，实际 ${got.length} 字）${p ? `；已截图 ${p}` : ''}`,
      );
    }
  }

  /**
   * 填作品名（自动提交与人工接手共用），但两种口径不同。
   *
   * 自动提交时找不到这个框只算「不影响生成」的警告：平台会用默认名
   * （实测默认值是 `数字人_<日期> <时间>`），成片照样能出。
   * **人工接手时必须当致命错误** —— 那个模式下我们不看有没有点到按钮，
   * 唯一判据就是「作品列表里有没有这个唯一名」。框没填上等于丧失判据，提交了也认不出来。
   */
  private async fillWorkName(ctx: Ctx, businessName: string, opts: { required: boolean }): Promise<void> {
    const nameBox = await firstVisible(ctx.page, SELECTORS.workName, 4000);
    if (!nameBox) {
      throw new AvatarError(
        'AVATAR_WORKNAME_NOT_FOUND',
        opts.required
          ? '找不到作品名输入框 —— 人工接手必须写上唯一作品名（它是判断「到底提交了没有」的唯一依据），因此中断，未提交任何内容'
          : '找不到作品名输入框，已跳过（不影响生成）',
      );
    }
    await nameBox.fill(businessName).catch(() => undefined);
    const got = await nameBox.inputValue().catch(() => null);
    if (opts.required && got !== null && got.trim() !== businessName.trim()) {
      const p = await shot(ctx.page, 'workname-not-filled');
      throw new AvatarError(
        'AVATAR_WORKNAME_NOT_FILLED',
        `作品名没填进输入框（期望「${businessName}」，实际「${got || '(空)'}」）${p ? `；已截图 ${p}` : ''}`,
      );
    }
  }

  /**
   * 人工接手（`AVATAR_SUBMIT_MODE=assist`）。
   *
   * 流程：开一个**可见**的浏览器 → 打开创建页 → 只预填作品名与文案 → **停手**，
   * 由编导自己挑形象/音色/参数/`成片保存至` 文件夹，自己点「生成视频」。
   *
   * 为什么这么设计（2026-09-21 真实联调结论）：自动提交最脆的几段全在「替平台做参数校验」上
   * —— 形象/音色必须唯一匹配（A13）、参数滑杆、必填文件夹、按钮可用性判断。
   * 它们改动频繁，而且坏了以后平台只回一句「请检查配置参数」，没法诊断。
   *
   * 判定提交与否**只认一个判据**：作品列表里有没有出现我们的唯一作品名。
   * 这一个判据同时覆盖三种结束方式（点了生成 / 关掉窗口 / 等待超时），而且是可验证的事实 ——
   * 所以 `cancelled` 是确定结论（确实没提交），不是自动提交那种「结果不明」。
   */
  async assistSubmit(input: AvatarSubmitInput): Promise<AvatarAssistResult> {
    let reason = 'timeout';
    // 观察期的诊断信息（挂在 try 外，好让下面的错误信息带上：「为什么没了」比「没了」有用得多）
    let closeDetail = '';
    let waitedSec = 0;
    let lastUrl = '';
    /** 本次提交尝试的开始时间：回查时用来划「本次之后新建的作品」这条时间线 */
    let startedAt = Date.now();
    /** 观察到「页面跳到作品列表」时抢下来的那条平台作品（改名免疫的钥匙），见下面注释 */
    let jumpedWork: AvatarWorkRow | undefined;

    // 有头浏览器必须可见：这个模式下浏览器是给人用的，无视 AVATAR_HEADLESS
    let ctx: Ctx;
    try {
      ctx = await openAvatarBrowser({ headless: false });
    } catch (e) {
      throw new AvatarError(
        'AVATAR_ASSIST_NO_DISPLAY',
        `人工接手需要弹出可见的浏览器窗口，但启动有头浏览器失败：${e instanceof Error ? e.message : String(e)}。` +
          '本模式要有桌面环境（服务器上请改用 AVATAR_SUBMIT_MODE=auto）。',
      );
    }

    try {
      await this.gotoCreate(ctx);
      await this.fillText(ctx, await this.locateTextBox(ctx), input.text);
      await this.fillWorkName(ctx, input.businessName, { required: true });

      /**
       * 预填完把窗口提到最前。
       *
       * 2026-09-22 实测踩到：有头窗口默认可能开在别的窗口后面、也不抢焦点，
       * 编导看不到「弹出来了」，就以为是自己没关干净的旧窗口，顺手关掉了 ——
       * 结果界面上表现为「人工接手已取消」，而其实人根本没来得及操作。
       * 置前失败不影响主流程（远程/无窗口管理器环境会失败），所以吞异常。
       */
      await ctx.page.bringToFront().catch(() => undefined);
      console.log(
        `[assist] 创建页已打开并预填（作品名 ${input.businessName}，${input.text.length} 字，窗口已置前），` +
          `等待人工选形象/参数并点「生成视频」，上限 ${Math.round(cfg.avatar.assistTimeoutMs / 60000)} 分钟`,
      );

      /**
       * 关闭原因诊断（2026-09-22 补）：
       * 连续三次都停在「协助窗口被关闭」这一句上 —— 光看 `page.isClosed()` 分不清
       * 是「人点了叉」「渲染进程崩了」还是「浏览器进程被杀」，等于没有线索。
       * 挂上事件监听把这三者区分开，写进日志与任务错误信息里。
       */
      ctx.page.on('crash', () => {
        closeDetail = '页面渲染进程崩溃（page crash）';
      });
      ctx.context.on('close', () => {
        if (!closeDetail) closeDetail = '浏览器上下文被关闭（等同于人点叉关窗）';
      });
      ctx.browser.on('disconnected', () => {
        if (!closeDetail) closeDetail = '浏览器进程断开（disconnected，多为进程被杀或崩溃）';
      });

      /**
       * 停手，只观察、不点击：
       *   · 页面被关掉 → 人放弃了；
       *   · URL 变成作品列表 → 人点了「生成视频」（平台提交后会整页跳过去，实测如此）。
       * 超时上限 AVATAR_ASSIST_TIMEOUT_MS，到时也照常去回查作品列表，不猜。
       */
      startedAt = Date.now();
      const deadline = startedAt + cfg.avatar.assistTimeoutMs;
      lastUrl = String(ctx.page.url());
      let jumped = false;
      while (Date.now() < deadline) {
        if (ctx.page.isClosed()) {
          reason = 'closed';
          break;
        }
        lastUrl = String(ctx.page.url());
        if (lastUrl.includes(cfg.avatar.worksPath)) {
          jumped = true;
          break;
        }
        await ctx.page.waitForTimeout(2000).catch(() => undefined);
      }
      waitedSec = Math.round((Date.now() - startedAt) / 1000);

      /**
       * 跳到作品列表那一刻，**立刻**把平台作品 ID 抓下来。
       *
       * 为什么必须抢这个瞬间（2026-09-22 事故）：平台的**作品 ID 不随改名变化，作品名会**。
       * 编导提交完随手在平台上改个名（实测就是这样把作品改成「信息流编导工作台测试_1」），
       * 我们存着的唯一作品名立刻失效，之后按名字对账永远找不到那条作品 ——
       * 结果一条**已经出片成功**的任务被判成「确定没提交」。抢到 ID 就没有这个问题。
       */
      if (jumped) {
        for (let i = 0; i < 3 && !jumpedWork; i++) {
          const rows = await this.readWorksTable(ctx, 10).catch(() => [] as AvatarWorkRow[]);
          const mine = rows.find((w) => w.name.includes(input.businessName));
          if (mine) jumpedWork = mine;
          else await ctx.page.waitForTimeout(2000).catch(() => undefined);
        }
      }

      console.log(
        `[assist] 观察结束：${jumped ? '页面已跳到作品列表（疑似已提交）' : reason === 'closed' ? '协助窗口被关闭' : '等待超时'}，` +
          `停留 ${waitedSec}s，最后 URL ${lastUrl}` +
          `${jumpedWork ? `，已抢到平台作品 ID ${jumpedWork.vendorJobId ?? '(未读到)'}「${jumpedWork.name}」` : ''}` +
          `${reason === 'closed' ? `，关闭原因判定：${closeDetail || '未捕获到关闭事件（页面在事件挂上之前就已消失）'}` : ''}` +
          `；现在回查作品列表确认是否提交`,
      );
    } finally {
      await ctx.close();
    }

    // 用独立的干净上下文回查作品列表来判定结果 —— 协助窗口已经被关掉/跳走了，不复用它
    const probe = await openAvatarBrowser({ headless: cfg.avatar.headless });
    try {
      await probe.page.goto(this.url(cfg.avatar.worksPath), { waitUntil: 'domcontentloaded' });
      await probe.page.waitForTimeout(3500);
      if (await detectLoginWall(probe.page)) {
        return {
          kind: 'uncertain',
          vendorJobId: jumpedWork?.vendorJobId,
          message: '人工接手已结束，但平台会话失效，查不了作品列表 —— 无法确认是否已提交，不会自动重复提交',
        };
      }

      const found = await this.confirmSubmittedByName(probe, input.businessName);
      if (found) {
        return {
          kind: 'submitted',
          vendorJobId: found.vendorJobId,
          message:
            `人工接手：已确认提交（作品列表里查到「${input.businessName}」${found.platformName !== input.businessName ? `，平台现名「${found.platformName}」` : ''}` +
            `${found.vendorJobId ? `，平台作品 ID ${found.vendorJobId}` : '，暂未读回平台作品 ID'}）`,
        };
      }
      /**
       * 跳转瞬间抢到的那条就是铁证：它是在**页面刚跳到作品列表**时按我们的唯一作品名匹到的，
       * 说明提交确实成功了。回查这一次没查到，通常是列表刷新延迟或编导已经改了名 ——
       * 两种情况下都不该推翻「已提交」这个结论。
       */
      if (jumpedWork) {
        return {
          kind: 'submitted',
          vendorJobId: jumpedWork.vendorJobId,
          message:
            `人工接手：已确认提交（点击「生成视频」跳转到作品列表时，在列表里看到「${jumpedWork.name}」` +
            `${jumpedWork.vendorJobId ? `，平台作品 ID ${jumpedWork.vendorJobId}` : '，暂未读回平台作品 ID'}）`,
        };
      }

      // 没查到再补一次登录墙判断：中途掉线会伪装成「没提交」，那是会误导人的结论
      if (await detectLoginWall(probe.page)) {
        return { kind: 'uncertain', message: '人工接手已结束，但平台会话失效，无法确认是否已提交' };
      }

      const why =
        reason === 'closed'
          ? `协助窗口被关闭（${closeDetail || '未捕获到关闭事件'}；停留 ${waitedSec}s，最后 URL ${lastUrl}）`
          : `等待超时（${Math.round(cfg.avatar.assistTimeoutMs / 60000)} 分钟无人操作）`;

      /**
       * ⚠️ 关键：按作品名查不到，**不等于**「确定没提交」。
       *
       * 编导可能在平台上把作品改名了 —— 那一刻起唯一作品名就永久失效，而作品本身是存在的。
       * 所以补一道**时间线判据**：列表里若有「提交时间晚于本次提交尝试」的作品，
       * 就说明很可能是我们自己那条被改了名。
       *
       * 这里必须保守：`cancelled` 会让上层清空 submittedAt 并允许重新提交，
       * 判错的代价是「丢掉一条真出片的任务 + 可能重复计费」（2026-09-22 实际发生过）。
       * 时间线可疑 → 一律按「待核对」交给人，并在界面上给出绑定入口。
       */
      const attempted = input.attemptedAtMs ?? startedAt;
      const works = await this.readWorksTable(probe, 20).catch(() => [] as AvatarWorkRow[]);
      const suspects = works.filter((w) => typeof w.submittedAtMs === 'number' && w.submittedAtMs >= attempted - 120_000);
      if (suspects.length) {
        const s = suspects[0];
        return {
          kind: 'uncertain',
          vendorJobId: s.vendorJobId,
          message:
            `人工接手已结束（${why}）。作品列表里查不到我们提交的作品名「${input.businessName}」，` +
            `但发现 ${suspects.length} 条在本次提交时间之后创建的作品 —— ` +
            `最新一条：平台作品 ID ${s.vendorJobId ?? '(未读到)'}「${s.name}」${s.status ? `（${s.status}）` : ''}` +
            `${s.submittedAt ? `，提交于 ${s.submittedAt}` : ''}。` +
            '很可能是我们的作品在平台上被改过名，因此不能断定没提交：' +
            '按「结果待核对」处理，不会自动重复提交。可在工作台用「绑定平台作品」把这条作品接回本任务。',
        };
      }

      return {
        kind: 'cancelled',
        reason,
        message:
          `人工接手未完成（${why}），作品列表里既查不到「${input.businessName}」，` +
          '也没有「本次提交时间之后新建」的作品 —— 确定没有提交过，未消耗平台额度。' +
          '可重新点「生成数字人视频」再来一次。',
      };
    } finally {
      await probe.close();
    }
  }

  /**
   * 选择「成片保存至」的文件夹 —— 提交前的**必填**步骤。
   *
   * 为什么必须有这一步（实测，不是推测）：形象、音色、文本、作品名全填好之后，
   * 「生成视频」按钮**仍然是 disabled**；截图逐项比对后，唯一空着的就是右上角这个文件夹下拉。
   * 也就是说漏了它，提交会永远卡在「按钮不可用」。
   *
   * 控件形态：Arco Select（`input.arco-select-view-input`，placeholder「请输入名称搜索」），
   * 点开后弹 `arco-select-popup`，里面是账号下的文件夹列表。
   * 校验**不能读 input 的 value**：Arco Select 把选中项渲染成 `span.arco-select-view-value`，
   * 那个 input 只是搜索框，选完仍是空字符串 —— 实测就是这样误报「选了但回读为空」，而其实已经选上了。
   * 所以改为读整个 select 容器的可见文本。
   */
  private async setSaveFolder(ctx: Ctx, folder: string): Promise<void> {
    if (!folder) {
      throw new AvatarError('AVATAR_SAVE_FOLDER_NOT_FOUND', '未配置成片保存文件夹（AVATAR_SAVE_FOLDER），无法完成提交前必填项');
    }
    const box = await firstVisible(ctx.page, SELECTORS.saveFolderBox, 4000);
    if (!box) {
      const p = await shot(ctx.page, 'no-save-folder');
      throw new AvatarError(
        'AVATAR_SAVE_FOLDER_NOT_FOUND',
        `创建页上找不到「成片保存至」选择框（试过：${SELECTORS.saveFolderBox.join(' / ')}）${p ? `；已截图 ${p}` : ''}`,
      );
    }
    const readShown = async (): Promise<string> => {
      // 优先读 arco-select-view-value 的文本；它为空时退回 span.arco-select-view 的 title 属性
      const v = await ctx.page
        .locator(SELECTORS.saveFolderValue[0])
        .first()
        .innerText()
        .catch(() => '');
      if ((v || '').trim()) return v.trim();
      const t = await ctx.page
        .locator(SELECTORS.saveFolderValue[1])
        .first()
        .getAttribute('title')
        .catch(() => null);
      return (t ?? '').trim();
    };

    // 已经选好了就不重复点（重复点会把下拉打开又关掉，反而可能清空已选值）
    if ((await readShown()).includes(folder)) return;

    await box.click();
    await ctx.page.waitForTimeout(1200);

    // 下拉层：优先取 Arco 的 select-dropdown（探针实测真实类名），取不到再退到 trigger-popup。
    // 不用 `.last()`：DOM 里同时挂着好几个 trigger-popup（后面还有隐藏的模板下拉），顺序不可靠。
    const dropdown = ctx.page.locator(SELECTORS.folderDropdown).first();
    const popup = (await dropdown.isVisible({ timeout: 2500 }).catch(() => false))
      ? dropdown
      : ctx.page.locator(SELECTORS.folderPopup).first();
    if (!(await popup.isVisible({ timeout: 2000 }).catch(() => false))) {
      const p = await shot(ctx.page, 'no-folder-popup');
      throw new AvatarError('AVATAR_SAVE_FOLDER_NOT_FOUND', `点了「成片保存至」但没弹出文件夹列表${p ? `（已截图 ${p}）` : ''}`);
    }

    // 选项是 `<li class="arco-select-option">` 而不是 div —— 用 class 匹配、不写死标签名
    const option = popup.locator('li.arco-select-option, .arco-select-option').filter({ hasText: folder }).first();
    const target = (await option.isVisible({ timeout: 2000 }).catch(() => false))
      ? option
      : popup.getByText(folder, { exact: true }).first();
    if (!(await target.isVisible({ timeout: 2500 }).catch(() => false))) {
      const list = ((await popup.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 200);
      await ctx.page.keyboard.press('Escape').catch(() => undefined);
      throw new AvatarError(
        'AVATAR_SAVE_FOLDER_NOT_FOUND',
        `文件夹列表里找不到「${folder}」，不会随便挑一个（会把成片存到别的目录）。现有文件夹：${list}`,
      );
    }
    await target.click();
    await ctx.page.waitForTimeout(1200);

    // 回读校验：读 select 容器的可见文本（不是 input 的 value）
    const shown = await readShown();
    if (!shown.includes(folder)) {
      const p = await shot(ctx.page, 'folder-not-selected');
      throw new AvatarError(
        'AVATAR_SAVE_FOLDER_NOT_FOUND',
        `选了文件夹「${folder}」但「成片保存至」显示的是「${shown || '(空)'}」，未确认选中${p ? `（已截图 ${p}）` : ''}`,
      );
    }
  }

  /** 等提交按钮从 disabled 变为可用；超时返回 false（不回退成「点了再说」） */
  private async waitSubmitEnabled(ctx: Ctx, btn: any, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const disabled = await btn.isDisabled().catch(() => false);
      if (!disabled) return true;
      await ctx.page.waitForTimeout(800);
    }
    return !(await btn.isDisabled().catch(() => true));
  }

  /** 读页面上「还缺什么」的提示文案，用于把禁用原因说清楚 */
  private async readDisabledHint(ctx: Ctx): Promise<string | undefined> {
    for (const t of SELECTORS.submitDisabledHints) {
      try {
        if (await ctx.page.locator(`text=${t}`).first().isVisible({ timeout: 600 })) return t;
      } catch {
        /* 未出现 */
      }
    }
    return undefined;
  }

  /** 在形象列表里点中唯一匹配的形象，并用「当前形象」回显校验是否真的选中 */
  private async pickAvatar(ctx: Ctx, name: string): Promise<void> {
    const list = await firstVisible(ctx.page, SELECTORS.avatarList, 6000);
    if (!list) throw new AvatarError('AVATAR_PICKER_NOT_FOUND', '找不到形象列表，无法选择形象');
    const item = list.locator(SELECTORS.avatarItem).filter({ hasText: name }).first();
    if (!(await item.isVisible({ timeout: 4000 }).catch(() => false))) {
      throw new AvatarError('AVATAR_ASSET_NOT_UNIQUE', `形象列表里点不到「${name}」`);
    }
    await item.click();
    await ctx.page.waitForTimeout(1500);

    // 校验：优先读「当前形象：<name>」回显（含名字的最内层容器）；
    // 读不到再退到 class 上的选中态。两条都不成立就报错，不假设点选生效了。
    const echo: string = await ctx.page
      .evaluate(
        `(() => {
          const name = ${JSON.stringify(name)};
          const labels = ${JSON.stringify(SELECTORS.currentAvatarLabels)};
          for (const e of Array.from(document.querySelectorAll('*'))) {
            const t = (e.textContent || '').trim();
            if (t.length < 200 && labels.some(l => t.includes(l)) && t.includes(name)) return t;
          }
          return '';
        })()`,
      )
      .catch(() => '');
    let ok = echo.includes(name);
    if (!ok) {
      const cls: string = (await item.getAttribute('class').catch(() => '')) || '';
      ok = /active|selected|checked|current/i.test(cls);
    }
    if (!ok) {
      const p = await shot(ctx.page, 'avatar-not-selected');
      throw new AvatarError(
        'AVATAR_ASSET_NOT_UNIQUE',
        `点了形象「${name}」但页面上看不到选中回显（既无「当前形象：${name}」，条目也没有选中态）` +
          `，未继续提交${p ? `（已截图 ${p}）` : ''}`,
      );
    }
  }

  /** 打开音色弹层 → 点中唯一匹配的音色 → 点「确定」→ 校验入口按钮回显 */
  private async pickVoice(ctx: Ctx, name: string): Promise<void> {
    await this.openVoiceModal(ctx);
    const modal = ctx.page.locator(SELECTORS.modal).first();
    const item = modal.getByText(name, { exact: true }).first();
    if (!(await item.isVisible({ timeout: 4000 }).catch(() => false))) {
      await this.closeModal(ctx);
      throw new AvatarError('AVATAR_ASSET_NOT_UNIQUE', `音色弹层里点不到「${name}」`);
    }
    await item.click();
    await ctx.page.waitForTimeout(800);

    // 弹层必须点「确定」才生效（Escape 关不掉，点取消等于放弃）。
    // 确认按钮**必须限定在弹层内**查找：页面上别处也有「确定」（探针就见到「新增文件夹」弹层的确定），
    // 用全局 text=确定 有概率点到别的弹层上去。
    const confirm = modal.locator('button:has-text("确定"), button:has-text("确认")').first();
    if (!(await confirm.isVisible({ timeout: 2500 }).catch(() => false))) {
      await this.closeModal(ctx);
      const p = await shot(ctx.page, 'voice-no-confirm');
      throw new AvatarError('AVATAR_PICKER_NOT_FOUND', `音色弹层里找不到「确定」按钮，已取消本次选择${p ? `（已截图 ${p}）` : ''}`);
    }
    await confirm.click();
    await ctx.page.waitForTimeout(1200);
  }

  /**
   * 按 label 文案设置参数行里的数值。
   * 探针实测结构：`div.slider-item > div.label`（口播语速 / 口播音量），值控件在同一个 slider-item 内。
   * 找不到就不动 —— 默认值本就是 1.0，宁可不动也不要乱点。
   */
  private async setParamByLabel(ctx: Ctx, labels: readonly string[], value: string): Promise<void> {
    for (const label of labels) {
      for (const item of await ctx.page.locator(SELECTORS.paramItem).all().catch(() => [])) {
        const text: string = await item.innerText().catch(() => '');
        if (!text.includes(label)) continue;
        const input = item.locator('input').first();
        if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
          await input.fill(value).catch(() => undefined);
        }
        return;
      }
    }
  }

  /** 开关类设置：找到文案所在容器里的 switch 再判断当前状态，避免把已开的关掉 */
  private async setSwitch(ctx: Ctx, texts: readonly string[], want: boolean): Promise<void> {
    const area = await firstVisible(ctx.page, [SELECTORS.subtitleArea], 2500);
    const scope = area ?? ctx.page;
    for (const t of texts) {
      const label = scope.locator(`text="${t}"`).first();
      if (!(await label.isVisible({ timeout: 1000 }).catch(() => false))) continue;
      const container = label.locator('xpath=ancestor::*[self::div or self::label][1]');
      const sw = container.locator('[role="switch"], input[type="checkbox"], .switch, .arco-switch').first();
      if (!(await sw.isVisible({ timeout: 1200 }).catch(() => false))) continue;
      const checked = await sw
        .getAttribute('aria-checked')
        .then((v: string | null) => v === 'true' || v === 'checked')
        .catch(() => false);
      if (checked !== want) await sw.click().catch(() => undefined);
      return;
    }
  }

  /**
   * 读「我的作品」列表的表头，解析出各列的下标。
   *
   * 取不到表头（页面结构变了 / 还没渲染完）时**退回已知布局**（0/1/5/6）而不是报错：
   * 这里是给对账加保险的，不该因为表头读不到就把正常流程打断。
   */
  private async readWorkColumns(ctx: Ctx): Promise<{ id: number; name: number; status: number; submitTime: number }> {
    const fallback = { id: 0, name: 1, status: 5, submitTime: 6 };
    const headers: string[] = await ctx.page
      .evaluate(
        // 必须以**字符串**形式传：tsx 注入的 __name 在页面上下文里不存在（踩过）
        `(() => {
          const rows = Array.from(document.querySelectorAll('tr'));
          const head = rows.find((tr) => /作品名称/.test(tr.innerText || '')) || rows[0];
          if (!head) return [];
          return Array.from(head.querySelectorAll('th,td')).map((c) => (c.innerText || '').replace(/\\s+/g, '').trim());
        })()`,
      )
      .catch(() => [] as string[]);
    if (!Array.isArray(headers) || headers.length === 0) return fallback;

    const idx = { ...fallback };
    const found = new Set<string>();
    headers.forEach((h, i) => {
      for (const [key, hints] of Object.entries(WORK_COLUMN_HINTS) as [
        keyof typeof WORK_COLUMN_HINTS,
        readonly string[],
      ][]) {
        if (found.has(key)) continue;
        if (hints.some((hint) => h === hint || h.includes(hint))) {
          idx[key] = i;
          found.add(key);
        }
      }
    });
    return idx;
  }

  /**
   * 把「我的作品」列表整表读成结构化行（最近的在前，即页面顺序）。
   *
   * 只读，不点任何按钮。用于两件事：关窗后的**时间线判据**、以及给编导做**绑定**时列最近作品。
   */
  private async readWorksTable(ctx: Ctx, limit = 20): Promise<AvatarWorkRow[]> {
    const cols = await this.readWorkColumns(ctx);
    const rows: string[][] = await ctx.page
      .evaluate(
        `(() => {
          const out = [];
          for (const tr of Array.from(document.querySelectorAll('tr'))) {
            const cells = Array.from(tr.querySelectorAll('td')).map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim());
            if (cells.length) out.push(cells);
          }
          return out;
        })()`,
      )
      .catch(() => [] as string[][]);

    const list: AvatarWorkRow[] = [];
    for (const cells of rows) {
      const name = (cells[cols.name] ?? '').trim();
      const id = (cells[cols.id] ?? '').trim();
      // 数据行判定：名称列有值，或 ID 列是纯数字。表头行会被这一步滤掉。
      if (!name && !/^\d{4,}$/.test(id)) continue;
      const submittedAt = (cells[cols.submitTime] ?? '').trim();
      list.push({
        vendorJobId: /^\d{4,}$/.test(id) ? id : undefined,
        name,
        status: (cells[cols.status] ?? '').replace(/\s+/g, ' ').trim(),
        submittedAt: submittedAt || undefined,
        submittedAtMs: parseWorkSubmittedAt(submittedAt),
      });
      if (list.length >= limit) break;
    }
    return list;
  }

  /**
   * 只读平台作品列表（公开动作，供「绑定平台作品」与诊断用）。
   *
   * 会话失效**明确抛错**而不是回空数组：空数组会被上层误解成「账号里一条作品都没有」，
   * 而真因是没登录 —— 那会把编导往错误方向带。
   */
  async listWorks(limit = 20): Promise<AvatarWorkRow[]> {
    const ctx = await openAvatarBrowser({ headless: cfg.avatar.headless });
    try {
      await ctx.page.goto(this.url(cfg.avatar.worksPath), { waitUntil: 'domcontentloaded' });
      await ctx.page.waitForTimeout(4000);
      if (await detectLoginWall(ctx.page)) {
        throw new AvatarError('AVATAR_NEEDS_LOGIN', '鲲之益会话已失效，读不了作品列表，请重新扫码登录');
      }
      return await this.readWorksTable(ctx, limit);
    } finally {
      await ctx.close();
    }
  }

  async query(ref: { vendorJobId?: string | null; businessName: string }): Promise<AvatarQueryResult> {
    const ctx = await openAvatarBrowser({ headless: cfg.avatar.headless });
    try {
      await ctx.page.goto(this.url(cfg.avatar.worksPath), { waitUntil: 'domcontentloaded' });
      await ctx.page.waitForTimeout(3500);
      if (await detectLoginWall(ctx.page)) {
        return { status: 'NEEDS_LOGIN', message: '鲲之益会话已失效，请重新扫码登录' };
      }

      const row = await this.findWorkRow(ctx, ref);
      if (!row) {
        return {
          status: 'NOT_FOUND',
          message:
            `作品列表里找不到「${ref.vendorJobId ?? ref.businessName}」。可能是提交未成功，或列表分页/筛选需要调整；` +
            '若作品在平台上被改过名，请在工作台用「绑定平台作品」按平台作品 ID 重新关联。',
        };
      }
      const cols = await this.readWorkColumns(ctx);
      const text = (await row.innerText().catch(() => '')) as string;
      /**
       * 平台自己的作品 ID 顺带读出来回填。
       * 提交时若没捞到 ID（跳转丢参数），这里是**唯一能补上它的地方** ——
       * 补上以后按 ID 定位就更稳，平台侧也能对上号。**改名也不会改变 ID**，所以它是改名免疫的那把钥匙。
       */
      const resolvedId = ref.vendorJobId ?? (await this.readPlatformWorkId(row, cols.id));
      // 状态格文案（如「创作中」）——比整行 innerText 干净得多，见 readStatusLabel 的注释
      const statusLabel = await this.readStatusLabel(row, cols.status);
      const progress = statusLabel
        ? `平台状态：${statusLabel}`
        : text.replace(/\s+/g, ' ').trim().slice(0, 200);

      // 平台状态文案 → 内部状态；识别不了就报 NEEDS_REVIEW 交给人工，不猜。
      // 「创作中 / 创作完成 / 创作失败」是探针在真实列表里看到的文案。
      // 顺序很重要：先判「创作中」，否则「创作中」会被 /完成|成功/ 之类误判成成功。
      if (/创作中|生成中|处理中|排队|等待|制作中|渲染中|%/.test(text)) {
        return { status: 'RUNNING', vendorJobId: resolvedId, progress, message: '平台生成中' };
      }
      if (/失败|错误|违规|不通过|已取消/.test(text)) {
        return { status: 'FAILED', vendorJobId: resolvedId, progress, message: '平台侧生成失败' };
      }
      if (/创作完成|已完成|成功|完成/.test(text)) {
        const assetUrl = await this.readAssetUrl(ctx, row);
        return {
          status: 'SUCCEEDED',
          vendorJobId: resolvedId,
          assetUrl,
          progress,
          message: '平台已生成完成',
        };
      }
      return {
        status: 'NEEDS_REVIEW',
        vendorJobId: resolvedId,
        progress,
        message: '平台状态文案无法识别，需人工核对（未自动判定为成功或失败）',
      };
    } finally {
      await ctx.close();
    }
  }

  /**
   * 提交后按**唯一作品名**在作品列表里确认「到底提交成功没有」。
   *
   * 返回 null = 列表里确实没有（这才叫「结果不明」）；返回对象 = 确认已提交，附带平台作品 ID 与状态文案。
   * 全程只读列表，**不点任何按钮、不重提**。
   *
   * 同时回传**平台上当前显示的作品名**：平台会给作品名追加 `_<账号内序号>`，编导也可能再改名，
   * 记下来才好在界面上说清「我们提交的名字」和「平台现在叫什么」的对应关系。
   */
  private async confirmSubmittedByName(
    ctx: Ctx,
    businessName: string,
  ): Promise<{ vendorJobId?: string; name: string; platformName: string; status: string } | null> {
    if (!businessName) return null;
    try {
      await ctx.page.goto(this.url(cfg.avatar.worksPath), { waitUntil: 'domcontentloaded' });
    } catch {
      return null;
    }

    for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
      await ctx.page.waitForTimeout(i === 0 ? 3500 : CONFIRM_INTERVAL_MS);
      if (await detectLoginWall(ctx.page)) return null; // 会话中途失效：交回上层按「待核对」处理
      const row = await this.findWorkRow(ctx, { businessName });
      if (row) {
        const cols = await this.readWorkColumns(ctx);
        const showName = ((await row
          .locator('td')
          .nth(cols.name)
          .innerText()
          .catch(() => '')) as string)
          .replace(/\s+/g, ' ')
          .trim();
        const status = await this.readStatusLabel(row, cols.status);
        return {
          vendorJobId: await this.readPlatformWorkId(row, cols.id),
          name: businessName,
          platformName: showName || businessName,
          status: status || ((await row.innerText().catch(() => '')) as string).replace(/\s+/g, ' ').trim().slice(0, 60),
        };
      }
    }
    return null;
  }

  /**
   * 从作品行里读出**平台自己的作品 ID**。
   *
   * 探针实测（2026-09-21）：`tr.arco-table-tr` 的 `td[0]` 就是平台作品 ID（纯数字，如 12847），
   * `td[1]` 是作品名称（平台会追加 `_<账号内序号>` 后缀），`td[5]` 是「创作中/创作完成/创作失败」。
   * 只在前 3 个单元格里找纯数字，避免把名称里的数字或时间戳当 ID。
   *
   * 2026-09-22 改成**按表头定位列**：ID 列下标由 `readWorkColumns()` 给出，平台加列不会错位。
   */
  private async readPlatformWorkId(row: any, idIdx = 0): Promise<string | undefined> {
    const tds = row.locator('td');
    const n = await tds.count().catch(() => 0);
    const order = [idIdx, 0, 1, 2].filter((v, i, a) => a.indexOf(v) === i && v < Math.max(n, 1));
    for (const i of order) {
      const t = ((await tds.nth(i).innerText().catch(() => '')) as string).trim();
      if (/^\d{4,}$/.test(t)) return t;
    }
    return undefined;
  }

  /**
   * 从作品行里读出**状态单元格**的干净文案。
   *
   * 为什么单独抽这一个（2026-09-21 真实重提时发现）：早前把整行 `innerText` 直接当 progress
   * 存进 `reconcileNote`，编导在卡片「待核对说明」里看到的是平台表格的**原始行文本** ——
   * 作品 ID、作品名、分身、端类型、两个时间戳全糊在一起，还带换行和制表符：
   *
   *   12856\n\nVSA-…_12573\n\n\n极速\n\n电脑端\n\n创作中\n\n2026-09-21 17:52\n\n- -\n\n创作参数
   *
   * 真正要说的只是「创作中」三个字。状态格取不到时退化为**压平空白后的整行**，至少不带换行。
   *
   * 2026-09-22 改成按表头定位（`statusIdx`），平台加列不会把「端类型」当成状态读出来。
   */
  private async readStatusLabel(row: any, statusIdx = 5): Promise<string> {
    const t = ((await row
      .locator('td')
      .nth(statusIdx)
      .innerText()
      .catch(() => '')) as string)
      .replace(/\s+/g, ' ')
      .trim();
    return t;
  }

  /** 按作品 ID 或唯一作品名定位列表行 */
  private async findWorkRow(ctx: Ctx, ref: { vendorJobId?: string | null; businessName: string }): Promise<any | null> {
    /**
     * 先按平台作品 ID 找，找不到**必须回退作品名**。
     *
     * 平台作品 ID 是从列表里读回来的，读写之间可能对不上（分页、账号内序号变化），
     * 一旦 ID 是错的，只用 ID 定位就会稳定「找不到作品」，把一条正在正常生成的任务
     * 误判成待核对甚至失败。作品名是提交前自己生成的唯一串，更可信。
     */
    const keys = [ref.vendorJobId, ref.businessName].filter((k): k is string => !!k);
    for (const key of keys) {
      for (const sel of SELECTORS.workRow) {
        try {
          const loc = ctx.page.locator(sel).filter({ hasText: key }).first();
          if (await loc.isVisible({ timeout: 4000 })) return loc;
        } catch {
          /* 试下一个候选 */
        }
      }
    }
    return null;
  }

  /**
   * 从作品行里读出成品 mp4 地址。
   *
   * 两条路，按可靠性排序：
   * ① 行内已有 `<video>` / `a[href*=mp4]`（有的列表直接内嵌播放器）；
   * ② 点行内「播放视频」打开播放器，再从 `<video src>` 取 —— 探针实测成品地址只在这时出现
   *    （封面列只是 `?x-oss-process=video/snapshot` 的 jpg，不是成品）。
   */
  private async readAssetUrl(ctx: Ctx, row: any): Promise<string | undefined> {
    const el = row.locator('a[href*=".mp4"], video[src], video source[src]').first();
    const direct =
      (await el.getAttribute('href').catch(() => null)) ?? (await el.getAttribute('src').catch(() => null));
    if (direct) return new URL(direct, cfg.avatar.baseUrl).toString();

    // 走播放器：点开 → 等 <video src> → 关掉
    for (const t of SELECTORS.playButton) {
      const btn = row.locator(`text="${t}"`).first();
      if (!(await btn.isVisible({ timeout: 1200 }).catch(() => false))) continue;
      await btn.click().catch(() => undefined);
      await ctx.page.waitForTimeout(2500);
      const video = ctx.page.locator(SELECTORS.videoEl).first();
      const src =
        (await video.getAttribute('src').catch(() => null)) ?? (await video.getAttribute('currentSrc').catch(() => null));
      await ctx.page.keyboard.press('Escape').catch(() => undefined);
      await ctx.page.waitForTimeout(600);
      if (src) return new URL(src, cfg.avatar.baseUrl).toString();
    }
    return undefined;
  }

  async fetchVideo(ref: { vendorJobId?: string | null; businessName: string }): Promise<AvatarFetchResult> {
    const ctx = await openAvatarBrowser({ headless: cfg.avatar.headless });
    try {
      await ctx.page.goto(this.url(cfg.avatar.worksPath), { waitUntil: 'domcontentloaded' });
      await ctx.page.waitForTimeout(3500);
      if (await detectLoginWall(ctx.page)) {
        throw new AvatarError('AVATAR_NEEDS_LOGIN', '鲲之益会话已失效，取回成品前需重新登录');
      }
      const row = await this.findWorkRow(ctx, ref);
      if (!row) throw new AvatarError('AVATAR_WORK_NOT_FOUND', `作品列表里找不到待下载的成品：${ref.vendorJobId ?? ref.businessName}`);

      const dl = await this.findDownloadInRow(ctx, row);
      if (!dl) {
        // 退而求其次：直接用读到的媒体地址 + 会话 cookie 下载（成品仍会持久化到本地，§7.5）
        const assetUrl = await this.readAssetUrl(ctx, row);
        if (!assetUrl) {
          const p = await shot(ctx.page, 'no-download');
          throw new AvatarError('AVATAR_DOWNLOAD_NOT_FOUND', `列表行里找不到下载入口与媒体地址${p ? `（已截图 ${p}）` : ''}`);
        }
        return this.downloadByUrl(ctx, assetUrl);
      }

      const [download] = await Promise.all([
        ctx.page.waitForEvent('download', { timeout: cfg.avatar.actionTimeoutMs }),
        dl.click(),
      ]);
      fs.mkdirSync(cfg.tmpDir, { recursive: true });
      const dest = path.join(cfg.tmpDir, `avatar-dl-${Date.now()}.mp4`);
      await download.saveAs(dest);
      return { tempPath: dest, message: '已从平台下载成品', sourceUrl: download.url?.() };
    } finally {
      await ctx.close();
    }
  }

  private async findDownloadInRow(ctx: Ctx, row: any): Promise<any | null> {
    for (const t of SELECTORS.downloadButton) {
      try {
        const loc = row.locator(`text="${t}"`).first();
        if (await loc.isVisible({ timeout: 2000 })) return loc;
      } catch {
        /* 试下一个 */
      }
    }
    return null;
  }

  private async downloadByUrl(ctx: Ctx, url: string): Promise<AvatarFetchResult> {
    if (!this.hostAllowed(new URL(url).hostname)) {
      throw new AvatarError(
        'AVATAR_URL_HOST_REJECTED',
        `媒体地址域名不在白名单内：${new URL(url).hostname}。` +
          `若平台换了存储域名（如新的 OSS bucket），请加到 AVATAR_ALLOWED_HOSTS；` +
          `云存储后缀（${MEDIA_HOST_SUFFIXES.join(' / ')}）已默认放行。`,
      );
    }
    const cookies = await ctx.context.cookies(url).catch(() => [] as any[]);
    const cookieHeader = (cookies as any[]).map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(url, {
      headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), referer: cfg.avatar.worksPath },
    });
    if (!res.ok) throw new AvatarError('AVATAR_DOWNLOAD_FAILED', `下载成品失败：HTTP ${res.status}`);
    if (!res.body) throw new AvatarError('AVATAR_DOWNLOAD_FAILED', '下载成品失败：响应没有 body');
    fs.mkdirSync(cfg.tmpDir, { recursive: true });
    const dest = path.join(cfg.tmpDir, `avatar-dl-${Date.now()}.mp4`);
    /**
     * **流式**落盘，不要 `arrayBuffer()`。
     *
     * 2026-09-21 实测：一条 386 字、73 秒的成片是 **243MB**（平台输出约 27Mbps）。
     * 早前这里把整个响应读进内存再写盘，长片会直接把 Node 进程顶上去。
     * Playwright 那条下载分支（`download.saveAs`）本来就是流式的，这里对齐即可。
     */
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest));
    return { tempPath: dest, sourceUrl: url, message: '已按媒体地址下载成品' };
  }

  /**
   * 是否允许从该域名取成品。
   * 精确域名（AVATAR_ALLOWED_HOSTS）+ 云存储后缀（MEDIA_HOST_SUFFIXES）二选一命中即可。
   * 做成后缀匹配的原因见 MEDIA_HOST_SUFFIXES 的注释：成品在阿里云 OSS 上，域名会随 bucket 变。
   */
  private hostAllowed(host: string): boolean {
    if (cfg.avatar.allowedHosts.includes(host)) return true;
    return MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  }
}
