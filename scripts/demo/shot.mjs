// 单步截图：以某个演示账号登录，打开页面，依次点击若干按钮或链接（按可见文字），截图。演示环境须已在 127.0.0.1:8788 运行。
// 需要 playwright-core（npm i playwright-core）和本机 Playwright 缓存的 Chromium；演示环境先用 scripts/demo/server.mjs 启动
// 用法：node shot.mjs <账号名> <路由，如 /requests> <输出.png> [点击文字1] [点击文字2] ...
//   点击文字以 "fill:标签=值" 开头的，在对话框里按标签填写；以 "scroll:文字" 开头的，滚动到含该文字的元素；
//   以 "full" 为最后一个参数时截整页。截图前会把页面文字写到同名 .txt。
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'http://127.0.0.1:8788';
const [who, route, out, ...steps] = process.argv.slice(2);
const full = steps[steps.length - 1] === 'full'; if (full) steps.pop();
const browser = await chromium.launch({ executablePath: path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing') });
try {
  const demo = await (await fetch(`${BASE}/demo`)).text();
  const id = demo.match(new RegExp(`href="/demo/as/([0-9a-f-]{36})">${who}</a>`))?.[1];
  if (!id) throw new Error(`演示账号里没有 ${who}`);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/demo/as/${id}`);
  await page.goto(`${BASE}/#${route}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(800);
  for (const s of steps) {
    if (s.startsWith('fill:')) {
      const [label, value] = s.slice(5).split('=');
      const field = page.locator('dialog[open] label', { hasText: label }).first();
      const input = field.locator('input, textarea, select').first();
      if (await input.evaluate((e) => e.tagName) === 'SELECT') await input.selectOption({ label: value }).catch(() => input.selectOption(value));
      else await input.fill(value);
    } else if (s.startsWith('scroll:')) {
      await page.getByText(s.slice(7), { exact: false }).first().scrollIntoViewIfNeeded();
    } else {
      const scope = (await page.locator('dialog[open]').count()) ? page.locator('dialog[open]') : page;
      const target = scope.getByRole('button', { name: s, exact: false }).or(scope.getByRole('link', { name: s, exact: false })).or(scope.getByRole('tab', { name: s, exact: false })).first();
      await target.scrollIntoViewIfNeeded();
      await target.click();
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(600);
  }
  const text = await page.evaluate(() => (document.querySelector('dialog[open]') ?? document.querySelector('main') ?? document.body).innerText);
  writeFileSync(out.replace(/\.png$/, '.txt'), text);
  await page.screenshot({ path: out, fullPage: full });
  console.log('已截图', out);
} catch (e) {
  console.log('失败：', e.message.split('\n')[0]);
  process.exitCode = 1;
} finally { await browser.close(); }
