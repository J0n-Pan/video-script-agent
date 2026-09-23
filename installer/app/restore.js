/**
 * 从备份恢复数据。
 *
 * 用法：
 *   node restore.js --list                列出可恢复的备份（最新在前）
 *   node restore.js                       恢复「最近一次全量备份」
 *   node restore.js --from=<目录名>       恢复指定备份（用 --list 查名字）
 *   node restore.js --from=auto/<名字>    恢复某次启动期数据库快照
 *
 * 三条刻意的保守设计：
 *   1. **绝不先删后拷**。恢复前把当前数据先复制成一份「回滚前-<时间>」备份，
 *      再**覆盖式**写回（不删除 data 里多出来的文件）。宁可留下孤儿文件，
 *      也绝不出现「恢复失败、原数据也没了」这种不可逆事故。
 *   2. 「回滚前-」备份不以时间戳开头，自动清理（只认时间戳目录）永远不会删它。
 *   3. 必须在工作台停止后执行；检测到还在运行就直接拒绝，并提示先退出。
 *
 * 退出码：0=成功；1=失败或拒绝。
 */
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = __dirname;
const DATA_DIR = process.env.WORKBENCH_DATA_DIR || path.resolve(APP_DIR, '..', 'data');
const BACKUP_ROOT = process.env.WORKBENCH_BACKUP_DIR || path.resolve(DATA_DIR, '..', 'backups');

const args = process.argv.slice(2);
function opt(name, dflt) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => args.includes(`--${n}`);
const FROM = opt('from', '');
const DATA = opt('data', '') || DATA_DIR;

function listDir(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{8}-\d{6}-/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function allBackups() {
  const out = listDir(BACKUP_ROOT).map((n) => ({ id: n, mtime: mtimeOf(path.join(BACKUP_ROOT, n)) }));
  for (const n of listDir(path.join(BACKUP_ROOT, 'auto'))) {
    out.push({ id: `auto/${n}`, mtime: mtimeOf(path.join(BACKUP_ROOT, 'auto', n)) });
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? -1 : 1));
}

function mtimeOf(p) {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return '';
  }
}

function running() {
  const pf = path.join(DATA, 'pids.json');
  if (fs.existsSync(pf)) return true;
  return fs.existsSync(path.join(DATA, 'web.lock'));
}

function copyOver(src, dest) {
  let n = 0;
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const s = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(s, r);
      } else if (e.isFile()) {
        const d = path.join(dest, r);
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
        n++;
      }
    }
  };
  walk(src, '');
  return n;
}

function main() {
  if (has('list')) {
    const all = allBackups();
    if (all.length === 0) {
      console.log('还没有任何备份。');
      return 0;
    }
    for (const b of all.reverse()) console.log(`${b.mtime}  ${b.id}`);
    return 0;
  }

  const all = allBackups();
  if (all.length === 0) {
    console.log('没有可恢复的备份。');
    return 1;
  }
  let pick;
  if (FROM) {
    pick = all.find((b) => b.id === FROM);
    if (!pick) {
      console.log(`找不到备份：${FROM}（用 --list 查看可用备份）`);
      return 1;
    }
  } else {
    // 默认取最近一次「全量」备份；没有全量时才退而用数据库快照
    pick = [...all].reverse().find((b) => b.id.includes('/') === false) || all[all.length - 1];
  }
  const src = path.join(BACKUP_ROOT, pick.id);

  if (running()) {
    console.log('工作台还在运行，已取消。请先退出工作台（点「停止工作台」）再恢复。');
    return 1;
  }

  // 先把现状存一份：恢复错了还能再退回来
  if (fs.existsSync(DATA)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const back = path.join(BACKUP_ROOT, `回滚前-${stamp}`);
    try {
      fs.mkdirSync(back, { recursive: true });
      copyOver(DATA, back);
      console.log(`当前数据已另存为：回滚前-${stamp}`);
    } catch (e) {
      console.log(`无法先备份当前数据（${e && e.message}），为安全起见已中止恢复。`);
      return 1;
    }
  }

  try {
    fs.mkdirSync(DATA, { recursive: true });
    const n = copyOver(src, DATA);
    console.log(`已从「${pick.id}」恢复 ${n} 个文件到数据目录。`);
    console.log('请重新启动工作台。');
    return 0;
  } catch (e) {
    console.log(`恢复失败：${e && e.message}`);
    return 1;
  }
}

try {
  process.exit(main());
} catch (e) {
  console.log(`异常：${e && e.message}`);
  process.exit(1);
}
