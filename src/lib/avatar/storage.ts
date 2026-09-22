// 数字人成品的本地存储（2026-09-22）。
//
// 为什么单独开一个模块：
//   §7.5 要求成品**持久化到本地**，不只依赖平台那个可能过期的 OSS 链接。
//   而「存到哪儿」是会变的东西 —— 目前是 `AVATAR_VIDEO_DIR`（默认 data/avatars），
//   以后可能改成某个网盘同步目录、某个素材盘。
//   所以路径拼装**只允许在 resolveAssetPath() 里做一次**，
//   业务层（service.ts）与适配器都不许再自己拼一遍，否则改路径时一定会漏。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';

/**
 * 成品在本机的落盘路径。**这是「本地保存路径」的唯一接口点。**
 *
 * 换保存位置只需两步：改 `AVATAR_VIDEO_DIR`（或这里），其余代码不动。
 * 用业务唯一名当文件名：它不含路径分隔符与 Windows 保留字符
 * （形状固定为 `VSA-<revId尾6>-r<修订号>-<时间戳>`），天然可安全落盘，
 * 而且和平台作品名对得上，人工排查时一眼能找到。
 */
export function resolveAssetPath(businessName: string): string {
  return path.join(cfg.avatar.videoDir, `${businessName}.mp4`);
}

/**
 * 流式计算文件 sha256。
 *
 * 为什么不用 `crypto.createHash().update(fs.readFileSync(f))`：
 * 2026-09-21 实测一条 73 秒的成片就有 **243MB**，readFileSync 会把它整块读进内存；
 * 加上下载端原来的 `arrayBuffer()`，同一条片子的峰值内存接近 500MB。长片必然出问题。
 * 分块喂 hash 的峰值只跟块大小有关。
 */
export function sha256OfFile(filePath: string, chunkSize = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath, { highWaterMark: chunkSize });
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 成品持久化目录是否可用（父目录能建出来就能写） */
export function ensureAssetDir(): void {
  fs.mkdirSync(cfg.avatar.videoDir, { recursive: true });
}
