/**
 * 构建可分发的 Windows 安装包。
 *
 * 产物：dist/信息流编导工作台-Setup-<版本>.exe（Inno Setup 打包，每用户免管理员安装）
 *
 * ## 最重要的一件事：只装程序，不装数据
 *
 * 本机上的任务、视频、妙思/数字人登录会话、真实密钥**一律不得进入安装包**。
 * 所以这里不是「复制项目目录」，而是按清单白名单装配，装完再跑一道**硬门禁**扫描：
 * 发现任何数据库文件、data 目录、会话文件、本机密钥明文 → 直接构建失败。
 *
 * 用法：npm run build:installer
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PAYLOAD = path.join(ROOT, 'dist', 'payload', 'app');
const ISCC = 'C:\\Program Files\\Inno Setup 7\\ISCC.exe';

const log = (s) => console.log(`[build:installer] ${s}`);
const fail = (s) => {
  console.error(`[build:installer] 失败：${s}`);
  process.exit(1);
};

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
// Inno 安装被中断时会在目标目录留下「<文件名>.tmp<数字>」的临时副本，
// 这些文件曾被原样带回打包产物、又被下一个包带进编导机器（实测一次 114MB）。
// 装配时一律跳过，并把产物目录里已存在的同类垃圾清掉。
const JUNK = /(\.tmp\d+|\.bak)$/i;
function cleanJunk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) cleanJunk(p);
    else if (JUNK.test(e.name)) {
      try {
        fs.rmSync(p, { force: true });
        log(`清理临时垃圾 ${path.relative(PAYLOAD, p)}`);
      } catch {
        /* 清不掉也不该让构建失败 */
      }
    }
  }
}
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (JUNK.test(e.name)) continue;
    else fs.copyFileSync(s, d);
  }
}

/* ── 1. 建骨架 ─────────────────────────────────────────
 * 这里刻意**不清理**旧产物：本机环境的 safe-delete 守卫会拦截 Node 侧的批量删除
 * （阈值触发即抛错）。旧产物由 shell 侧 `rm -rf dist/payload` 清理，
 * 构建脚本只负责往全新目录里写，保证任何时候都不会触发删除守卫。 */
log(`版本 ${VERSION}`);
fs.mkdirSync(PAYLOAD, { recursive: true });
cleanJunk(PAYLOAD); // 清掉历次构建残留在产物目录里的临时副本

/* 产物目录里的 data\ 是**运行时残留**，不是要分发的内容：只要有人直接在
 * dist\payload\app 里跑过一次 launcher.js（调试、验证「无 node 能不能跑」时会这样），
 * 它就会生成 data\ 并写入 worker.lock / pids.json 等。
 * 这些锁文件带着构建机的 PID，装到编导机器上毫无意义，还会让门禁判失败。
 * 构建脚本本来就**不装配** data\（只装 .next 与 src），所以这里直接清掉即可。 */
const strayData = path.join(PAYLOAD, 'data');
if (fs.existsSync(strayData)) {
  try {
    fs.rmSync(strayData, { recursive: true, force: true });
    log('清理产物目录里的运行时残留 data\\（调试时跑过工作台留下的）');
  } catch (e) {
    // 删不掉就交给门禁拦住：宁可构建失败，也不能把本机残留发出去
    log(`运行时残留 data\\ 清理失败（${e.message}），将由门禁拦截`);
  }
}

/* ── 2. 按白名单装配程序文件 ────────────────────────── */
for (const item of ['.next', 'src']) {
  const s = path.join(ROOT, item);
  if (!fs.existsSync(s)) fail(`缺少构建产物 ${item}，请先执行 npm run build`);
  copyDir(s, path.join(PAYLOAD, item));
  log(`装配 ${item}`);
}
// public 为可选（当前项目没有静态资源目录，有则一并带上）
if (fs.existsSync(path.join(ROOT, 'public'))) {
  copyDir(path.join(ROOT, 'public'), path.join(PAYLOAD, 'public'));
  log('装配 public');
}
fs.mkdirSync(path.join(PAYLOAD, 'prisma'), { recursive: true });
// 只带建库与建账号必需的两个文件（不带任何本地库文件）
for (const f of ['schema.prisma', 'seed.ts']) {
  const s = path.join(ROOT, 'prisma', f);
  if (!fs.existsSync(s)) fail(`缺少 prisma/${f}`);
  fs.copyFileSync(s, path.join(PAYLOAD, 'prisma', f));
}
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(PAYLOAD, 'package.json'));
log('装配 prisma / package.json');

// 运行时文件（启动器、初始化、启停脚本）
copyDir(path.join(ROOT, 'installer', 'app'), PAYLOAD);
// 脚本类文件必须按目标解释器的编码要求转码（否则编导机器上一跑就乱码/报错）：
//   .vbs → UTF-16LE+BOM：Windows 脚本宿主按 ANSI(GBK) 解析无 BOM 的 UTF-8，
//          中文注释/提示会被读成「无效字符 800A0408」（v1.1.1 实测翻车）；
//   .ps1 → UTF-8+BOM：PowerShell 5.1 无 BOM 的 UTF-8 会被当 ANSI 读，中文一样乱码。
// 仓库里保持 UTF-8 便于阅读与 diff，出包时在这里统一转码。
for (const e of fs.readdirSync(PAYLOAD)) {
  const lower = e.toLowerCase();
  if (!lower.endsWith('.vbs') && !lower.endsWith('.ps1')) continue;
  const p = path.join(PAYLOAD, e);
  let txt = fs.readFileSync(p, 'utf8');
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  if (lower.endsWith('.vbs')) fs.writeFileSync(p, '\ufeff' + txt, { encoding: 'utf16le' });
  else fs.writeFileSync(p, '\ufeff' + txt, { encoding: 'utf8' });
  log(`脚本转码（BOM）：${e}`);
}
log('装配启动器与初始化脚本');

/* ── 2b. 统一初始口令（可选，默认随机）────────────────
 * 内测分发时想让所有编导机器用同一组初始口令：把口令写进
 * installer/initial-accounts.local.json（**已 gitignore，绝不进仓库**）：
 *   { "maintainer": "……", "editor": "……" }
 * 构建时注入包内的 initial-accounts.json；没这个文件就什么都不做，
 * 装机时随机生成（每台机器不同）。
 * 注意：口令会随安装包分发，拿到包的人理论上能提取出来，
 * 所以它只负责「装好能进」，账号一律标记首次登录须改密。 */
const presetFile = path.join(ROOT, 'installer', 'initial-accounts.local.json');
if (fs.existsSync(presetFile)) {
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(presetFile, 'utf8'));
  } catch {
    fail(`installer/initial-accounts.local.json 不是合法 JSON`);
  }
  const out = {};
  for (const k of ['maintainer', 'editor']) {
    const v = typeof j[k] === 'string' ? j[k].trim() : '';
    if (!v) fail(`installer/initial-accounts.local.json 缺少 ${k} 口令`);
    if (v.length < 8) fail(`${k} 口令至少 8 位（当前 ${v.length} 位）`);
    out[k] = v;
  }
  fs.writeFileSync(path.join(PAYLOAD, 'initial-accounts.json'), JSON.stringify(out, null, 2));
  log('注入统一初始口令（maintainer / editor）');
} else {
  log('未配置统一初始口令，装机时随机生成（每台机器不同）');
}

/* ── 2c. AI 配置（可选；不配则装机后是演示模式）─────────
 * 把 installer/ai-config.local.json（**已 gitignore，绝不进仓库**）注入包内的
 * ai-config.json，装机时由 init-env.js 写进数据目录的 .env。
 *
 * 为什么要有这一步：v1.1.6 及更早版本在 init-env.js 里**写死** AI_MODE="mock"，
 * 于是每台编导机器都停在演示模式，页面上只有一行「当前 AI 适配器为 Mock 模式」，
 * 看不出是「没配」还是「配错了」——这是本次要修的问题。
 *
 * 密钥随包分发是有意为之（内测 3~5 人）：不这样做，编导机器就永远只能跑演示模式。
 * 代价是拿到包的人理论上能提取密钥，可接受；后续要收口可改为装完人工填一次。 */
const aiFile = path.join(ROOT, 'installer', 'ai-config.local.json');
let aiSummary = '未配置 → 装机后为演示模式（mock）';
if (fs.existsSync(aiFile)) {
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(aiFile, 'utf8'));
  } catch {
    fail('installer/ai-config.local.json 不是合法 JSON');
  }
  const key = typeof j.apiKey === 'string' ? j.apiKey.trim() : '';
  if (!/^sk-[A-Za-z0-9_.-]{10,}$/.test(key)) {
    fail(`installer/ai-config.local.json 的 apiKey 不合法（应形如 sk-xxxxxxxx，当前长度 ${key.length}）`);
  }
  const aiOut = {
    apiKey: key,
    region: typeof j.region === 'string' && j.region.trim() ? j.region.trim() : 'beijing',
    visionModel: typeof j.visionModel === 'string' && j.visionModel.trim() ? j.visionModel.trim() : 'qwen3-vl-plus',
    organizeModel: typeof j.organizeModel === 'string' && j.organizeModel.trim() ? j.organizeModel.trim() : 'qwen3.8-flash',
  };
  if (typeof j.rewriteModel === 'string' && j.rewriteModel.trim()) aiOut.rewriteModel = j.rewriteModel.trim();
  fs.writeFileSync(path.join(PAYLOAD, 'ai-config.json'), JSON.stringify(aiOut, null, 2));
  aiSummary = `dashscope（key: ${key.slice(0, 6)}***${key.slice(-4)}，区域 ${aiOut.region}）`;
  log(`注入 AI 配置：${aiSummary}`);
} else {
  log('未配置 AI 密钥，装机后为演示模式（页面上会有明确提示）');
}

/* ── 3. 生产依赖（不装开发依赖；Playwright 浏览器另行放置）── */
const npmEnv = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', npm_config_audit: 'false', npm_config_fund: 'false' };
const run = (args) => {
  // Windows 下 npm 是 npm.cmd，必须经 shell 启动，否则 spawnSync 直接失败（status=null）
  const r = spawnSync('npm', args, { cwd: PAYLOAD, env: npmEnv, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`npm ${args.join(' ')} 失败（status=${r.status} error=${r.error ? r.error.message : '-'}）`);
};

// 依赖已装过就跳过：本机网络慢时一次安装可达十几分钟，重复构建不该重来一遍
if (fs.existsSync(path.join(PAYLOAD, 'node_modules', 'next'))) {
  log('已存在 node_modules，跳过安装');
} else {
  log('安装生产依赖（需要网络，可能十几分钟）…');
  run(['install', '--omit=dev', '--no-audit', '--no-fund']);
}

// worker 用 tsx 跑、首次建库用 prisma CLI，两者是开发依赖但运行时需要。
// 刻意**不走 npm install**：本机 Node 删除守卫会打断 npm 清理临时目录（实测 npm 进程直接崩溃），
// 直接从当前 node_modules 拷贝这些包，既快又完全不触发删除。
// 注意：`.prisma/client` 是 `prisma generate` 的产物（含查询引擎二进制），
// 必须一起带上，否则装机后报 “@prisma/client did not initialize yet”。
// 这里刻意**不在打包机跑 prisma generate**：本机删除守卫会打断它的临时目录清理。
for (const m of ['tsx', 'esbuild', '@esbuild', 'get-tsconfig', 'resolve-pkg-maps', 'prisma', '@prisma', '.prisma']) {
  const s = path.join(ROOT, 'node_modules', m);
  if (!fs.existsSync(s)) continue;
  copyDir(s, path.join(PAYLOAD, 'node_modules', m));
  log(`装配运行时依赖 ${m}`);
}
log('依赖就绪');

/* ── 4. 内嵌 Node 运行时 ───────────────────────────── */
const nodeExe = process.execPath;
const rtDir = path.join(PAYLOAD, 'runtime', 'node');
fs.mkdirSync(rtDir, { recursive: true });
fs.copyFileSync(nodeExe, path.join(rtDir, 'node.exe'));
const v = spawnSync(path.join(rtDir, 'node.exe'), ['-v'], { encoding: 'utf8' });
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sameHash = shaFile(nodeExe) === shaFile(path.join(rtDir, 'node.exe'));
// 说明：本机安全策略禁止执行「刚写入的 exe」（spawn 恒返回 EBUSY），因此不能靠 `node -v` 自检，
// 改用哈希比对确认字节一致；这条限制只作用于构建机，编导机器上运行安装包不受影响。
if (v.status === 0) log(`内嵌运行时 ${v.stdout.trim()}`);
else if (sameHash) log('内嵌运行时已就位（与构建所用 Node 字节一致，本机禁止执行新写入的 exe，故只校验哈希）');
else fail('内嵌运行时拷贝不完整');

/* ── 5. 抓取用浏览器内核（只取 headless shell，体积最小）── */
const pwRoot = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
const shellDir = fs.existsSync(pwRoot)
  ? fs.readdirSync(pwRoot).find((d) => d.startsWith('chromium_headless_shell-'))
  : null;
if (!shellDir) log('未找到 Playwright 内核，安装后首次抓取链接时会自动提示下载');
else {
  copyDir(path.join(pwRoot, shellDir), path.join(PAYLOAD, 'browsers', shellDir));
  log(`装配浏览器内核 ${shellDir}`);
}

/* ── 6. 硬门禁：本机数据与密钥绝不能进包 ─────────────── */
log('扫描产物：确认不含任何本机数据与密钥…');
const localEnv = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
// 本机 .env 里的敏感值一律不得进包。唯独可以进包的是「包内 AI 密钥」——
// 那是**有意随包分发**的（见 2c 段说明），所以从扫描名单里剔掉，
// 但仍要求它只出现在 ai-config.json 里（下面单独核对）。
const packagedKey = fs.existsSync(path.join(PAYLOAD, 'ai-config.json'))
  ? (JSON.parse(fs.readFileSync(path.join(PAYLOAD, 'ai-config.json'), 'utf8')).apiKey ?? '')
  : '';
const secrets = [];
const secretLabels = [];
for (const line of localEnv.split('\n')) {
  const m = /^\s*(DASHSCOPE_API_KEY|SESSION_SECRET|SEED_\w+)\s*=\s*"?([^"#]+)"?/.exec(line);
  if (!m || !m[2]) continue;
  const v = m[2].trim();
  if (v.length < 6 || v === 'change-me-local-only' || v === packagedKey) continue;
  secrets.push(v);
  secretLabels.push(m[1]);
}
// 包内密钥只能在 ai-config.json 出现：出现在别处（日志/快照/临时文件）说明某处把配置整个 dump 了
const AI_KEY_ALLOWED = /ai-config\.json$/i;
const packagedKeyHits = [];
const FORBIDDEN_NAME = /(\.db$|\.sqlite$|\.sqlite3$)/i;
const FORBIDDEN_PATH = /(\\data\\|\\_scratch\\|\\\.git\\|muse-session\\state\.json|avatar-session\\state\.json)/i;
const problems = [];

function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    // 第三方依赖目录（node_modules）不参与「数据目录」判定：
    // 例如 caniuse-lite/data/features/*.js 只是包内目录，不是我们的数据；
    // 同时跳过对依赖做全文扫描（体积大、纯浪费时间）。
    const rel = path.relative(PAYLOAD, p);
    const isDep = rel.split(path.sep).includes('node_modules');
    if (e.isDirectory()) {
      if (!isDep && e.name === 'data') problems.push(`目录 ${p}`);
      scan(p);
      continue;
    }
    if (isDep) continue;
    if (FORBIDDEN_NAME.test(e.name)) problems.push(`数据库文件 ${p}`);
    if (FORBIDDEN_PATH.test(p)) problems.push(`敏感路径 ${p}`);
    if (fs.statSync(p).size >= 2_000_000) continue;
    let txt = '';
    try {
      txt = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    // 文本文件内容里出现本机密钥 → 直接判失败
    for (const s of secrets) if (txt.includes(s)) problems.push(`密钥明文出现在 ${p}`);
    if (packagedKey && txt.includes(packagedKey) && !AI_KEY_ALLOWED.test(e.name)) {
      packagedKeyHits.push(path.relative(PAYLOAD, p));
    }
  }
}
scan(PAYLOAD);
if (packagedKeyHits.length) {
  console.error('包内 AI 密钥出现在 ai-config.json 以外的文件里（疑似被某处整个 dump 出来）：');
  for (const p of packagedKeyHits.slice(0, 20)) console.error('  - ' + p);
  process.exit(1);
}
if (problems.length) {
  console.error('门禁未通过，以下本机内容被装进了产物：');
  for (const p of problems.slice(0, 20)) console.error('  - ' + p);
  process.exit(1);
}
log(
  `门禁通过（已核对 ${secrets.length} 项本机密钥${secretLabels.length ? '：' + [...new Set(secretLabels)].join('/') : ''}、` +
    `无数据库/会话/数据目录${packagedKey ? '；包内 AI 密钥仅存在于 ai-config.json' : ''}）`,
);

/* ── 7. 编译安装包 ─────────────────────────────────── */
if (!fs.existsSync(ISCC)) fail(`未找到 Inno Setup 编译器：${ISCC}`);
log('编译安装包（压缩耗时较长，请耐心等待）…');
// 路径必须用绝对路径传给 Inno：它以 .iss 所在目录解析相对路径，传相对路径会找错地方
execFileSync(
  ISCC,
  [
    '/Qp',
    `/DMyAppVersion=${VERSION}`,
    `/DMyPayload=${PAYLOAD}`,
    `/DMyOutDir=${path.join(ROOT, 'dist')}`,
    path.join(ROOT, 'installer', 'setup.iss'),
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

const out = path.join(ROOT, 'dist', `信息流编导工作台-Setup-${VERSION}.exe`);
if (!fs.existsSync(out)) fail('未产出安装包');
const size = fs.statSync(out).size / 1024 / 1024;
const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
fs.writeFileSync(`${out}.sha256`, sha);
log(`完成：${out}（${size.toFixed(0)} MB）`);
log(`校验：sha256=${sha}`);
log(`本包行为速查：AI=${aiSummary}；初始口令=${fs.existsSync(path.join(PAYLOAD, 'initial-accounts.json')) ? '统一固定（首次登录强制改密）' : '每台机器随机'}；自动备份=已启用`);
