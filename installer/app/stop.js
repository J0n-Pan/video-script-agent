/**
 * 停掉本工作台拉起的进程（只关自己这套，不动电脑上其它 Node 程序）。
 *
 * 三层兜底，逐层收紧：
 *   ① 按数据目录里的 pids.json / web.lock 精确关 → 没退的用 taskkill /F /T 连子孙进程一起清
 *   ② 记录丢了/写坏了（孤儿实例）→ 按 web.lock 记的端口反查监听进程，再杀它的进程树
 *   ③ 只有确认「确实都停了」才删记录文件，否则留着给下一次调用重试
 *
 * ★ 为什么不再用 kill-nodes.ps1（2026-09-23 换掉）：
 *   那条路要 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File kill-nodes.ps1`，
 *   「绕过执行策略去跑一个磁盘上的脚本」是安全软件的典型启发式特征。而「按 PID 结束进程」
 *   用系统自带的 taskkill 就能做完（/T 连子孙进程一并结束），不需要任何脚本宿主。
 *   同一批改掉的还有卸载器里那段「写 VBS 到临时目录再隐藏执行」的自清理（已被 Defender
 *   判为 Program:Script/Wacapew.A!ml，见 dist/验收步骤-1.2.1.txt 的安全说明）。
 *
 * 被谁调用：停止工作台.vbs（编导点「停止」）、恢复最近备份.vbs（恢复前先停）、
 *           安装器升级前的 PrepareToInstall、卸载器 CurUninstallStepChanged。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = __dirname;
const DATA_DIR = process.env.WORKBENCH_DATA_DIR || path.resolve(APP_DIR, '..', 'data');
const pidFile = path.join(DATA_DIR, 'pids.json');
const lockFile = path.join(DATA_DIR, 'web.lock');
const DEFAULT_PORT = 3939;

/** 诊断痕迹：安装器/卸载器跑的时候编导看不到控制台，只能靠这个文件回看 */
function log(s) {
  try {
    fs.appendFileSync(
      path.join(DATA_DIR, 'stop.log'),
      `${new Date().toISOString()} ${s}\r\n`,
    );
  } catch {
    /* 数据目录不在或没权限：停进程本身不能因此不干活 */
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** PID 是否还活着。EPERM = 进程在但没权限管 → 按「活着」处理，交给强杀那步。 */
function alive(pid) {
  const n = Number(pid);
  if (!n || n === process.pid) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等这批 PID 全部退出，最多 timeoutMs */
async function waitAllGone(pids, timeoutMs) {
  const step = 200;
  for (let waited = 0; waited < timeoutMs; waited += step) {
    if (!pids.some(alive)) return true;
    await sleep(step);
  }
  return !pids.some(alive);
}

/**
 * 强杀整棵进程树。
 * taskkill 是 Windows 自带命令行工具（不涉及脚本宿主、不涉及执行策略）；
 * /T 把子孙进程一起结束 —— 这正是过去要靠「按可执行路径枚举 node.exe」才能达到的效果。
 */
function forceKill(pid, why) {
  const n = Number(pid);
  if (!n || n === process.pid) return;
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(n)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    log(`taskkill /F /T /PID ${n}（${why}）`);
  } catch {
    // 进程已经不在了（最常见），或权限不足：都不是错误，最终统一按「是否还活着」判定
  }
}

/** 按端口反查监听进程的 PID（netstat -ano，系统自带） */
function pidByPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    for (const line of out.split(/\r?\n/)) {
      const c = line.trim().split(/\s+/);
      // 列为：协议 本地地址 外部地址 状态 PID
      if (c.length >= 5 && c[3] === 'LISTENING' && c[1].endsWith(':' + port)) {
        return Number(c[4]) || 0;
      }
    }
  } catch {
    /* netstat 不可用就当兜底失效 */
  }
  return 0;
}

(async () => {
  const targets = new Set();
  const pids = readJson(pidFile);
  if (Array.isArray(pids)) for (const p of pids) targets.add(Number(p));
  const lock = readJson(lockFile);
  if (lock && lock.pid) targets.add(Number(lock.pid));
  targets.delete(0);
  targets.delete(process.pid);
  const list = [...targets];
  log(`已知 PID：${list.join(',') || '（无）'}`);

  // 先礼：请求正常退出（Windows 上等价于终止进程）
  for (const p of list) {
    try {
      process.kill(p);
    } catch {
      /* 已经退出了 */
    }
  }
  await waitAllGone(list, 5_000);

  // 后兵：还没退的连子孙进程一起强杀
  const survivors = list.filter(alive);
  if (survivors.length) {
    log(`5 秒内未退出，强杀进程树：${survivors.join(',')}`);
    for (const p of survivors) forceKill(p, '超时未退出');
    await waitAllGone(survivors, 5_000);
  }

  // ② 端口兜底：只有 web.lock 在（说明确实跑过一套）且端口仍被占时才动手，
  //    避免在没跑过工作台的机器上误伤恰好占用 3939 的其它程序。
  const port = lock && Number(lock.port) ? Number(lock.port) : DEFAULT_PORT;
  if (lock) {
    const holder = pidByPort(port);
    if (holder && holder !== process.pid && alive(holder)) {
      log(`端口 ${port} 仍被 PID ${holder} 占用，强杀其进程树`);
      forceKill(holder, `占用端口 ${port}`);
      await sleep(500);
      const still = pidByPort(port);
      if (still) log(`⚠️ 端口 ${port} 仍被 PID ${still} 占用`);
    }
  }

  // ③ 确认都停了才清记录；否则留着，让下一次调用（下次升级/卸载）还能重试
  const remaining = list.filter(alive);
  if (remaining.length === 0) {
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      /* ignore */
    }
    log('已全部停止');
  } else {
    log(`⚠️ 仍有进程未停下：${remaining.join(',')}（保留记录文件供下次重试）`);
  }

  console.log('stopped');
})();
