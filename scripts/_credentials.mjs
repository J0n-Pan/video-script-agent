/**
 * 验收 / 调试脚本共用的登录凭据。
 *
 * 口令不写死在仓库里：优先读环境变量，其次读项目根的 `.env`
 * （手写解析，不引入 dotenv 依赖）。三处变量名与 `prisma/seed.ts` 完全一致，
 * 保证「种子脚本建的账号」与「验收脚本登录的账号」永远同源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fromEnvFile(key) {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#') || !line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') || undefined;
    }
  } catch {
    /* .env 不存在时静默降级到环境变量 */
  }
  return undefined;
}

const warned = new Set();

function passwordFor(key) {
  const v = process.env[key] ?? fromEnvFile(key);
  if (!v) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[credentials] 未找到 ${key}（环境变量与 .env 都没有），登录会失败 —— 见 README 3.1`);
    }
    return '';
  }
  return v;
}

export const creds = {
  editor: { username: 'editor', password: passwordFor('SEED_EDITOR_PASSWORD') },
  editor2: { username: 'editor2', password: passwordFor('SEED_EDITOR2_PASSWORD') },
  maintainer: { username: 'maintainer', password: passwordFor('SEED_MAINTAINER_PASSWORD') },
};
