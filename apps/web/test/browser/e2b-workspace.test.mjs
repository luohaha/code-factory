import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

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

for (const locale of ['en', 'zh-CN']) {
  void test(`E2B workspaces can be created or attached without repository configuration (${locale})`, async (t) => {
    const context = await browser.newContext({ locale });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() {
          super();
          queueMicrotask(() => this.onopen?.(new Event('open')));
        }
        close() {}
      };
    });
    const writes = [];
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let body = { items: [] };
      let status = 200;
      if (path === '/api/workspace') body = { root: '/fixture', databasePath: '/fixture/data.sqlite', logFilePath: null };
      if (path === '/api/agent-models') body = { providers: [], refreshIntervalSeconds: 86_400 };
      if (path === '/api/sandboxes' && request.method() === 'POST') {
        const input = request.postDataJSON();
        writes.push(input);
        body = {
          id: 'sbx_created', name: input.name, kind: 'e2b', cwd: input.cwd ?? '/home/user/repo',
          providerSandboxId: input.providerSandboxId ?? 'new-remote-id', domain: input.domain,
          credentialRef: 'e2b_credential', credentialEnvVar: null, repositoryUrl: null,
          template: input.template ?? 'base', status: 'running', checkedAt: null, createdAt: new Date().toISOString(),
        };
        status = 201;
      }
      await route.fulfill({ status, json: body });
    });
    await page.goto(baseUrl);
    await page.locator('header').getByText('/fixture', { exact: true }).waitFor();
    const chinese = locale === 'zh-CN';
    await page.getByRole('button', { name: chinese ? '工作区' : 'Workspaces', exact: true }).click();
    await page.getByRole('button', { name: chinese ? '创建工作区' : 'Create workspace', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#execution-path-kind').selectOption('e2b');
    await dialog.locator('#execution-path-name').fill('Task sandbox');
    await dialog.locator('#execution-path-domain').fill('e2b.example');
    await dialog.locator('#execution-path-key').fill('test-key');
    await dialog.getByText(chinese ? 'Agent 可以根据任务需要克隆仓库并准备工具。' : 'The Agent can clone a repository and prepare tools when the task needs them.', { exact: true }).waitFor();
    await dialog.locator('summary').click();
    assert.equal(await dialog.locator('input[name="repositoryUrl"]').count(), 0);
    if (chinese) {
      await dialog.locator('input[name="providerSandboxId"]').fill('existing-remote-id');
      await dialog.locator('input[name="cwd"]').fill('/work/empty');
    }
    await dialog.getByRole('button', { name: chinese ? '创建' : 'Create', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(writes, [{ kind: 'e2b', name: 'Task sandbox', domain: 'e2b.example', apiKey: 'test-key',
      ...(chinese ? { providerSandboxId: 'existing-remote-id', cwd: '/work/empty' } : {}) }]);
  });
}
