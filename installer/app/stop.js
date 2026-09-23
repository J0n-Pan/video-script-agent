/** 停掉本工作台拉起的进程（按数据目录里的 PID 记录精确关闭，不动其它 Node 程序） */
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = __dirname;
const DATA_DIR = process.env.WORKBENCH_DATA_DIR || path.resolve(APP_DIR, '..', 'data');
const pidFile = path.join(DATA_DIR, 'pids.json');

function kill(pid) {
  try {
    process.kill(Number(pid));
  } catch {
    /* 已经退出了 */
  }
}

try {
  if (fs.existsSync(pidFile)) {
    const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    for (const p of pids) kill(p);
    fs.rmSync(pidFile, { force: true });
  }
} catch {
  /* ignore */
}
console.log('stopped');
