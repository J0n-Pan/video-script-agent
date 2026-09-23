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
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/* ── 1. 建骨架 ─────────────────────────────────────────
 * 这里刻意**不清理**旧产物：本机环境的 safe-delete 守卫会拦截 Node 侧的批量删除
 * （阈值触发即抛错）。旧产物由 shell 侧 `rm -rf dist/payload` 清理，
 * 构建脚本只负责往全新目录里写，保证任何时候都不会触发删除守卫。 */
log(`版本 ${VERSION}`);
fs.mkdirSync(PAYLOAD, { recursive: true });

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
log('装配启动器与初始化脚本');

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
const secrets = [];
for (const line of localEnv.split('\n')) {
  const m = /^\s*(DASHSCOPE_API_KEY|SESSION_SECRET|SEED_\w+)\s*=\s*"?([^"#]+)"?/.exec(line);
  if (m && m[2] && m[2].trim().length >= 6 && m[2].trim() !== 'change-me-local-only') secrets.push(m[2].trim());
}
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
    // 文本文件内容里出现本机密钥 → 直接判失败
    if (secrets.length && fs.statSync(p).size < 2_000_000) {
      let txt = '';
      try {
        txt = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      for (const s of secrets) if (txt.includes(s)) problems.push(`密钥明文出现在 ${p}`);
    }
  }
}
scan(PAYLOAD);
if (problems.length) {
  console.error('门禁未通过，以下本机内容被装进了产物：');
  for (const p of problems.slice(0, 20)) console.error('  - ' + p);
  process.exit(1);
}
log(`门禁通过（已核对 ${secrets.length} 项本机密钥、无数据库/会话/数据目录）`);

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
