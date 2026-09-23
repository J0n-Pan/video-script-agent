/**
 * 安装后初始化（由安装器在安装结束时调用一次，编导看不到任何输出）。
 *
 * 只做三件事，全部自动生成、编导无需输入：
 *   1. 建数据目录（在程序目录**外侧**，升级/重装都不会动它）
 *   2. 生成 .env：随机会话密钥 + 账号口令 + 数据目录指向
 *   3. 把初始账号写进 数据目录/初始账号.txt，编导打不开工作台时可以翻开看
 *
 * 口令有两个来源，优先用前者：
 *   ① 包内 initial-accounts.json —— 内测分发时想让所有编导机器用同一组口令，
 *      由构建脚本从 installer/initial-accounts.local.json（**不进仓库**）注入；
 *   ② 都没有就随机生成（默认）：安装包发到谁机器上都是同一份文件，写死即公开。
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

function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const d of ['media', 'exports', 'tmp', 'muse-session', 'avatar-session', 'avatars']) {
    fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
  }

  const envPath = path.join(DATA_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    const preset = readPresetPasswords();
    const maintainerPwd = preset.maintainer || pwd();
    const editorPwd = preset.editor || pwd();
    const toWin = (p) => p.replace(/\\/g, '/');
    const env = [
      '# 由安装程序生成（每台电脑都不一样），修改后重启工作台生效',
      `DATABASE_URL="file:${toWin(path.join(DATA_DIR, 'app.db'))}"`,
      `MEDIA_DIR="${toWin(path.join(DATA_DIR, 'media'))}"`,
      `MUSE_STORAGE_STATE="${toWin(path.join(DATA_DIR, 'muse-session', 'state.json'))}"`,
      `AVATAR_STORAGE_STATE="${toWin(path.join(DATA_DIR, 'avatar-session', 'state.json'))}"`,
      `AVATAR_VIDEO_DIR="${toWin(path.join(DATA_DIR, 'avatars'))}"`,
      `SESSION_SECRET="${rnd(32)}"`,
      'PORT=3939',
      '',
      '# 真实识别开关：默认演示模式（不花钱、能跑通全流程）。',
      '# 拿到密钥后把下面两行改成 dashscope 与你的密钥，重启工作台即为真实识别。',
      'AI_MODE="mock"',
      'DASHSCOPE_API_KEY=""',
      'MUSE_FETCH_ENABLED="false"',
      '',
      '# 初始账号口令（建号时用；登录后会被要求改成自己的）',
      `SEED_MAINTAINER_PASSWORD="${maintainerPwd}"`,
      `SEED_EDITOR_PASSWORD="${editorPwd}"`,
      '',
    ].join('\n');
    fs.writeFileSync(envPath, env);
    fs.writeFileSync(
      path.join(DATA_DIR, '初始账号.txt'),
      [
        '工作台初始账号（由安装程序生成，请妥善保管）',
        '',
        `维护人员：maintainer / ${maintainerPwd}`,
        `编导：editor / ${editorPwd}`,
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

  // 程序目录里的 .env 每次启动都会用数据目录这份覆盖（升级后配置不丢）
  fs.copyFileSync(envPath, path.join(APP_DIR, '.env'));
  console.log('init-env ok');
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
