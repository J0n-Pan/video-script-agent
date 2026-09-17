import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const attempts = await p.attempt.findMany({ orderBy: { queueSeq: 'asc' } });
console.log('attempts:');
for (const a of attempts) {
  console.log(` seq=${a.queueSeq} status=${a.status} stage=${a.stage} kind=${a.kind} video=${a.videoId} err=${a.errorCode ?? '-'} ${a.errorMessage ?? ''}`);
}
const videos = await p.video.findMany({ include: { media: true, revisions: true, classification: true } });
console.log('\nvideos:');
for (const v of videos) {
  console.log(` id=${v.id} seq=${v.seq} status=${v.status} stage=${v.currentStage} title=${v.title} media=${v.media?.status ?? '-'} revs=${v.revisions.length} form=${v.classification?.category ?? '-'}`);
}
const usages = await p.modelUsage.findMany();
console.log('\nusages:', usages.length);
for (const u of usages) console.log(` ${u.capability} ${u.status} cost=${u.estimatedCost} in=${u.inputTokens} out=${u.outputTokens}`);
await p.$disconnect();
