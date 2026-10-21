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
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
}, { timeout: 120_000 });
after(async () => { await browser?.close(); await server?.close(); });

for (const locale of ['en', 'zh-CN']) {
  void test(`create local Docker Requirements for every provider and disable Docker with E2B (${locale})`, async (t) => {
    const context = await browser.newContext({ locale, viewport: { width: locale === 'en' ? 1280 : 390, height: 844 } });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const data = detailFixture();
    const writes = [];
    const sandboxes = [
      { id: 'local', name: 'Default workspace', kind: 'local', cwd: '/demo' },
      { id: 'remote', name: 'Cloud', kind: 'e2b', cwd: null },
    ];
    await page.addInitScript(() => { window.EventSource = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
      close() {}
    }; });
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let body = data.reply(path);
      if (path === '/api/sandboxes') body = { items: sandboxes };
      if (path === '/api/native-auth') body = { items: [{ id: 'demo', format: 'openai', baseUrl: 'https://example.test/v1', modelName: 'demo-model' }] };
      if (path === '/api/requirements' && request.method() === 'POST') {
        const input = request.postDataJSON();
        writes.push(input);
        Object.assign(data.requirement, input, { status: 'todo', session: { ...data.requirement.session, provider: input.provider, state: 'idle' } });
        body = data.requirement;
      }
      await route.fulfill({ json: body });
    });
    await page.goto(baseUrl);
    const zh = locale === 'zh-CN';
    for (const provider of ['codex', 'claude-code', 'native-agent']) {
      await page.getByRole('button', { name: zh ? '新建需求' : 'New requirement', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: zh ? '创建需求与 RD 会话' : 'Create a requirement and RD Session', exact: true });
      await dialog.locator('#requirement-title').fill('Docker work');
      await dialog.locator('#requirement-description').fill('Bound resources');
      await dialog.locator('#requirement-provider').selectOption(provider);
      if (provider === 'native-agent') await dialog.locator('#requirement-model').selectOption('profile:demo');
      await dialog.getByLabel(zh ? '资源隔离' : 'Resource isolation', { exact: true }).selectOption('docker');
      await dialog.getByLabel(zh ? 'CPU 核数' : 'CPU cores', { exact: true }).fill('1.5');
      await dialog.getByLabel(zh ? '内存（MiB）' : 'Memory (MiB)', { exact: true }).fill('2048');
      assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
      await dialog.getByRole('button', { name: zh ? '创建' : 'Create', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(writes.at(-1).provider, provider);
      assert.deepEqual(writes.at(-1).docker, { image: 'code-factory-agent:local', cpus: 1.5, memoryMb: 2048 });
      await page.locator('[data-slot="sheet-close"]').click();
      await page.locator('[data-slot="sheet-content"]').waitFor({ state: 'hidden' });
    }
    await page.getByRole('button', { name: zh ? '新建需求' : 'New requirement', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: zh ? '创建需求与 RD 会话' : 'Create a requirement and RD Session', exact: true });
    await dialog.locator('#requirement-title').fill('Cloud work');
    await dialog.locator('#requirement-description').fill('Remote environment');
    await dialog.locator('#requirement-provider').selectOption('native-agent');
    await dialog.locator('#requirement-model').selectOption('profile:demo');
    const isolation = dialog.getByLabel(zh ? '资源隔离' : 'Resource isolation', { exact: true });
    await isolation.selectOption('docker');
    await dialog.locator('#requirement-sandbox').selectOption('remote');
    assert.equal(await isolation.isDisabled(), true);
    assert.equal(await dialog.locator('#requirement-docker-cpus').count(), 0);
    await dialog.getByRole('button', { name: zh ? '创建' : 'Create', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.at(-1).sandboxId, 'remote');
    assert.equal(writes.at(-1).docker, null);
  });
}
