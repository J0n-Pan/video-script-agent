// 数字人视频任务服务（2026-09-20 需求迭代 §7 / §9）。
//
// 职责边界：
// - 只接受**已选定且已保存**的修订作为提交依据（A12）；
// - 提交文本 = 该修订各段正文按序拼接，不含标签、标题、时间码、内部编号（A14）；
// - 一次提交只生成**一整条**口播，不按段拆成多个任务，也不调用平台的 AI 改写（A15）；
// - 长等待不阻塞视频分析队列：本模块只被独立的数字人 worker 调用（A21）；
// - 结果不明一律进「结果待核对」，**绝不自动重新提交**（A16）；
// - 提交方式两种（2026-09-22）：`auto` 全自动、`assist` 人工接手（只预填作品名与文案）。
//
// 关于成品落盘：路径拼装统一走 storage.ts 的 resolveAssetPath()，
// 本模块**不再自己拼一次** —— 以后换保存位置只改那一处。

import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { cfg, ensureDirs } from '../config';
import { probeMedia } from '../ffmpeg';
import { concatSegments } from '../rewrite/validate';
import { AvatarError, AVATAR_STATUS_LABEL, type AvatarAdapter, type AvatarSubmitInput } from './types';
import { MockAvatarAdapter } from './mock';
import { HuweilaiAvatarAdapter } from './huweilai';
import { ensureAssetDir, resolveAssetPath, sha256OfFile } from './storage';

/** 按配置返回适配器；界面与验收脚本无需关心具体实现 */
export function getAvatarAdapter(): AvatarAdapter {
  return cfg.avatar.adapter === 'playwright' ? new HuweilaiAvatarAdapter() : new MockAvatarAdapter();
}

export function avatarAdapterSummary() {
  return {
    mode: cfg.avatar.adapter,
    baseUrl: cfg.avatar.baseUrl,
    avatarName: cfg.avatar.avatarName,
    voiceName: cfg.avatar.voiceName,
    sessionConfigured: fs.existsSync(cfg.avatar.storageState),
    maxTextChars: cfg.avatar.maxTextChars,
    /** auto = 全自动提交；assist = 人工接手（只预填作品名与文案，其余由编导在平台上选） */
    submitMode: cfg.avatar.submitMode,
    /** 成品的本地保存目录（以后换保存路径就是改这一处） */
    videoDir: cfg.avatar.videoDir,
    /**
     * 适配器是否支持「读平台作品列表」。
     *
     * 界面据此决定要不要显示「绑定平台作品」入口：不支持的适配器上显示它，
     * 编导点了只会白报一个错（mock 其实也实现了，所以主要防的是将来换官方 API 的适配器）。
     */
    supportsWorkBinding: typeof getAvatarAdapter().listWorks === 'function',
  };
}

/**
 * 该改写任务下最近一条数字人任务 id（没有则 null）。
 *
 * 界面上「数字人任务」卡片原先只认组件内存里的那个 id —— 点完能看到，
 * 一刷新、一离开页面再回来就整块消失，连「尚未提交 / 待核对」的说明和成品下载都一起没了。
 * 详情接口带上这个 id，界面就能在重新进入时恢复同一条任务的视图（不新建、不重提）。
 */
export async function latestAvatarJobIdForRewriteJob(ownerId: string, rewriteJobId: string): Promise<string | null> {
  const j = await prisma.avatarVideoJob.findFirst({
    where: { ownerId, revision: { variant: { jobId: rewriteJobId } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return j?.id ?? null;
}

export type CreateAvatarJobResult = {
  jobId: string;
  /** true = 同一幂等键的重复请求，直接回放原任务（A16） */
  replayed: boolean;
  status: string;
  businessName: string;
  textSnapshot: string;
  textChars: number;
};

/**
 * 为选定修订创建数字人任务。
 *
 * 幂等键由调用方（前端在**一次点击**时生成）传入；双击或重复请求命中同一键就回放原任务，
 * 不会产生第二个提交任务。没传时退化为「以修订为键」，意味着同一稿件只会有一个任务。
 */
export async function createAvatarJob(opts: {
  ownerId: string;
  revisionId: string;
  idempotencyKey?: string | null;
}): Promise<CreateAvatarJobResult> {
  const rev = await prisma.rewriteRevision.findFirst({
    where: { id: opts.revisionId, variant: { job: { ownerId: opts.ownerId } } },
    include: {
      variant: {
        include: {
          job: { include: { selections: { orderBy: { createdAt: 'desc' }, take: 1 } } },
        },
      },
      segments: { orderBy: { orderIndex: 'asc' } },
    },
  });
  if (!rev) throw new Error('稿件修订不存在或无权访问');
  if (rev.variant.currentRevisionId !== rev.id) throw new Error('只能对当前生效的修订生成视频，请先保存编辑');
  if (rev.segments.length === 0) throw new Error('该修订没有正文，无法生成视频');

  // A12：未选定不能提交。界面左侧可能有未保存的编辑，这里以库里的选定记录为准。
  const sel = rev.variant.job.selections[0];
  if (!sel || sel.revisionId !== rev.id) {
    throw new Error('该稿件尚未选定，不能生成数字人视频。请先在生成页点「选定本版」。');
  }

  const text = concatSegments(rev.segments).trim();
  if (!text) throw new Error('稿件正文为空，无法生成视频');
  // 超出平台上限时提示编导处理，**不自动拆分、不删减文案**（§7.3）
  if (text.length > cfg.avatar.maxTextChars) {
    throw new Error(
      `稿件正文 ${text.length} 字，超过平台单次文本上限 ${cfg.avatar.maxTextChars} 字。` +
        '请编导自行精简文案后重新保存并选定；系统不会自动拆成多个任务或删减正文。',
    );
  }

  const idempotencyKey = opts.idempotencyKey?.trim() || `avatar-rev-${rev.id}`;
  const exists = await prisma.avatarVideoJob.findUnique({ where: { idempotencyKey } });
  if (exists) {
    return {
      jobId: exists.id,
      replayed: true,
      status: exists.status,
      businessName: exists.businessName,
      textSnapshot: exists.textSnapshot,
      textChars: exists.textSnapshot.length,
    };
  }

  /**
   * 同一修订只要还有**在途**任务，就不再建第二条。
   *
   * 幂等键是「每次点击」生成的，所以连点两次会绕过上面那条同键检查 ——
   * 结果是两条任务引用同一份正文，切到真实适配器后**两份都会被提交、重复计费**。
   * 「不自动重提」这条红线原本只守在提交环节，入队这层漏了。
   *
   * 不算在途的三个终态：
   *   · FAILED —— 允许重来；
   *   · SUCCEEDED —— 要重出就得改稿成新修订；
   *   · ASSIST_CANCELLED —— 人工接手没提交（已查过平台确认），当然允许重来。
   *
   * ⚠️ `FETCHING` 必须算在途（2026-09-22 补漏）：取回 243MB 成品要几分钟，
   * 那几分钟里任务不在这个列表里，编导再点一次「生成」就会**再建一条并再提交一次**。
   */
  const inflight = await prisma.avatarVideoJob.findFirst({
    where: {
      ownerId: opts.ownerId,
      rewriteRevisionId: rev.id,
      status: { in: ['QUEUED', 'SUBMITTING', 'VENDOR_RUNNING', 'NEEDS_LOGIN', 'NEEDS_REVIEW', 'FETCHING'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (inflight) {
    return {
      jobId: inflight.id,
      replayed: true,
      status: inflight.status,
      businessName: inflight.businessName,
      textSnapshot: inflight.textSnapshot,
      textChars: inflight.textSnapshot.length,
    };
  }

  // 唯一业务名：平台不可靠地按「作品列表第一条」判断结果时，用它核对（§7.4）
  const businessName =
    `VSA-${rev.id.slice(-6)}-r${rev.revisionNo}-` +
    new Date().toISOString().replace(/[-:TZ.]/g, '').slice(4, 14);

  const params = {
    avatarName: cfg.avatar.avatarName,
    voiceName: cfg.avatar.voiceName,
    language: cfg.avatar.language,
    speed: cfg.avatar.speed,
    volume: cfg.avatar.volume,
    subtitle: cfg.avatar.subtitle,
    bgm: cfg.avatar.bgm,
  };

  const job = await prisma.avatarVideoJob.create({
    data: {
      ownerId: opts.ownerId,
      rewriteRevisionId: rev.id,
      textSnapshot: text,
      paramsSnapshot: JSON.stringify(params),
      idempotencyKey,
      businessName,
      status: 'QUEUED',
    },
  });

  return { jobId: job.id, replayed: false, status: job.status, businessName, textSnapshot: text, textChars: text.length };
}

function paramsOf(raw: string): Pick<AvatarSubmitInput, 'avatarName' | 'voiceName' | 'language' | 'speed' | 'volume' | 'subtitle' | 'bgm'> {
  const d = {
    avatarName: cfg.avatar.avatarName,
    voiceName: cfg.avatar.voiceName,
    language: cfg.avatar.language,
    speed: cfg.avatar.speed,
    volume: cfg.avatar.volume,
    subtitle: cfg.avatar.subtitle,
    bgm: cfg.avatar.bgm,
  };
  try {
    const o = JSON.parse(raw || '{}');
    return { ...d, ...(o && typeof o === 'object' ? o : {}) };
  } catch {
    return d;
  }
}

/** 提交（或推进）一个任务：由数字人 worker 调用 */
export async function advanceAvatarJob(jobId: string): Promise<string> {
  const job = await prisma.avatarVideoJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error('数字人任务不存在');
  // ASSIST_CANCELLED 也是「本轮结束、等人重新发起」的终态，worker 不该再推进它
  if (['SUCCEEDED', 'FAILED', 'ASSIST_CANCELLED'].includes(job.status)) return job.status;

  const adapter = getAvatarAdapter();

  /**
   * 未提交过：先查登录态，登录失效就明确停住，不反复试。
   *
   * `!job.submittedAt` 这一条是**防重复提交的红线**：`submittedAt` 在真正点提交前置位，
   * 代表「我们已经尝试过提交」。缺了它会出现这种情况 —— 提交成功但没读回平台 ID，
   * 之后平台会话过期让状态变成 NEEDS_LOGIN、而 vendorJobId 仍是空，
   * 于是下一次轮询会**再提交一遍**，同一份稿件出两条片、重复计费。
   * 已尝试过的任务一律只走查询，不回到提交分支。
   */
  if (!job.vendorJobId && !job.submittedAt && ['QUEUED', 'NEEDS_LOGIN'].includes(job.status)) {
    const login = await adapter.checkLogin();
    if (!login.ok) {
      await prisma.avatarVideoJob.update({
        where: { id: job.id },
        data: { status: 'NEEDS_LOGIN', errorCode: 'AVATAR_NEEDS_LOGIN', errorMessage: login.message },
      });
      return 'NEEDS_LOGIN';
    }

    await prisma.avatarVideoJob.update({
      where: { id: job.id },
      data: { status: 'SUBMITTING', attemptCount: { increment: 1 }, submittedAt: new Date() },
    });

    try {
      const input: AvatarSubmitInput = {
        text: job.textSnapshot,
        businessName: job.businessName,
        ...paramsOf(job.paramsSnapshot),
        // 划时间线用：回查作品列表时要能分清「本次提交之后新建的作品」和别的历史作品
        attemptedAtMs: Date.now(),
      };

      /**
       * 人工接手（`AVATAR_SUBMIT_MODE=assist`）：只预填作品名与文案，形象/参数由编导在平台上自己选。
       *
       * 三种结局：
       *   · submitted → 平台生成中；
       *   · cancelled → 退回「人工接手已取消」，并且**清空 submittedAt**；
       *   · uncertain → 会话失效查不了列表，**或者**按作品名查不到但时间线上有可疑新作品
       *     （多半是我们的作品被改了名），按「结果待核对」。
       *
       * 为什么 cancelled 敢清 `submittedAt`（自动提交时绝对不敢）：那个红线是为了防「提交成功却
       * 读不回 ID → 会话过期 → 再提一遍」。而这里「没查到作品名」是**查过之后**的结论，确实没提交，
       * 不清掉的话编导再点一次也永远不会提交 —— 那就变成了「防重复提交」反过来堵死了正常重来。
       *
       * ⚠️ 但正因为它会清 submittedAt，判据必须保守（2026-09-22 事故）：编导在平台上把作品改名后，
       * 唯一作品名永久失效，一条**已经出片成功**的任务被判成「确定没提交」，submittedAt 被清空 ——
       * 方向完全反了。现在适配器多了一道时间线判据：只要列表里有「本次提交之后新建的作品」，
       * 就退回 `uncertain`（待核对），绝不下 `cancelled`。待核对不算终态、仍算在途，
       * 所以既不会重复提交，也可以在界面上用「绑定平台作品」把它接回来。
       */
      if (cfg.avatar.submitMode === 'assist' && adapter.assistSubmit) {
        const a = await adapter.assistSubmit(input);

        if (a.kind === 'cancelled') {
          await prisma.avatarVideoJob.update({
            where: { id: job.id },
            data: {
              status: 'ASSIST_CANCELLED',
              vendorJobId: null,
              submittedAt: null,
              attemptCount: 0,
              errorCode: 'AVATAR_ASSIST_CANCELLED',
              errorMessage: a.message.slice(0, 900),
              reconcileNote: '',
            },
          });
          return 'ASSIST_CANCELLED';
        }

        if (a.kind === 'uncertain') {
          await prisma.avatarVideoJob.update({
            where: { id: job.id },
            data: {
              status: 'NEEDS_REVIEW',
              errorCode: 'AVATAR_SUBMIT_UNCERTAIN',
              errorMessage: a.message.slice(0, 900),
              reconcileNote: a.message.slice(0, 500),
            },
          });
          return 'NEEDS_REVIEW';
        }

        await prisma.avatarVideoJob.update({
          where: { id: job.id },
          data: {
            status: 'VENDOR_RUNNING',
            vendorJobId: a.vendorJobId ?? null,
            errorCode: null,
            errorMessage: null,
            reconcileNote: a.vendorJobId ? '' : '已确认提交（按唯一作品名在作品列表中查到），暂未读回平台作品 ID',
          },
        });
        return 'VENDOR_RUNNING';
      }

      const sub = await adapter.submit(input);

      /**
       * 「不确定」与「没读回 ID」是两件事，不能混为一谈（2026-09-21 真实提交实测）。
       *
       * 旧写法是 `sub.uncertain || !sub.vendorJobId` —— 只要没拿到平台作品 ID 就判「结果待核对」。
       * 而平台提交成功后会整页跳转、URL 不带 id、响应也不是 JSON，于是**已经成功的提交**被判成
       * 「结果不明」，编导以为没提交，其实平台已经在「创作中」了。
       *
       * 现在：适配器只有在**查过作品列表也没找到自己的作品名**时才敢报 uncertain；
       * 明确「已提交但没读回 ID」的，按「平台生成中」推进即可 —— 后续查询按唯一作品名定位，
       * 不依赖那个 ID（见 huweilai.query / findWorkRow）。
       */
      if (sub.uncertain) {
        await prisma.avatarVideoJob.update({
          where: { id: job.id },
          data: {
            status: 'NEEDS_REVIEW',
            errorCode: 'AVATAR_SUBMIT_UNCERTAIN',
            errorMessage: sub.message.slice(0, 900),
            reconcileNote: sub.message.slice(0, 500),
          },
        });
        return 'NEEDS_REVIEW';
      }

      await prisma.avatarVideoJob.update({
        where: { id: job.id },
        data: {
          status: 'VENDOR_RUNNING',
          vendorJobId: sub.vendorJobId ?? null,
          errorCode: null,
          errorMessage: null,
          reconcileNote: sub.vendorJobId ? '' : '已确认提交（按唯一作品名在作品列表中查到），暂未读回平台作品 ID',
        },
      });
      return 'VENDOR_RUNNING';
    } catch (e) {
      const isAvatar = e instanceof AvatarError;
      const msg = e instanceof Error ? e.message : String(e);
      const uncertain = isAvatar && e.uncertain;
      const status = isAvatar && e.code === 'AVATAR_NEEDS_LOGIN' ? 'NEEDS_LOGIN' : uncertain ? 'NEEDS_REVIEW' : 'FAILED';
      await prisma.avatarVideoJob.update({
        where: { id: job.id },
        data: {
          status,
          errorCode: isAvatar ? e.code : 'AVATAR_SUBMIT_FAILED',
          errorMessage: msg.slice(0, 900),
          reconcileNote: uncertain ? msg.slice(0, 500) : '',
        },
      });
      return status;
    }
  }

  // 已提交：查询平台状态
  const q = await adapter.query({ vendorJobId: job.vendorJobId, businessName: job.businessName });
  switch (q.status) {
    case 'RUNNING':
      await prisma.avatarVideoJob.update({
        where: { id: job.id },
        data: {
          status: 'VENDOR_RUNNING',
          // 平台作品 ID 能读到就补上（提交时因页面跳转没捞到的，靠这里补）
          vendorJobId: q.vendorJobId ?? job.vendorJobId,
          reconcileNote: (q.progress ?? '').slice(0, 500),
        },
      });
      return 'VENDOR_RUNNING';
    case 'NEEDS_LOGIN':
      await prisma.avatarVideoJob.update({
        where: { id: job.id },
        data: { status: 'NEEDS_LOGIN', errorCode: 'AVATAR_NEEDS_LOGIN', errorMessage: q.message.slice(0, 900) },
      });
      return 'NEEDS_LOGIN';
    case 'FAILED':
      await prisma.avatarVideoJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          vendorJobId: q.vendorJobId ?? job.vendorJobId,
          errorCode: 'AVATAR_VENDOR_FAILED',
          errorMessage: q.message.slice(0, 900),
          // 终态：清掉平台进度说明，否则卡片上会同时出现「创作中」和「生成失败」两个矛盾说法
          reconcileNote: '',
          finishedAt: new Date(),
        },
      });
      return 'FAILED';
    case 'NOT_FOUND':
    case 'NEEDS_REVIEW':
      await prisma.avatarVideoJob.update({
        where: { id: job.id },
        data: { status: 'NEEDS_REVIEW', reconcileNote: q.message.slice(0, 500) },
      });
      return 'NEEDS_REVIEW';
    case 'SUCCEEDED':
      await fetchAndStore(job.id);
      return 'SUCCEEDED';
    default:
      return job.status;
  }
}

/** 取回成品 → 持久化 → 媒体校验 → 落 GeneratedVideoAsset */
async function fetchAndStore(jobId: string): Promise<void> {
  const job = await prisma.avatarVideoJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error('数字人任务不存在');
  if (job.status === 'SUCCEEDED') return;

  const adapter = getAvatarAdapter();
  await prisma.avatarVideoJob.update({ where: { id: job.id }, data: { status: 'FETCHING' } });

  try {
    const f = await adapter.fetchVideo({ vendorJobId: job.vendorJobId, businessName: job.businessName });
    if (!f.tempPath) {
      await prisma.avatarVideoJob.update({
        where: { id: job.id },
        data: { status: 'NEEDS_REVIEW', reconcileNote: f.message.slice(0, 500) },
      });
      return;
    }

    ensureDirs();
    ensureAssetDir();
    // 落盘路径统一由 storage.ts 决定 —— 以后换「本地保存路径」只改那一处
    const dest = resolveAssetPath(job.businessName);
    fs.copyFileSync(f.tempPath, dest);
    try {
      fs.unlinkSync(f.tempPath);
    } catch {
      /* 临时文件清理失败不影响结果 */
    }

    // 成品必须真的能读、有时长、有音轨（§7.5）；校验不过就不算成功
    const probe = await probeMedia(dest);
    /**
     * 体积与 sha256 都**不要**先把文件读进内存。
     * 实测一条 73 秒的成片 243MB，readFileSync + 下载端的 arrayBuffer 会让峰值逼近 500MB。
     */
    const sizeBytes = BigInt(fs.statSync(dest).size);
    const sha256 = await sha256OfFile(dest);

    await prisma.generatedVideoAsset.create({
      data: {
        avatarVideoJobId: job.id,
        filePath: dest,
        fileName: path.basename(dest),
        durationMs: probe.durationMs,
        sizeBytes,
        sha256,
        width: probe.width ?? null,
        height: probe.height ?? null,
        hasAudio: probe.hasAudio,
        status: 'READY',
      },
    });

    await prisma.avatarVideoJob.update({
      where: { id: job.id },
      data: {
        status: 'SUCCEEDED',
        vendorAssetUrl: f.sourceUrl ?? job.vendorAssetUrl,
        errorCode: null,
        errorMessage: null,
        // 终态：平台进度说明已完成使命，留着会和「已完成」互相矛盾
        reconcileNote: '',
        finishedAt: new Date(),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.avatarVideoJob.update({
      where: { id: job.id },
      data: { status: 'NEEDS_REVIEW', errorCode: 'AVATAR_FETCH_FAILED', errorMessage: msg.slice(0, 900) },
    });
  }
}

/**
 * 重新核对平台记录（§9）。
 * **不等同于重新提交**：只查平台现状并据此推进状态；查到已完成就取回成品。
 * 这样「提交结果不明」的任务有正规出路，而不会因为重试造成重复计费。
 */
export async function reconcileAvatarJob(ownerId: string, jobId: string) {
  const job = await prisma.avatarVideoJob.findFirst({ where: { id: jobId, ownerId } });
  if (!job) throw new Error('数字人任务不存在或无权访问');
  if (job.status === 'SUCCEEDED') {
    return { status: job.status, message: '任务已完成，无需核对' };
  }

  /**
   * 人工接手取消（assist 模式）：**确定没提交过**，不需要也不应该去核对。
   *
   * 判据是「按唯一作品名查过平台作品列表、没查到」，是查完之后的结论，不是猜的。
   * 这一道必须挡在下面「从未提交」之前 —— 那条分支的文案是「请确认数字人解析进程在运行」，
   * 而这条任务的进程好得很，真因是编导没在平台窗口里点「生成视频」。答错方向比不答更糟。
   */
  if (job.status === 'ASSIST_CANCELLED') {
    return {
      status: job.status,
      notSubmitted: true,
      cancelled: true,
      message:
        '该任务为人工接手模式、未完成提交（已核对平台作品列表，确认没有这条作品名），无需再核对。' +
        '如需出片，请重新点「生成数字人视频」再次发起。',
    };
  }

  /**
   * 从未提交过（没有平台作品 ID、且一次提交都没尝试过）：**不能拿「查不到」当结论**。
   *
   * 平台侧当然查不到 —— 因为压根没提交过。旧代码会把这个 NOT_FOUND 写成
   * 「结果待核对 / 找不到对应作品记录」，用户看到后去平台翻记录、越看越糊涂，
   * 而真实原因是数字人 worker 没在跑、任务还排在队里（2026-09-21 实测踩到）。
   *
   * 顺带把「从未提交却被标成待核对」的脏状态修回排队中：没有平台记录可核对，
   * 停在待核对只会挡住正常提交。
   */
  if (!job.vendorJobId && job.attemptCount === 0) {
    if (job.status === 'NEEDS_LOGIN') {
      return {
        status: job.status,
        notSubmitted: true,
        message:
          '该任务尚未提交：平台会话已失效，先执行 npm run avatar:login 扫码登录，' +
          '数字人解析进程会在会话恢复后重新提交。',
      };
    }

    const repairable = job.status === 'NEEDS_REVIEW';
    if (repairable) {
      await prisma.avatarVideoJob.update({
        where: { id: job.id },
        data: { status: 'QUEUED', errorCode: null, errorMessage: null, reconcileNote: '', finishedAt: null },
      });
    }
    return {
      status: repairable ? 'QUEUED' : job.status,
      notSubmitted: true,
      repaired: repairable,
      message: repairable
        ? '该任务从未提交到平台（原先的「待核对」结论无效，已改回排队中）。' +
          '请确认数字人解析进程在运行：npm run worker:avatar。'
        : '该任务还没有提交到平台，因此无法核对平台记录。它正排在数字人队列里等待处理 —— ' +
          '请确认已启动数字人解析进程（npm run worker:avatar）。',
    };
  }

  const adapter = getAvatarAdapter();
  const q = await adapter.query({ vendorJobId: job.vendorJobId, businessName: job.businessName });

  if (q.status === 'SUCCEEDED') {
    await prisma.avatarVideoJob.update({
      where: { id: job.id },
      data: { vendorJobId: q.vendorJobId ?? job.vendorJobId, vendorAssetUrl: q.assetUrl ?? job.vendorAssetUrl },
    });
    await fetchAndStore(job.id);
    const after = await prisma.avatarVideoJob.findUnique({ where: { id: job.id } });
    return { status: after?.status ?? 'UNKNOWN', message: '平台已完成，已取回成品' };
  }

  const mapping: Record<string, string> = {
    RUNNING: 'VENDOR_RUNNING',
    FAILED: 'FAILED',
    NOT_FOUND: 'NEEDS_REVIEW',
    NEEDS_LOGIN: 'NEEDS_LOGIN',
    NEEDS_REVIEW: 'NEEDS_REVIEW',
  };
  const next = mapping[q.status] ?? 'NEEDS_REVIEW';
  await prisma.avatarVideoJob.update({
    where: { id: job.id },
    data: {
      status: next,
      vendorJobId: q.vendorJobId ?? job.vendorJobId,
      // 终态（失败）不留「待核对说明」：它是给人工介入看的，失败了就该由 errorMessage 说话
      reconcileNote: next === 'FAILED' ? '' : (q.progress ?? q.message).slice(0, 500),
      errorCode: next === 'FAILED' ? 'AVATAR_VENDOR_FAILED' : job.errorCode,
      errorMessage: next === 'FAILED' ? q.message.slice(0, 900) : job.errorMessage,
      finishedAt: next === 'FAILED' ? new Date() : job.finishedAt,
    },
  });
  return { status: next, message: q.message };
}

/**
 * 只读平台作品列表（最近的在前）。
 *
 * 给两个场景用：界面上的「绑定平台作品」让编导点选，以及排查时看「平台上到底有哪些作品」。
 * 会话失效时适配器会直接抛错 —— **不返回空数组**，否则界面会显示成「这个账号没有作品」。
 */
export async function listPlatformWorks(limit = 20) {
  const adapter = getAvatarAdapter();
  if (!adapter.listWorks) throw new Error('当前适配器不支持读取平台作品列表');
  const works = await adapter.listWorks(Math.max(1, Math.min(limit, 50)));
  return { works, adapter: avatarAdapterSummary() };
}

/** 允许绑定平台作品的任务状态（`SUCCEEDED` / 已有 ID / 正在提交或取回的一律不允许） */
const BINDABLE_STATUS = ['QUEUED', 'NEEDS_LOGIN', 'NEEDS_REVIEW', 'ASSIST_CANCELLED', 'FAILED', 'VENDOR_RUNNING'];

/**
 * 把平台上的某条作品**绑定**到工作台的任务上 —— 作品被改名之后的正规出路。
 *
 * 为什么需要它（2026-09-22 实际事故）：对账的唯一判据曾经是「作品列表里有没有我们生成的
 * 唯一作品名」，而编导完全有理由在平台上改名（比如把测试片标成「信息流编导工作台测试_1」）。
 * 名字一改，我们手里就再也没有能认出那条作品的东西了 —— 但**平台作品 ID 没变**。
 * 这个动作就是让编导把「平台作品 ID」补给任务，之后所有查询、取回都按 ID 走，改名不再有影响。
 *
 * 刻意**不做自动绑定**：靠「时间线上最近的一条」自动认领，万一认错就是把别人的作品当成品交付，
 * 而且错得无声无息。所以只给「疑似目标」，由人来点这一下。
 */
export async function bindAvatarJobWork(
  ownerId: string,
  jobId: string,
  ref: { workId?: string | null; workName?: string | null },
) {
  const job = await prisma.avatarVideoJob.findFirst({ where: { id: jobId, ownerId } });
  if (!job) throw new Error('数字人任务不存在或无权访问');
  if (job.status === 'SUCCEEDED') throw new Error('该任务已完成，无需绑定平台作品');
  if (job.vendorJobId) {
    throw new Error(`该任务已关联平台作品 ID ${job.vendorJobId}，无需重复绑定（如需改绑请先说明原因）`);
  }
  if (!BINDABLE_STATUS.includes(job.status)) {
    throw new Error(`当前状态「${AVATAR_STATUS_LABEL[job.status] ?? job.status}」正在提交或取回过程中，请等它跑完再绑定`);
  }

  const adapter = getAvatarAdapter();
  if (!adapter.listWorks) throw new Error('当前适配器不支持读取平台作品列表，无法绑定');

  const key = (ref.workId ?? ref.workName ?? '').trim();
  if (!key) throw new Error('请填写平台作品 ID 或平台作品名');

  const works = await adapter.listWorks(50);
  const hit =
    works.find((w) => ref.workId && w.vendorJobId === String(ref.workId).trim()) ??
    works.find((w) => w.name.includes(key));
  if (!hit) {
    throw new Error(
      `平台作品列表里找不到「${key}」（已查最近 ${works.length} 条）。` +
        '请确认作品 ID 是否正确，或改用作品名搜索。',
    );
  }
  if (!hit.vendorJobId) {
    throw new Error(`作品「${hit.name}」没读到平台作品 ID，无法按 ID 跟踪，请改填作品 ID`);
  }

  const updated = await prisma.avatarVideoJob.update({
    where: { id: job.id },
    data: {
      vendorJobId: hit.vendorJobId,
      status: 'VENDOR_RUNNING',
      // 绑定意味着「确实提交过」：补回提交痕迹，挡住「从未提交」那条分支，也避免被当成可随意重来的任务
      submittedAt: job.submittedAt ?? new Date(),
      attemptCount: job.attemptCount > 0 ? job.attemptCount : 1,
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
      reconcileNote:
        `已绑定平台作品 ${hit.vendorJobId}「${hit.name}」` +
        `${hit.status ? `（平台状态 ${hit.status}）` : ''}；本任务原唯一作品名 ${job.businessName}` +
        `${hit.submittedAt ? `，平台提交时间 ${hit.submittedAt}` : ''}`,
    },
  });

  return {
    id: updated.id,
    status: updated.status,
    vendorJobId: updated.vendorJobId,
    workName: hit.name,
    workStatus: hit.status,
    note: updated.reconcileNote,
    message: `已绑定平台作品 ${hit.vendorJobId}「${hit.name}」。数字人进程会按平台作品 ID 继续跟踪并在完成时取回成品。`,
  };
}

/** 任务详情（含成品） */
export async function getAvatarJob(ownerId: string, jobId: string) {
  const job = await prisma.avatarVideoJob.findFirst({
    where: { id: jobId, ownerId },
    include: { assets: { orderBy: { createdAt: 'desc' } }, revision: { include: { variant: { select: { variantNo: true, jobId: true } } } } },
  });
  if (!job) return null;
  const asset = job.assets[0];
  return {
    id: job.id,
    status: job.status,
    businessName: job.businessName,
    vendorJobId: job.vendorJobId,
    vendorAssetUrl: job.vendorAssetUrl,
    textChars: job.textSnapshot.length,
    /**
     * 提交给平台的**完整**文案。
     * 原先只回 120 字预览，界面上那行「N 字（各段正文按序拼接，不含标签与标题）」既啰嗦又看不到原文 ——
     * 编导要核对「送出去的到底是什么」只能靠猜。现在直接给全文，界面照原样展示（含换行）。
     */
    text: job.textSnapshot,
    params: paramsOf(job.paramsSnapshot),
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    reconcileNote: job.reconcileNote,
    attemptCount: job.attemptCount,
    submittedAt: job.submittedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    source: job.revision
      ? { revisionId: job.rewriteRevisionId, revisionNo: job.revision.revisionNo, variantNo: job.revision.variant.variantNo, rewriteJobId: job.revision.variant.jobId }
      : null,
    // 来源被删除后任务与成品仍可查看（A22）
    revisionMissing: !job.revision,
    asset: asset
      ? {
          id: asset.id,
          fileName: asset.fileName,
          durationMs: asset.durationMs,
          sizeBytes: Number(asset.sizeBytes),
          width: asset.width,
          height: asset.height,
          hasAudio: asset.hasAudio,
          status: asset.status,
          downloadUrl: `/api/avatar-jobs/${job.id}/video`,
        }
      : null,
  };
}

/** 某稿件修订下的数字人任务（生成页用来显示「已提交过」） */
export async function listAvatarJobsForRevision(ownerId: string, revisionId: string) {
  const rows = await prisma.avatarVideoJob.findMany({
    where: { ownerId, rewriteRevisionId: revisionId },
    orderBy: { createdAt: 'desc' },
    include: { assets: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  return rows.map((j) => ({
    id: j.id,
    status: j.status,
    businessName: j.businessName,
    createdAt: j.createdAt,
    hasAsset: j.assets.length > 0,
  }));
}
