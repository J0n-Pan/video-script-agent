import fs from 'node:fs';
import path from 'node:path';

/**
 * 独立进程（解析进程、自检脚本）不会像 Next.js 那样自动读取 .env。
 * 这里手动加载，避免「改了 .env 但只有网页生效、解析进程仍用默认值」这类静默不一致。
 *
 * 优先级与 Next.js 保持一致：已存在的进程环境变量优先，不被文件覆盖。
 */
let loaded = false;

export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let val = line.slice(eq + 1).trim();

    // 去掉行尾注释：只在「空白 + #」时截断，避免误伤值里本身就含 # 的情况
    const hash = val.search(/\s#/);
    if (hash >= 0) val = val.slice(0, hash).trim();

    if (val.length >= 2) {
      const a = val[0];
      const b = val[val.length - 1];
      if ((a === '"' && b === '"') || (a === "'" && b === "'")) val = val.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = val;
  }
}
