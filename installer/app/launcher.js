/**
 * 工作台启动器（随安装包分发，运行在编导电脑上）。
 *
 * 职责（全部自动完成，编导不需要做任何选择）：
 *   1. 准备好配置文件：数据目录在外侧（升级/重装不丢），程序目录里的 .env 缺失时自动从数据目录回填
 *   2. 首次运行自动建库（prisma db push + seed），生成账号
 *   3. 拉起网页服务 + 视频分析进程 + 数字人进程（后台，无黑窗口）
 *   4. 等服务就绪后自动打开浏览器
 *
 * 为什么不用 npm run dev：分发给非技术编导的是**生产构建**（next start），
 * 启动快、不现场编译、不暴露开发错误页。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const net = require('node:net');

const APP_DIR = __dirname;
const DATA_DIR = process.env.WORKBENCH_DATA_DIR || path.resolve(APP_DIR, '..', 'data');
const NODE = process.env.WORKBENCH_NODE || path.join(APP_DIR, 'runtime', 'node', 'node.exe');
const DEFAULT_PORT = Number(process.env.PORT || 3939);

/** 端口被占用时自动往后找（编导不需要知道什么是端口） */
function pickPort(start) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(pickPort(start + 1)));
    srv.listen(start, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const log = (s) => {
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'launcher.log'), `${new Date().toISOString()} ${s}\n`);
  } catch {
    /* 日志写不进去不影响启动 */
  }
};

function ensureDirs() {
  for (const d of [DATA_DIR, path.join(DATA_DIR, 'media'), path.join(DATA_DIR, 'exports'), path.join(DATA_DIR, 'tmp'), path.join(DATA_DIR, 'muse-session'), path.join(DATA_DIR, 'avatar-session'), path.join(DATA_DIR, 'avatars')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** 用户配置放在数据目录（升级不丢）；程序目录的 .env 缺失时回填一份 */
function ensureEnv() {
  const appEnv = path.join(APP_DIR, '.env');
  const dataEnv = path.join(DATA_DIR, '.env');
  if (!fs.existsSync(dataEnv) && fs.existsSync(appEnv)) {
    fs.copyFileSync(appEnv, dataEnv);
  }
  if (fs.existsSync(dataEnv)) {
    fs.copyFileSync(dataEnv, appEnv);
  }
}

function runNode(args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(NODE, args, {
      cwd: APP_DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
    });
    let out = '';
    p.stdout.on('data', (b) => (out += b.toString()));
    p.stderr.on('data', (b) => (out += b.toString()));
    p.on('exit', (code) => resolve({ code, out }));
    p.on('error', (e) => resolve({ code: -1, out: String(e && e.message) }));
  });
}

/** 读出数据目录里的 .env（子进程是独立进程，不会自动加载它） */
function readEnvFile() {
  const p = path.join(DATA_DIR, '.env');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
  return out;
}

/** 首次运行：建库 + 建账号。
 *  刻意不用 `prisma db seed`：它会以 `tsx …` 形式调用，而安装包里 node_modules/.bin
 *  不在 PATH（我们内嵌 Node、不经 npm 启动），会报“tsx 不是内部或外部命令”。
 *  这里一律用内嵌 node 直接执行脚本，路径全部显式给出。 */
async function initDatabase() {
  const db = path.join(DATA_DIR, 'app.db');
  if (fs.existsSync(db)) return;
  log('首次运行，初始化数据库…');
  const cli = path.join(APP_DIR, 'node_modules', 'prisma', 'build', 'index.js');
  const schema = path.join(APP_DIR, 'prisma', 'schema.prisma');
  const env = { DATABASE_URL: `file:${db.replace(/\\/g, '/')}` };
  const push = await runNode([cli, 'db', 'push', '--skip-generate', '--accept-data-loss', `--schema=${schema}`], { env });
  log(`db push -> ${push.code}`);
  const tsx = path.join(APP_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const seed = await runNode([tsx, path.join('prisma', 'seed.ts')], { env });
  log(`db seed -> ${seed.code} ${seed.out.slice(-200)}`);
}

function waitReady(ms = 60_000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/login', timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode < 500);
      });
      req.on('error', () => {
        req.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 800);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 800);
      });
    };
    tick();
  });
}

function startChild(args, name) {
  const p = spawn(NODE, args, { cwd: APP_DIR, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  p.stderr.on('data', (b) => log(`[${name}] ${String(b).slice(0, 300)}`));
  p.on('exit', (code) => log(`[${name}] 退出 code=${code}`));
  return p;
}

async function main() {
  ensureDirs();
  ensureEnv();

  const PORT = await pickPort(DEFAULT_PORT);
  const baseEnv = {
    PORT: String(PORT),
    DATABASE_URL: `file:${path.join(DATA_DIR, 'app.db').replace(/\\/g, '/')}`,
    MEDIA_DIR: path.join(DATA_DIR, 'media'),
    MUSE_STORAGE_STATE: path.join(DATA_DIR, 'muse-session', 'state.json'),
    AVATAR_STORAGE_STATE: path.join(DATA_DIR, 'avatar-session', 'state.json'),
    AVATAR_VIDEO_DIR: path.join(DATA_DIR, 'avatars'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(APP_DIR, 'browsers'),
    WORKBENCH_DATA_DIR: DATA_DIR,
  };
  // .env 里的配置（密钥、模式开关等）要显式传给子进程：
  // worker 是独立进程，不会像 Next 那样自动加载 .env
  Object.assign(process.env, readEnvFile(), baseEnv);

  await initDatabase();

  const children = [];
  children.push(startChild([path.join('node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORT), '-H', '127.0.0.1'], 'web'));
  const tsx = path.join(APP_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  children.push(startChild([tsx, 'src/worker/index.ts'], 'worker'));
  children.push(startChild([tsx, 'src/worker/avatar.ts'], 'avatar'));

  // 记下 PID，供「停止工作台」精确关闭（不误杀别的 Node 程序）
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'pids.json'), JSON.stringify([process.pid, ...children.map((c) => c.pid)]));
  } catch {
    /* ignore */
  }

  const ok = await waitReady();
  log(`服务就绪：${ok}`);
  if (ok) {
    spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}`], { windowsHide: true, stdio: 'ignore' });
  }

  const shutdown = () => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => log(`启动失败：${e && e.stack}`));
