/**
 * 数字人适配器「零额度预检」：在真实账号上把创建页表单填一遍，**不点提交**。
 *
 * 为什么要单独有这个脚本：
 * 真实提交会消耗平台额度，而联调阶段真正反复要验证的是「页面选择器是否还和平台一致」。
 * 提交一次要花钱、还可能生成一条废作品；预检只走到「提交按钮是否可用」就退出，零成本。
 * 而且它和真提交共用同一份填表逻辑（adapter.prepareDraft），
 * 所以「预检通过」在逻辑上等价于「提交能走通」，不会出现两套逻辑各自为政。
 *
 * 用法：
 *   npm run avatar:smoke                        # 用配置里的默认形象/音色与内置样例文本
 *   npm run avatar:smoke -- --text-file=x.txt   # 用指定文本（例如某条编导稿的正文）
 *   npm run avatar:smoke -- --name=测试-预检-01
 *   AVATAR_HEADLESS=false npm run avatar:smoke  # 有头模式，肉眼看着它填
 *
 * 说明：预检不会写任何业务数据、不会落库、不会调平台生成接口。
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};

/** 样例文本：短、无违规内容、能证明文本框确实吃到了内容 */
const SAMPLE_TEXT = '这是一次数字人联调预检，用于确认页面选择器与表单填写是否仍然可用，本段文字不会提交到平台。';

async function main() {
  // 动态 import：cfg 在模块加载时读 env，所以 AVATAR_HEADLESS 之类的覆盖要在 import 之前生效
  const { cfg } = await import('../src/lib/config');
  const { HuweilaiAvatarAdapter } = await import('../src/lib/avatar/huweilai');

  const textFile = flag('text-file');
  let text = SAMPLE_TEXT;
  if (textFile) {
    if (!fs.existsSync(textFile)) {
      console.error(`文本文件不存在：${textFile}`);
      process.exit(1);
    }
    text = fs.readFileSync(textFile, 'utf8').trim();
  }

  const businessName = flag('name') ?? `预检-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;

  const adapter = new HuweilaiAvatarAdapter();

  console.log('=== 数字人适配器零额度预检（不提交）===');
  console.log(`平台：${cfg.avatar.baseUrl}${cfg.avatar.createPath}`);
  console.log(`会话：${cfg.avatar.storageState}`);
  console.log(`无头模式：${cfg.avatar.headless}｜形象：${cfg.avatar.avatarName}｜音色：${cfg.avatar.voiceName}`);
  console.log(`文本：${text.length} 字｜作品名：${businessName}`);
  console.log('');

  const login = await adapter.checkLogin();
  console.log(`${login.ok ? '✓' : '✗'} 会话检查：${login.message}`);
  if (!login.ok) {
    console.error('\n会话不可用，先跑 npm run avatar:login 扫码登录。');
    process.exit(1);
  }

  const assets = await adapter.resolveAssets().catch((e: unknown) => {
    console.error(`\n✗ 资产定位失败：${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (assets) {
    console.log(`✓ 资产定位：${assets.message}`);
    console.log(`    形象：${assets.avatar.raw}`);
    console.log(`    音色：${assets.voice.raw}`);
  }

  console.log('\n--- 表单预检（逐步骤）---');
  const r = await adapter.preflight({
    text,
    businessName,
    avatarName: cfg.avatar.avatarName,
    voiceName: cfg.avatar.voiceName,
    language: cfg.avatar.language,
    speed: cfg.avatar.speed,
    volume: cfg.avatar.volume,
    subtitle: cfg.avatar.subtitle,
    bgm: cfg.avatar.bgm,
  });

  for (const s of r.steps) console.log(`  ${s.ok ? '✓' : '✗'} ${s.name}：${s.detail}`);
  console.log('');
  console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
  console.log(`提交按钮可用：${r.submitEnabled ? '是（真提交可以走通）' : '否（还有必填项没填上，真提交会被拒绝）'}`);
  if (r.screenshotPath) console.log(`截图：${r.screenshotPath}`);
  if (!r.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error('预检异常：', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
