/**
 * 安装后初始化（由安装器在安装结束时调用一次，编导看不到任何输出）。
 *
 * 做四件事，全部自动生成、编导无需输入：
 *   1. 建数据目录（在程序目录**外侧**，升级/重装都不会动它）
 *   2. 生成/补齐 .env：随机会话密钥 + 账号口令 + 数据目录指向 + AI 配置
 *   3. 把初始账号写进 数据目录/初始账号.txt
 *   4. AI 配置异常时留下醒目的告警文件
 *
 * 口令有两个来源，优先用前者：
 *   ① 包内 initial-accounts.json —— 内测分发时想让所有编导机器用同一组口令，
 *      由构建脚本从 installer/initial-accounts.local.json（**不进仓库**）注入；
 *   ② 都没有就随机生成（默认）：安装包发到谁机器上都是同一份文件，写死即公开。
 *
 * AI 配置同理，也只有两个来源：
 *   ① 包内 ai-config.json —— 由构建脚本从 installer/ai-config.local.json（**不进仓库**）注入，
 *      装了它，装机后 AI_MODE=dashscope，装好就能跑真实识别（v1.1.7 之前这里写死 mock，
 *      导致每个编导机器都停在演示模式，且提示信息看不出原因）；
 *   ② 没有就写 mock（不花钱、能跑通全流程），维护人员事后把密钥填进
 *      数据目录的 .env 并重启工作台即可切真实识别。
 *
 * 无论哪种来源，建出来的账号都会被标记「首次登录须改密」，
 * 所以统一口令只用于「装好能进」，不会长期通用。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_DIR = __dirname;
const DATA_DIR = process.env.WORKBENCH_DATA_DIR || path.resolve(APP_DIR, '..', 'data');

const rnd = (n = 16) => crypto.randomBytes(n).toString('base64url').slice(0, n);
// 口令只给可见字符，避免编导手抄时把 0/O、l/1 抄错
const pwd = () => crypto.randomBytes(12).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);

/** 包内固定的初始口令（构建时注入；没注入就返回空，走随机） */
function readPresetPasswords() {
  try {
    const p = path.join(APP_DIR, 'initial-accounts.json');
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = {};
    for (const k of ['maintainer', 'editor']) {
      const v = typeof j[k] === 'string' ? j[k].trim() : '';
      if (v.length >= 8) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/* 密钥形态：本机实测有 `sk-` 与 `sk-ws-` 两种前缀，字符集含 `.` 与 `-`，
 * 长度可达 116 位。校验刻意保守——只确认「像一把百炼密钥」，
 * 不按固定长度/固定前缀卡死，否则官方换个签发格式就会误判成"没配置"而静默退回 mock。 */
const API_KEY_RE = /^sk-[A-Za-z0-9_.-]{10,}$/;

/**
 * 包内 AI 配置（构建时从 installer/ai-config.local.json 注入）。
 * 密钥不像百炼密钥就当作没配：宁可退回 mock，
 * 也不写一个跑不通的值进去——那种“看着配了、实际全失败”的状态最难排查。
 */
function readAiConfig() {
  try {
    const p = path.join(APP_DIR, 'ai-config.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const key = typeof j.apiKey === 'string' ? j.apiKey.trim() : '';
    if (!API_KEY_RE.test(key)) return null;
    const str = (v, dflt) => (typeof v === 'string' && v.trim() ? v.trim() : dflt);
    return {
      apiKey: key,
      region: str(j.region, 'beijing'),
      visionModel: str(j.visionModel, 'qwen3-vl-plus'),
      organizeModel: str(j.organizeModel, 'qwen3.8-flash'),
      rewriteModel: str(j.rewriteModel, ''),
    };
  } catch {
    return null;
  }
}

/**
 * 把「程序需要的全部配置」拼成 .env 全文。
 *
 * @param ai   包内 AI 配置（null = 未配置，走 mock）
 * @param vary 需要每台机器不同的键（会话密钥、口令）。补齐旧文件时沿用原值，绝不覆盖。
 */
function buildEnvText(ai, vary) {
  const toWin = (p) => p.replace(/\\/g, '/');
  const lines = [
    '# 由安装程序生成（每台电脑都不一样）。',
    '# 本文件是工作台的唯一配置源：改完必须重启工作台才会生效。',
    `DATABASE_URL="file:${toWin(path.join(DATA_DIR, 'app.db'))}"`,
    `MEDIA_DIR="${toWin(path.join(DATA_DIR, 'media'))}"`,
    `MUSE_STORAGE_STATE="${toWin(path.join(DATA_DIR, 'muse-session', 'state.json'))}"`,
    `AVATAR_STORAGE_STATE="${toWin(path.join(DATA_DIR, 'avatar-session', 'state.json'))}"`,
    `AVATAR_VIDEO_DIR="${toWin(path.join(DATA_DIR, 'avatars'))}"`,
    `SESSION_SECRET="${vary.SESSION_SECRET}"`,
    'PORT=3939',
    '',
    '# ---- AI 适配器模式：mock | dashscope ----',
    '# mock      ：演示模式。流程、页面、导出都真实执行，但识别内容是演示值，不产生费用。',
    '# dashscope ：真实调用阿里云百炼，会产生费用。',
  ];

  if (ai) {
    lines.push(
      '# 本包已内置密钥，装好即为真实识别。想临时切回演示模式：把下面 AI_MODE 改成 mock，重启工作台。',
      'AI_MODE="dashscope"',
      `DASHSCOPE_API_KEY="${ai.apiKey}"`,
      `DASHSCOPE_REGION="${ai.region}"`,
      `VISION_MODEL="${ai.visionModel}"`,
      `ORGANIZE_MODEL="${ai.organizeModel}"`,
    );
    if (ai.rewriteModel) lines.push(`REWRITE_MODEL="${ai.rewriteModel}"`);
  } else {
    lines.push(
      '# 本包未内置密钥，因此默认演示模式。维护人员改下面两行（填自己的密钥、把 mock 换成 dashscope）',
      '# 并重启工作台，即为真实识别。密钥在阿里云百炼控制台「API-KEY 管理」创建。',
      'AI_MODE="mock"',
      'DASHSCOPE_API_KEY=""',
      'DASHSCOPE_REGION="beijing"',
      'VISION_MODEL="qwen3-vl-plus"',
      'ORGANIZE_MODEL="qwen3.8-flash"',
    );
  }

  lines.push(
    '',
    '# ---- 音频识别通道 ----',
    '# realtime  = paraformer-realtime-v2，WebSocket 直推本地音频（本机部署用这个）',
    '# filetrans = qwen3-asr-flash-filetrans，需要音频有公网地址，本机部署不可用',
    'ASR_TRANSPORT="realtime"',
    'ASR_MODEL="paraformer-realtime-v2"',
    'ASR_PUSH_SPEED="4"',
    'ASR_MAX_SENTENCE_SILENCE="800"',
    'ASR_LANGUAGE_HINTS="zh,en"',
    'ASR_DIARIZATION="false"',
    '',
    '# ---- 形式判定阈值 ----',
    'AI_VIDEO_RATIO_THRESHOLD="0.75"',
    'REAL_PERSON_RATIO_THRESHOLD="0.75"',
    'SCENE_CHANGE_THRESHOLD="0.35"',
    'VISION_SAMPLE_COUNT="9"',
    '',
    '# ---- 重试与超时 ----',
    'MAX_ATTEMPT_RETRY="2"',
    'RETRY_INTERVAL_MS="3000"',
    'STAGE_TIMEOUT_MS="900000"',
    '',
    '# ---- 腾讯妙思素材抓取 ----',
    '# 需要在工作台里各自扫码登录一次，然后把下面改成 "true" 并重启工作台。',
    'MUSE_FETCH_ENABLED="false"',
    'MUSE_LOGIN_URL="https://admuse.qq.com/"',
    'MUSE_HEADLESS="true"',
    'MUSE_WAIT_MS="20000"',
    'MUSE_NAV_TIMEOUT_MS="45000"',
    'MUSE_ALLOWED_HOSTS="admuse.qq.com,ad.qq.com"',
    '',
    '# ---- 数字人口播出片（鲲之益）----',
    '# playwright：真实驱动平台出片，会消耗平台额度，需先扫码登录一次。',
    '# mock      ：只在本地产出桩成品，不提交平台、零额度消耗。',
    'AVATAR_ADAPTER="playwright"',
    '# auto   = 适配器自己选形象/参数并提交（误点一次就真花钱）',
    '# assist = 只预填作品名与文案，弹出浏览器由人自己选参数并点生成（更稳，推荐）',
    'AVATAR_SUBMIT_MODE="assist"',
    '',
    '# ---- 初始账号口令（首次建库时用；登录后会被要求改成自己的）----',
    `SEED_MAINTAINER_PASSWORD="${vary.SEED_MAINTAINER_PASSWORD}"`,
    `SEED_EDITOR_PASSWORD="${vary.SEED_EDITOR_PASSWORD}"`,
    '',
  );
  return lines.join('\n');
}

/**
 * 升级时**必须原样保留**的键（机器身份，丢了就等于重装）。
 *
 * 为什么这几项不能重置：
 *   DATABASE_URL — 指向已有的 app.db。改了等于换一个空库，编导所有任务瞬间消失。
 *   MEDIA_DIR / AVATAR_VIDEO_DIR / *_STORAGE_STATE — 指向已有媒体文件与扫码登录会话，
 *     改了就是文件丢失 + 妙思和数字人都得重扫码。
 *   SESSION_SECRET — 改了所有人当场被登出。
 *   SEED_*_PASSWORD — 建号用的口令，账号已存在时不会再用；但清空它会让「万一重建库」
 *     退化成随机口令，届时没人知道能登进去的是什么。
 */
const PRESERVE_ON_UPGRADE = [
  'DATABASE_URL',
  'MEDIA_DIR',
  'MUSE_STORAGE_STATE',
  'AVATAR_STORAGE_STATE',
  'AVATAR_VIDEO_DIR',
  'SESSION_SECRET',
  'SEED_MAINTAINER_PASSWORD',
  'SEED_EDITOR_PASSWORD',
];

/**
 * 解析 .env 的有效键值（宽松：带不带引号都认）
 */
function parseEnv(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) map.set(m[1], m[2].trim().replace(/^"|"$/g, ''));
  }
  return map;
}

/** 每台机器各自不同的键：补齐旧文件时**沿用原值**，没有才新生成 */
function buildVary(preset, existing) {
  const old = (k) => (existing && existing.get(k)) || '';
  return {
    SESSION_SECRET: old('SESSION_SECRET') || rnd(32),
    SEED_MAINTAINER_PASSWORD: preset.maintainer || old('SEED_MAINTAINER_PASSWORD') || pwd(),
    SEED_EDITOR_PASSWORD: preset.editor || old('SEED_EDITOR_PASSWORD') || pwd(),
  };
}

function writeAccountSheet(vary) {
  fs.writeFileSync(
    path.join(DATA_DIR, '初始账号.txt'),
    [
      '工作台初始账号（由安装程序生成，请妥善保管）',
      '',
      `维护人员：maintainer / ${vary.SEED_MAINTAINER_PASSWORD}`,
      `编导：editor / ${vary.SEED_EDITOR_PASSWORD}`,
      '',
      '首次登录后系统会要求你先改密码，改完才能进入工作台。',
      '数据目录：' + DATA_DIR,
      '自动备份：' + path.resolve(DATA_DIR, '..', 'backups'),
      '（每次升级/卸载前自动备份一次；每天首次启动还会存一份数据库快照，'
        + '最多保留最近 5 份完整备份 + 7 份快照，超出的自动清理）',
      '误删了东西想找回：双击程序目录里的「恢复最近备份」。',
      '',
    ].join('\n'),
  );
}

function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const d of ['media', 'exports', 'tmp', 'muse-session', 'avatar-session', 'avatars']) {
    fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
  }

  const envPath = path.join(DATA_DIR, '.env');
  const preset = readPresetPasswords();
  const ai = readAiConfig();

  if (!fs.existsSync(envPath)) {
    /* 首次安装：整份生成 */
    const vary = buildVary(preset, null);
    fs.writeFileSync(envPath, buildEnvText(ai, vary));
    writeAccountSheet(vary);
  } else {
    /* 已装过（升级）：**整体重置为「本包的出厂配置」，只保留机器身份**。
     *
     * 为什么是重置而不是"只补缺失"（v1.1.7 的行为变更，用户拍板）：
     *   v1.1.6 及更早的包把 AI_MODE 写死成 mock，「只补缺失」的规则下它已存在、
     *   于是永远改不动 —— 结果就是**老机器升级后仍停在演示模式**，
     *   装了带密钥的新包也用不上真实识别。而这类"配置看着在、其实没生效"
     *   的问题，现场极难判断。所以升级时统一以新包为准。
     *
     * 代价与兜底：编导或维护人员自己在 .env 里做的自定义会被覆盖。
     * 因此**先把旧文件整份备份**到 .env.bak-<时间戳>，随时可以捞回来；
     * 同时机器身份（库路径、媒体路径、登录会话、会话密钥、建号口令）原样保留，
     * 保证升级不会丢数据、不会把人踢下线。 */
    const oldText = fs.readFileSync(envPath, 'utf8');
    const existing = parseEnv(oldText);

    // 先备份再覆盖：万一有没预见到的自定义项，还能找回来
    try {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      fs.copyFileSync(envPath, path.join(DATA_DIR, `.env.bak-${stamp}`));
    } catch {
      /* 备份失败不该拦住升级 */
    }

    const vary = buildVary(preset, existing);
    const freshText = buildEnvText(ai, vary);
    // 把机器身份原样贴回去（这些键在新文本里已存在，用替换而非追加，避免重复行）
    let merged = freshText;
    for (const k of PRESERVE_ON_UPGRADE) {
      const keep = existing.get(k);
      if (keep === undefined || keep === '') continue;
      const re = new RegExp(`^(${k}\\s*=\\s*).*$`, 'm');
      if (re.test(merged)) merged = merged.replace(re, `$1"${keep}"`);
    }
    fs.writeFileSync(envPath, merged);

    // 账号表缺失才补，避免把编导改过的口令覆盖回初始值展示
    if (!fs.existsSync(path.join(DATA_DIR, '初始账号.txt'))) {
      writeAccountSheet(vary);
    }
  }

  /* AI 配置体检：把「以为在真实识别、其实全是演示值」这种最误导的状态明确记下来 */
  const finalEnv = parseEnv(fs.readFileSync(envPath, 'utf8'));
  const mode = finalEnv.get('AI_MODE') || 'mock';
  const key = finalEnv.get('DASHSCOPE_API_KEY') || '';
  const warnPath = path.join(DATA_DIR, 'AI配置检查.txt');
  if (mode === 'dashscope' && !key) {
    fs.writeFileSync(
      warnPath,
      [
        '⚠ AI 配置异常',
        '',
        'AI_MODE 已经是 dashscope（真实识别），但 DASHSCOPE_API_KEY 是空的。',
        '这种组合下所有识别都会失败，而且报错信息看不出原因。',
        '',
        '两种改法（改完重启工作台生效）：',
        '  ① 把密钥填进这一行：AI_MODE 保持 dashscope，DASHSCOPE_API_KEY 填 sk- 开头的密钥',
        '  ② 或把 AI_MODE 改回 mock，先用演示模式跑通流程',
        '',
        '配置文件：' + envPath,
        '',
      ].join('\r\n'),
    );
  } else {
    try {
      fs.rmSync(warnPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  // 程序目录里的 .env 每次启动都会用数据目录这份覆盖（升级后配置不丢）
  fs.copyFileSync(envPath, path.join(APP_DIR, '.env'));
  console.log(`init-env ok  AI=${mode} ${key ? 'key=已配置' : 'key=缺失'}`);
}

try {
  main();
} catch (e) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'init-error.txt'), String(e && e.stack));
  } catch {
    /* ignore */
  }
  process.exit(1);
}
