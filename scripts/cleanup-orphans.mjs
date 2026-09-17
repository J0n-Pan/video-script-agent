import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// 清理早期提交失败留下的孤儿记录（无媒体、无执行尝试）
const orphans = await p.video.findMany({
  where: { status: 'UPLOADING', attempts: { none: {} } },
});
for (const v of orphans) {
  await p.video.delete({ where: { id: v.id } });
  console.log('removed orphan video', v.id, v.title);
}
console.log('cleaned', orphans.length);
await p.$disconnect();
