/**
 * 自动备份 —— 把数据目录复制一份到「数据目录外侧」的 backups\ 下。
 *
 * 为什么要做：纯本地部署，data\ 是编导所有任务、脚本、成片的**唯一副本**。
 * 升级失败、误删、磁盘故障都会造成不可逆损失，而编导不懂技术，无法自己抢救。
 *
 * 设计取舍（面向零技术编导，不给他们出选择题）：
 *   - 备份落在 data 外面（%LOCALAPPDATA%\信息流编导工作台\backups\），
 *     这样「备份不会被自己再备份一遍」，卸载/重装也不会把备份一起带走。
 *   - 任何失败都只记日志、不抛异常、不中断调用方：备份失败绝不能导致装不上。
 *   - 只备份「有内容」的东西：临时目录、日志、升级旗标一律跳过。
 *   - 自动保留最近若干份，避免把编导的磁盘撑满（这是自动备份最容易踩的坑）。
 *
 * 用法：
 *   node backup.js                        全量备份（默认）
 *   node backup.js --mode=db              只备份数据库与配置（启动期日常快照）
 *   node backup.js --tag=pre-upgrade      备份名带后缀，便于事后分辨是哪种场景
 *   node backup.js --keep=5               最多保留 5 份（默认：全量 5 份 / 快照 7 份）
 *   node backup.js --data=<dir>           指定数据目录（不设则取程序目录旁的 data）
 *
 * 退出码：0=已备份或主动跳过；1=失败（调用方应记录但不要中断安装）。
 */
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = __dirname;
const DATA_DIR = process.env.WORKBENCH_DATA_DIR || path.resolve(APP_DIR, '..', 'data');
const BACKUP_ROOT = process.env.WORKBENCH_BACKUP_DIR || path.resolve(DATA_DIR, '..', 'backups');
const LOG = path.join(DATA_DIR, 'backup.log');

const args = process.argv.slice(2);
function opt(name, dflt) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const MODE = opt('mode', 'full'); // full | db
const TAG = opt('tag', MODE === 'db' ? 'auto' : 'manual');
const KEEP = Number(opt('keep', MODE === 'db' ? 7 : 5));
const DATA_OVERRIDE = opt('data', '');
const DATA = DATA_OVERRIDE || DATA_DIR;

function log(msg) {
  const line = `${new Date().toISOString()} [${MODE}] ${msg}`;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* 记不下就算了，不能因为写日志失败而中断 */
  }
  console.log(line);
}

/** 跳过：临时文件、日志、升级旗标、版本残留 */
function skip(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (p === 'tmp' || p.startsWith('tmp/')) return true;
  if (p === 'upgrade.lock') return true;
  if (p === 'web.lock' || p === 'worker.lock' || p === 'avatar-worker.lock') return true;
  if (p === 'pids.json') return true;
  if (/\.log$/i.test(p)) return true;
  if (/\.tmp\d+$/i.test(p) || /\.bak$/i.test(p)) return true;
  if (p === '.DS_Store') return true;
  return false;
}

function walk(dir, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (skip(rel)) continue;
    if (e.isDirectory()) {
      walk(abs, rel, out);
    } else if (e.isFile()) {
      try {
        out.push({ abs, rel, size: fs.statSync(abs).size });
      } catch {
        /* 正在被写的文件，跳过即可 */
      }
    }
  }
  return out;
}

/** 只备份数据库与配置：app.db 及其 WAL/SHM 必须成套复制，否则恢复后数据可能缺一半 */
function collectDb() {
  const names = ['app.db', 'app.db-wal', 'app.db-shm', '.env', '初始账号.txt'];
  const out = [];
  for (const n of names) {
    const abs = path.join(DATA, n);
    try {
      if (fs.statSync(abs).isFile()) out.push({ abs, rel: n, size: fs.statSync(abs).size });
    } catch {
      /* 不存在就跳过（比如 WAL 已合并） */
    }
  }
  return out;
}

function dirSizeOf(files) {
  return files.reduce((s, f) => s + f.size, 0);
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return -1; // 取不到就不做空间判断，照常尝试
  }
}

function humanMB(n) {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function cleanupKeep(root, keep) {
  let list = [];
  try {
    list = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      // 只认「时间戳-标签」这种我们自己生成的目录：auto\ 是快照的父目录，
      // 不能把它当一份备份数进去（否则全量备份会少留一份），更不能误删。
      .filter((n) => /^\d{8}-\d{6}-/.test(n))
      .sort();
  } catch {
    return 0;
  }
  // 目录名以时间戳开头，字典序即时间序；保留最新的 keep 份
  const drop = list.slice(0, Math.max(0, list.length - keep));
  let n = 0;
  for (const d of drop) {
    try {
      fs.rmSync(path.join(root, d), { recursive: true, force: true });
      n++;
    } catch {
      /* 删不掉就算了 */
    }
  }
  if (n) log(`清理旧备份 ${n} 份（保留最近 ${keep} 份）`);
  return n;
}

function main() {
  if (fs.existsSync(DATA) === false) {
    log(`无数据目录，跳过（${DATA}）`);
    return 0;
  }

  const files = MODE === 'db' ? collectDb() : walk(DATA, '', []);
  if (files.length === 0) {
    log('没有需要备份的内容，跳过');
    return 0;
  }

  const need = dirSizeOf(files);
  const free = freeBytes(BACKUP_ROOT);
  // 留 1.15 倍余量 + 200MB 缓冲：复制过程本身和后续使用都要空间
  if (free >= 0 && need * 1.15 + 200 * 1024 * 1024 > free) {
    log(`空间不足，跳过备份（需要 ${humanMB(need)}，可用 ${humanMB(free)}）`);
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const name = `${stamp}-${TAG}`;
  const destRoot = MODE === 'db' ? path.join(BACKUP_ROOT, 'auto') : BACKUP_ROOT;
  const dest = path.join(destRoot, name);
  if (fs.existsSync(dest)) {
    log(`同名备份已存在，跳过（${name}）`);
    return 0;
  }

  let copied = 0;
  let bytes = 0;
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) {
      const to = path.join(dest, f.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(f.abs, to);
      copied++;
      bytes += f.size;
    }
  } catch (e) {
    log(`备份失败：${e && e.message}（已复制 ${copied} 个文件，正在清理残份）`);
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      /* 清理不掉就留着，至少里面的文件是好的 */
    }
    return 1;
  }

  cleanupKeep(destRoot, KEEP);
  log(`完成：${name}（${copied} 个文件，${humanMB(bytes)}）→ ${dest}`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  log(`异常：${e && e.stack ? e.stack : e}`);
  process.exit(1);
}
