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
const crypto = require('node:crypto');

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

/**
 * 结构迁移（含首次建库）。
 * 以前只在「库文件不存在」时建库，于是后来新增的字段（例如 mustChangePassword）
 * 在已装过的机器上永远不会生效，一查就报错。每次无脑 push 又要让编导多等几秒，
 * 所以用 schema 指纹折中：结构没变就跳过。
 * 刻意不带 --accept-data-loss：新增字段不需要它，带上反而可能悄悄丢数据。
 */
async function ensureSchema() {
  const schema = path.join(APP_DIR, 'prisma', 'schema.prisma');
  const mark = path.join(DATA_DIR, '.schema-sha');
  let sha = '';
  try {
    sha = crypto.createHash('sha256').update(fs.readFileSync(schema)).digest('hex');
  } catch (e) {
    log(`读 schema 失败：${e && e.message}`);
    return false;
  }
  let prev = '';
  try {
    prev = fs.readFileSync(mark, 'utf8').trim();
  } catch {
    /* 没跑过 */
  }
  if (prev === sha) return true;
  const cli = path.join(APP_DIR, 'node_modules', 'prisma', 'build', 'index.js');
  const r = await runNode([cli, 'db', 'push', '--skip-generate', `--schema=${schema}`], {
    env: { DATABASE_URL: `file:${path.join(DATA_DIR, 'app.db').replace(/\\/g, '/')}` },
  });
  log(`db push -> ${r.code} ${String(r.out).slice(-200)}`);
  if (r.code !== 0) return false;
  try {
    fs.writeFileSync(mark, sha);
  } catch {
    /* 记不下指纹下次再跑一次，无害 */
  }
  return true;
}

/** 首次运行：建库 + 建账号。
 *  刻意不用 `prisma db seed`：它会以 `tsx …` 形式调用，而安装包里 node_modules/.bin
 *  不在 PATH（我们内嵌 Node、不经 npm 启动），会报“tsx 不是内部或外部命令”。
 *  这里一律用内嵌 node 直接执行脚本，路径全部显式给出。 */
async function initDatabase() {
  const db = path.join(DATA_DIR, 'app.db');
  const first = !fs.existsSync(db);
  if (!(await ensureSchema())) return;
  if (!first) return;
  log('首次运行，初始化账号…');
  const env = { DATABASE_URL: `file:${db.replace(/\\/g, '/')}` };
  const tsx = path.join(APP_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const seed = await runNode([tsx, path.join('prisma', 'seed.ts')], { env });
  log(`db seed -> ${seed.code} ${seed.out.slice(-200)}`);
}

// 端口必须以参数传入：它只在 main() 里确定，而这里是词法作用域，
// 直接写 PORT 会取不到（首发版就是这么写的，结果一调用就 ReferenceError，
// main() 提前 reject → 浏览器不自动打开、退出钩子也没注册上）。
function waitReady(port, ms = 60_000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: port, path: '/login', timeout: 1500 }, (res) => {
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

/** 单实例锁：记录启动器 PID 与端口。
 *  已有实例存活时直接打开浏览器并退出——否则会再起一套进程并把 pids.json 覆盖掉，
 *  老实例从此无法被「停止工作台」关闭（v1.1.2 实测翻车：升级时装不上、也停不掉）。 */
const LOCK_FILE = path.join(DATA_DIR, 'web.lock');
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function main() {
  ensureDirs();
  ensureEnv();

  // 升级旗标：安装器插上的（插旗→清杀→替换文件→摘旗），期间启动会锁住文件打断升级
  if (fs.existsSync(path.join(DATA_DIR, 'upgrade.lock'))) {
    log('检测到升级正在进行，本次启动取消');
    return;
  }

  const prev = readLock();
  if (prev && pidAlive(prev.pid)) {
    log(`已有工作台在跑（pid=${prev.pid}），直接打开浏览器后退出`);
    spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${prev.port || DEFAULT_PORT}`], { windowsHide: true, stdio: 'ignore' });
    return;
  }

  const PORT = await pickPort(DEFAULT_PORT);
  // 先占单实例锁再拉子进程；被强杀留下的旧锁靠 pid 失活自愈
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: PORT })); } catch { /* ignore */ }
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

  // 退出钩子要在「等就绪」之前装好：等就绪本身可能失败或很久，
  // 装在它后面的话（首发版即如此）一旦抛错就再也收不到停止信号。
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

  const ok = await waitReady(PORT);
  log(`服务就绪：${ok}`);
  if (ok) {
    spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}`], { windowsHide: true, stdio: 'ignore' });
  }
}

main().catch((e) => log(`启动失败：${e && e.stack}`));
