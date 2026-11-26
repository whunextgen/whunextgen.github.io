// 按角色登录演示环境，逐页截图并存页面文字。用法：node crawl.mjs <输出目录> [角色...]
// 需要 playwright-core（npm i playwright-core）和本机 Playwright 缓存的 Chromium；演示环境先用 scripts/demo/server.mjs 启动
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'http://127.0.0.1:8788';
const OUT = process.argv[2];
const only = process.argv.slice(3);
const ROLES = {
  member:   { who: '许若溪', pages: ['/', '/path', '/iterate', '/select', '/council', '/members', '/biweekly', '/courses', '/tasks', '/requests', '/petty', '/resource', '/ask', '/agent', '/s-topic', '/projects'] },
  intern:   { who: '陆一帆', pages: ['/', '/path', '/select', '/iterate', '/biweekly'] },
  unit:     { who: '唐书言', pages: ['/', '/biweekly', '/projects', '/apply', '/select', '/iterate', '/members', '/requests'] },
  topic:    { who: '林知行', pages: ['/', '/projects', '/apply', '/plan', '/budget', '/iterate', '/council', '/members', '/s-topic', '/requests', '/petty', '/resource'] },
  finance:  { who: '何静', pages: ['/', '/center', '/s-fund', '/funds', '/cards', '/procure', '/school', '/staff', '/ledger', '/settle', '/plan', '/budget', '/caps', '/review', '/desk', '/requests', '/petty', '/s-topic', '/rules', '/track'] },
  hr:       { who: '苏晴', pages: ['/', '/people', '/staff', '/members', '/courses'] },
  chair:    { who: '沈可', pages: ['/', '/council', '/members', '/apply', '/iterate', '/tasks', '/courses'] },
  resource: { who: '韩立', pages: ['/', '/s-res', '/pool', '/stock', '/resource'] },
  director: { who: '周明远', pages: ['/', '/center', '/council', '/members', '/path', '/plan', '/budget', '/caps', '/review', '/admin', '/people', '/history', '/requests', '/s-topic', '/s-fund', '/naming'] },
};

const browser = await chromium.launch({ executablePath: path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing') });
const demo = await (await fetch(`${BASE}/demo`)).text();
const idOf = (name) => demo.match(new RegExp(`href="/demo/as/([0-9a-f-]{36})">${name}</a>`))?.[1];
for (const [role, r] of Object.entries(ROLES)) {
  if (only.length && !only.includes(role)) continue;
  const id = idOf(r.who); if (!id) { console.log('找不到', r.who); continue; }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/demo/as/${id}`);
  const dir = path.join(OUT, role); mkdirSync(dir, { recursive: true });
  let i = 0;
  for (const p of r.pages) {
    i += 1;
    await page.goto(`${BASE}/#${p}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(900);
    const name = `${String(i).padStart(2, '0')}${p === '/' ? '-home' : p.replace(/\//g, '-')}`;
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
    const text = await page.evaluate(() => (document.querySelector('main') ?? document.body).innerText);
    writeFileSync(path.join(dir, `${name}.txt`), text);
    console.log(role, name, text.length);
  }
  await ctx.close();
}
await browser.close();
