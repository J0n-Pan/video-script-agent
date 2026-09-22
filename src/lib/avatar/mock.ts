// Mock 数字人适配器（2026-09-20）。
//
// 用途：官方 API 未确认、真实账号尚未联调时，让**整条业务链路**（接口、队列、状态迁移、
// 成品持久化、鉴权、幂等、验收脚本）都能完整跑通。它不是「假装成功」——
// 它会真的产出一个可探测的 mp4 成品，也会按规则触发失败/待登录/结果待核对分支。
//
// 分支触发方式（写在作品名里，便于在页面与脚本里显式构造场景）：
//   [needs-login]    → 会话失效
//   [uncertain]      → 提交结果不明（验证「不自动重提、进入待核对」）
//   [no-id]          → 提交**成功**但读不回平台作品 ID（真实平台跳转丢参数时的形状）
//   [fail]           → 提交被受理，但**生成阶段失败**（推荐用于验证失败终态与错误呈现）
//   [slow]           → 多轮查询后才完成（验证等待与轮询）
// 人工接手（AVATAR_SUBMIT_MODE=assist）专用：
//   [assist-cancel]  → 编导没提交就关掉了窗口（**不落提交记录**，复现「确定没提交」这个形状）
//   [assist-uncertain] → 结束后会话失效，查不了作品列表
//   [assist-renamed] → 提交成功但**平台侧被改了名**（复现 2026-09-22 事故：按作品名对账失效）
// 提交记录会落盘 data/tmp/avatar-mock-submissions.json，验收脚本据此断言提交文本（A14）。

import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import {
  AvatarError,
  type AvatarAdapter,
  type AvatarAssistResult,
  type AvatarFetchResult,
  type AvatarQueryResult,
  type AvatarSubmitInput,
  type AvatarSubmitResult,
  type AvatarWorkRow,
} from './types';

const SUBMIT_LOG = () => path.join(cfg.tmpDir, 'avatar-mock-submissions.json');
const MOCK_SOURCE = () => path.join(process.cwd(), 'data', 'test-media', 'speech-full.mp4');

type MockRecord = {
  vendorJobId: string;
  businessName: string;
  submittedAt: string;
  text: string;
  params: Omit<AvatarSubmitInput, 'text'>;
  /** 查询次数：用于模拟「先 RUNNING 后 SUCCEEDED」 */
  polls: number;
};

function readLog(): MockRecord[] {
  try {
    const p = SUBMIT_LOG();
    if (!fs.existsSync(p)) return [];
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(o) ? o : [];
  } catch {
    return [];
  }
}

function writeLog(rows: MockRecord[]): void {
  fs.mkdirSync(path.dirname(SUBMIT_LOG()), { recursive: true });
  fs.writeFileSync(SUBMIT_LOG(), JSON.stringify(rows, null, 2), 'utf8');
}

/** 验收脚本用：读回 mock 提交记录，断言提交文本等于选定正文按序拼接 */
export function readMockSubmissions(): MockRecord[] {
  return readLog();
}

const flag = (name: string, tag: string) => name.includes(tag);

/**
 * 平台侧被改名后的作品名（`[assist-renamed]` 场景）。
 *
 * 刻意**不带**我们的唯一作品名：这正是事故的形状 —— 编导在平台上改成一个跟我们对不上的名字，
 * 于是「按唯一作品名对账」必然落空，只有平台作品 ID 还能认出它。
 */
const RENAMED_WORK_NAME = '信息流编导工作台测试_1_99999';

/** 提交记录 → 平台作品列表行（给 listWorks 用） */
function toWorkRow(r: MockRecord): AvatarWorkRow {
  const failed = flag(r.businessName, '[fail]');
  const need = flag(r.businessName, '[slow]') ? 3 : 2;
  const status = failed ? '创作失败' : r.polls < need ? '创作中' : '创作完成';
  const d = new Date(r.submittedAt);
  const pad = (v: number) => String(v).padStart(2, '0');
  const submittedAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { vendorJobId: r.vendorJobId, name: r.businessName, status, submittedAt, submittedAtMs: d.getTime() };
}

export class MockAvatarAdapter implements AvatarAdapter {
  readonly mode = 'mock' as const;

  async checkLogin() {
    return { ok: true, message: 'Mock 模式：跳过真实会话检查' };
  }

  async resolveAssets() {
    const avatarName = cfg.avatar.avatarName;
    const voiceName = cfg.avatar.voiceName;
    return {
      avatar: { name: avatarName, matched: 1, raw: `${avatarName}（Mock）` },
      voice: { name: voiceName, matched: 1, raw: `${voiceName}（Mock）` },
      message: 'Mock 模式：默认形象与音色按配置唯一匹配',
    };
  }

  /**
   * Mock 预检：与 Playwright 适配器同一个语义（只填不提交），但没有任何真实页面可填，
   * 所以按提交分支标记模拟「预检能否通过」。用途是让验收脚本在 mock 模式下也能覆盖
   * 「预检失败 → 编导能看到是哪一步」这条路径。
   */
  async preflight(input: AvatarSubmitInput) {
    if (flag(input.businessName, '[needs-login]')) {
      return {
        ok: false,
        steps: [{ name: '检查登录', ok: false, detail: 'Mock：会话已失效' }],
        submitEnabled: false,
        message: 'Mock：预检失败，会话已失效（未提交）',
      };
    }
    const steps = [
      { name: '打开创建页并确认登录', ok: true, detail: 'ok（Mock）' },
      { name: `填入文本（${input.text.length} 字）`, ok: true, detail: 'ok（Mock）' },
      { name: `选择形象「${input.avatarName}」`, ok: true, detail: 'ok（Mock）' },
      { name: `选择音色「${input.voiceName}」`, ok: true, detail: 'ok（Mock）' },
      { name: '提交按钮可用', ok: true, detail: '可提交（Mock）' },
    ];
    return { ok: true, steps, submitEnabled: true, message: 'Mock：预检通过（未提交）' };
  }

  async submit(input: AvatarSubmitInput): Promise<AvatarSubmitResult> {
    if (flag(input.businessName, '[needs-login]')) {
      throw new AvatarError('AVATAR_NEEDS_LOGIN', 'Mock：会话已失效，请扫码登录后再提交');
    }
    if (flag(input.businessName, '[uncertain]')) {
      return { message: 'Mock：提交结果不明（用于验证「不自动重提、进入待核对」）', uncertain: true };
    }
    if (flag(input.businessName, '[no-id]')) {
      /**
       * 复现真实平台的形状：**提交确实成功了，但没读回平台作品 ID**。
       *
       * 2026-09-21 真实提交实测：点提交后整页跳转到作品页、URL 不带 id、响应体也不是 JSON，
       * 于是「拿不到 ID」。作品其实已经在平台里「创作中」。
       * 这里作品照常落盘（平台侧确实建了），但**不返回** id —— 调用方只能靠唯一作品名去查。
       */
      const vendorJobId = `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const rows = readLog();
      rows.unshift({
        vendorJobId,
        businessName: input.businessName,
        submittedAt: new Date().toISOString(),
        text: input.text,
        params: { ...input, text: undefined as unknown as string } as Omit<AvatarSubmitInput, 'text'>,
        polls: 0,
      });
      writeLog(rows.slice(0, 100));
      return { message: 'Mock：已提交（按唯一作品名在作品列表中确认），暂未读回平台作品 ID' };
    }
    const vendorJobId = `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const rows = readLog();
    rows.unshift({
      vendorJobId,
      businessName: input.businessName,
      submittedAt: new Date().toISOString(),
      text: input.text,
      params: { ...input, text: undefined as unknown as string } as Omit<AvatarSubmitInput, 'text'>,
      polls: 0,
    });
    writeLog(rows.slice(0, 100));
    /**
     * `[fail]` 与其它分支一样**先落盘再返回**：平台是「受理了提交、生成阶段才失败」，
     * 不是「提交就被拒」。2026-09-21 真实平台实测正是这个形状（提交成功 → 长时间创作中 → 创作失败），
     * 所以这里要能完整复现 VENDOR_RUNNING → FAILED 这条路，否则失败分支的回归是假的。
     */
    return { vendorJobId, message: flag(input.businessName, '[fail]') ? 'Mock：已提交（生成阶段将失败）' : 'Mock：已提交' };
  }

  /**
   * 人工接手（`AVATAR_SUBMIT_MODE=assist`）的 mock。
   *
   * 关键点是 `[assist-cancel]` **不落提交记录** —— 真实适配器判「取消」的依据正是
   * 「作品列表里查不到我们的唯一作品名」，所以 mock 必须同样不留下作品，
   * 否则「取消之后确实没提交、可以重来」这条断言就是假通过。
   */
  async assistSubmit(input: AvatarSubmitInput): Promise<AvatarAssistResult> {
    if (flag(input.businessName, '[assist-cancel]')) {
      return {
        kind: 'cancelled',
        reason: 'closed',
        message: `Mock：人工接手未完成（协助窗口被关闭），且作品列表里查不到「${input.businessName}」—— 确定没有提交过`,
      };
    }
    if (flag(input.businessName, '[assist-uncertain]')) {
      return { kind: 'uncertain', message: 'Mock：人工接手已结束，但平台会话失效，无法确认是否已提交' };
    }
    /**
     * `[assist-renamed]`：复现 2026-09-22 的事故形状 ——
     * 提交**成功**，但编导立刻在平台上把作品改了名，于是「按唯一作品名对账」查不到。
     *
     * 这里刻意落一条**改了名**的作品记录：真适配器正是靠「列表里存在本次提交之后新建的作品」
     * 这条时间线判据，才没有把「已出片」误判成「确定没提交」。mock 必须同样造出这条记录，
     * 否则那条判据的回归是假通过。
     */
    if (flag(input.businessName, '[assist-renamed]')) {
      const vendorJobId = `mock-renamed-${Date.now().toString(36)}`;
      const rows = readLog();
      rows.unshift({
        vendorJobId,
        businessName: RENAMED_WORK_NAME,
        submittedAt: new Date().toISOString(),
        text: input.text,
        params: { ...input, text: undefined as unknown as string } as Omit<AvatarSubmitInput, 'text'>,
        polls: 0,
      });
      writeLog(rows.slice(0, 100));
      return {
        kind: 'uncertain',
        vendorJobId,
        message:
          `Mock：人工接手已结束（协助窗口被关闭）。作品列表里查不到「${input.businessName}」，` +
          `但发现 1 条在本次提交时间之后创建的作品 —— 最新一条：平台作品 ID ${vendorJobId}「${RENAMED_WORK_NAME}」（创作中）。` +
          '很可能是我们的作品在平台上被改过名，因此不能断定没提交：按「结果待核对」处理，' +
          '不会自动重复提交。可在工作台用「绑定平台作品」把这条作品接回本任务。',
      };
    }
    const vendorJobId = `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const rows = readLog();
    rows.unshift({
      vendorJobId,
      businessName: input.businessName,
      submittedAt: new Date().toISOString(),
      text: input.text,
      params: { ...input, text: undefined as unknown as string } as Omit<AvatarSubmitInput, 'text'>,
      polls: 0,
    });
    writeLog(rows.slice(0, 100));
    return { kind: 'submitted', vendorJobId, message: `Mock：人工接手已确认提交，平台作品 ID：${vendorJobId}` };
  }

  async query(ref: { vendorJobId?: string | null; businessName: string }): Promise<AvatarQueryResult> {
    const rows = readLog();
    const hit = rows.find((r) =>
      ref.vendorJobId ? r.vendorJobId === ref.vendorJobId : r.businessName === ref.businessName,
    );
    if (!hit) return { status: 'NOT_FOUND', message: 'Mock：找不到对应作品记录' };

    hit.polls += 1;
    writeLog(rows);

    if (flag(hit.businessName, '[needs-login]')) {
      return { status: 'NEEDS_LOGIN', message: 'Mock：会话已失效' };
    }
    if (flag(hit.businessName, '[fail]')) {
      return { status: 'FAILED', vendorJobId: hit.vendorJobId, message: 'Mock：平台生成失败' };
    }
    // [slow] 需要 3 轮查询；其余 2 轮即可完成 —— 覆盖「等待中」到「完成」的状态迁移
    const need = flag(hit.businessName, '[slow]') ? 3 : 2;
    if (hit.polls < need) {
      return {
        status: 'RUNNING',
        vendorJobId: hit.vendorJobId,
        progress: `Mock 生成中（第 ${hit.polls}/${need} 次查询）`,
        message: 'Mock：平台生成中',
      };
    }
    return {
      status: 'SUCCEEDED',
      vendorJobId: hit.vendorJobId,
      assetUrl: `mock://avatar/${hit.vendorJobId}.mp4`,
      message: 'Mock：已完成',
    };
  }

  /**
   * 只读平台作品列表（mock 版）：直接由提交记录映射而来。
   *
   * 注意 `[assist-renamed]` 场景下记录里的名字是**改名后**的，所以按我们的唯一作品名
   * 在列表里找是找不到的 —— 与真实平台一致。绑定/对账只能走平台作品 ID。
   */
  async listWorks(limit = 20): Promise<AvatarWorkRow[]> {
    return readLog()
      .slice(0, limit)
      .map(toWorkRow);
  }

  async fetchVideo(ref: { vendorJobId?: string | null; businessName: string }): Promise<AvatarFetchResult> {
    const src = MOCK_SOURCE();
    if (!fs.existsSync(src)) {
      throw new AvatarError('AVATAR_MOCK_SOURCE_MISSING', `Mock 成品素材不存在：${src}`);
    }
    fs.mkdirSync(cfg.tmpDir, { recursive: true });
    const dest = path.join(cfg.tmpDir, `avatar-mock-${Date.now()}.mp4`);
    fs.copyFileSync(src, dest);
    return { tempPath: dest, sourceUrl: `mock://avatar/${ref.vendorJobId ?? ref.businessName}.mp4`, message: 'Mock：已取回成品' };
  }
}
