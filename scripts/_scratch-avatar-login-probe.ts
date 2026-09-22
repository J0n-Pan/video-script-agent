/**
 * 一次性探针：无会话打开鲲之益登录页，dump 表单结构（只读，不提交任何东西）。
 * 用途：确认「账号密码登录」自动化的可行性 —— 有没有图形验证码 / 短信验证码。
 */
import { loadPlaywright } from '../src/lib/sources/muse-browser';
import { cfg } from '../src/lib/config';

async function main() {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('playwright 不可用');
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();
  const target = new URL(cfg.avatar.createPath, cfg.avatar.baseUrl).toString();
  console.log('目标:', target);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(6000);
  console.log('最终 URL:', page.url());

  const info = await page.evaluate(`(() => {
    const dump = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.type ?? '',
      name: el.name ?? '',
      id: el.id ?? '',
      placeholder: el.placeholder ?? '',
      text: (el.textContent ?? '').trim().slice(0, 40),
      visible: !!el.offsetParent,
    });
    const inputs = [...document.querySelectorAll('input')].map(dump);
    const buttons = [...document.querySelectorAll('button')].map(dump);
    const tabs = [...document.querySelectorAll('[role="tab"], .ant-tabs-tab, [class*="tab"]')]
      .map((el) => (el.textContent ?? '').trim().slice(0, 30))
      .filter(Boolean);
    const captchaHints = [...document.querySelectorAll('[class*="captcha" i], [class*="verify" i], [class*="code" i], img[src*="captcha" i]')]
      .map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className ?? '').slice(0, 80), src: (el.src ?? '').slice(0, 100) }));
    return {
      title: document.title,
      url: location.href,
      hasLocalStorageToken: !!localStorage.getItem('token'),
      inputs,
      buttons,
      tabs,
      captchaHints,
      bodySnippet: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 600),
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: '_scratch/avatar-login-probe.png', fullPage: true });
  await browser.close();
}

main().catch((e) => {
  console.error('探针失败:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
