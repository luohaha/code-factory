import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { detailFixture } from './fixtures/requirement-detail.mjs';

let server;
let browser;
let baseUrl;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
}, { timeout: 120_000 });

after(async () => {
  await browser?.close();
  await server?.close();
});

const views = [
  ['Requirements', '需求', 'Requirement workflow', '需求工作流'],
  ['Sessions', '会话', 'RD Agent Sessions', 'RD Agent 会话'],
  ['Relationships', '关系', 'Requirement relationships', '需求关系'],
  ['PR', 'PR', 'Pull Requests', 'Pull Request'],
  ['Workspaces', '工作区', 'Workspaces', '工作区'],
  ['Timers', '定时', 'Scheduled wake-ups', '定时唤醒'],
  ['Requirements', '需求', 'Requirement workflow', '需求工作流'],
];

for (const locale of ['en', 'zh-CN']) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
    void test(`dashboard navigation and tools remain clickable (${locale}, ${viewport.width}px)`, async (t) => {
      const mobile = viewport.width < 768;
      const context = await browser.newContext({ locale, viewport, isMobile: mobile, hasTouch: mobile });
      t.after(() => context.close());
      context.setDefaultTimeout(10_000);
      await context.addInitScript(() => {
        window.EventSource = class extends EventTarget {
          constructor() {
            super();
            queueMicrotask(() => this.onopen?.(new Event('open')));
          }
          close() {}
        };
      });
      const data = detailFixture();
      await context.route('**/api/**', (route) => route.fulfill({ json: data.reply(new URL(route.request().url()).pathname) }));
      const page = await context.newPage();
      await page.goto(baseUrl);
      await page.getByRole('heading', { name: data.requirement.title, exact: true }).waitFor();

      const chinese = locale === 'zh-CN';
      const navigation = page.getByRole('navigation', { name: chinese ? '主导航' : 'Main navigation', exact: true });
      for (const [englishButton, chineseButton, englishTitle, chineseTitle] of views) {
        await navigation.getByRole('button', { name: chinese ? chineseButton : englishButton, exact: true }).click();
        await page.getByRole('heading', { name: chinese ? chineseTitle : englishTitle, exact: true }).waitFor();
      }

      const header = page.locator('main > header');
      const bounds = await header.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const button of await header.getByRole('button').all()) {
        if (await button.evaluate((element) => Boolean(element.closest('nav')))) continue;
        const box = await button.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, await button.innerText());
        assert.ok(box.y >= 0 && box.y + box.height <= bounds.y + bounds.height);
        if (await button.isEnabled()) {
          assert.equal(await button.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          }), true, `Toolbar button is covered: ${await button.getAttribute('aria-label') ?? await button.innerText()}`);
        }
      }

      await header.getByRole('button', { name: chinese ? 'Agent Manager 配置' : 'Agent Manager configuration', exact: true }).click();
      await page.getByRole('dialog').getByRole('heading', { name: chinese ? 'Agent Manager 配置' : 'Agent Manager configuration', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await header.getByRole('button', { name: chinese ? '新建需求' : 'New requirement', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });

      await header.getByRole('button', { name: chinese ? '切换语言' : 'Switch language', exact: true }).click();
      const switchedNavigation = page.getByRole('navigation', { name: chinese ? 'Main navigation' : '主导航', exact: true });
      for (const [englishButton, chineseButton, englishTitle, chineseTitle] of views.slice(0, 2)) {
        const button = switchedNavigation.getByRole('button', { name: chinese ? englishButton : chineseButton, exact: true });
        if (mobile) await button.tap();
        else await button.click();
        await page.getByRole('heading', { name: chinese ? englishTitle : chineseTitle, exact: true }).waitFor();
      }
    });
  }
}
