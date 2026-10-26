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
    const patches = [];
    let workspace = null;
    let variables = {};
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let body = { items: [] };
      let status = 200;
      if (path === '/api/workspace') body = { root: '/fixture', databasePath: '/fixture/data.sqlite', logFilePath: null };
      if (path === '/api/agent-models') body = { providers: [], refreshIntervalSeconds: 86_400 };
      if (path === '/api/sandboxes') body = { items: workspace ? [workspace] : [] };
      if (path === '/api/sandboxes' && request.method() === 'POST') {
        const input = request.postDataJSON();
        writes.push(input);
        variables = input.environmentVariables ?? {};
        workspace = {
          id: 'sbx_created', name: input.name, kind: 'e2b', cwd: null,
          providerSandboxId: input.providerSandboxId ?? 'new-remote-id', domain: input.domain || 'e2b.app',
          credentialRef: 'e2b_credential', credentialEnvVar: null, repositoryUrl: null,
          template: input.template ?? 'base', status: 'running', checkedAt: null, createdAt: new Date().toISOString(),
          environmentVariableNames: Object.keys(variables).sort(),
        };
        body = workspace;
        status = 201;
      }
      if (path === '/api/sandboxes/sbx_created' && request.method() === 'PATCH') {
        const input = request.postDataJSON();
        patches.push(input);
        for (const [name, value] of Object.entries(input.environmentVariables ?? {})) {
          if (value === null) delete variables[name];
          else variables[name] = value;
        }
        workspace = { ...workspace, name: input.name, domain: input.domain === undefined ? workspace.domain : input.domain || 'e2b.app',
          environmentVariableNames: Object.keys(variables).sort() };
        body = workspace;
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
    const domainHint = chinese ? '留空默认使用 e2b.app。' : 'Leave blank to use e2b.app.';
    await dialog.getByText(domainHint, { exact: true }).waitFor();
    assert.equal(await dialog.locator('#execution-path-domain').getAttribute('required'), null);
    if (chinese) await dialog.locator('#execution-path-domain').fill('e2b.example');
    await dialog.locator('#execution-path-key').fill('test-key');
    await dialog.getByText(chinese ? 'Agent 可以根据任务需要克隆仓库并准备工具。' : 'The Agent can clone a repository and prepare tools when the task needs them.', { exact: true }).waitFor();
    await dialog.locator('summary').click();
    assert.equal(await dialog.locator('input[name="repositoryUrl"]').count(), 0);
    assert.equal(await dialog.locator('input[name="cwd"]').count(), 0);
    const environmentHint = chinese
      ? '变量值保存后不再显示。更改将在下一条 Native RD 或 Reviewer 命令中生效，运行期间也可修改。已启动的命令和后台进程需重启才能使用新值。'
      : 'Values stay hidden after saving. Changes apply to the next Native RD or Reviewer command, even during a Run. Restart running commands and background processes to use new values.';
    await dialog.getByText(environmentHint, { exact: true }).waitFor();
    const addVariable = () => dialog.getByRole('button', { name: chinese ? '添加变量' : 'Add variable', exact: true }).click();
    const variableName = (index) => dialog.getByRole('textbox', { name: `${chinese ? '变量名' : 'Variable name'} ${index}`, exact: true });
    const variableValue = (index) => dialog.getByLabel(`${chinese ? '变量值' : 'Variable value'} ${index}`, { exact: true });
    await addVariable();
    await variableName(1).fill('GH_TOKEN');
    await variableValue(1).fill('browser-token');
    assert.equal(await variableValue(1).getAttribute('type'), 'password');
    await addVariable();
    await variableName(2).fill('CUSTOM');
    await variableValue(2).fill('original-value');
    if (chinese) {
      await dialog.locator('input[name="providerSandboxId"]').fill('existing-remote-id');
    }
    await dialog.getByRole('button', { name: chinese ? '创建' : 'Create', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(writes, [{ kind: 'e2b', name: 'Task sandbox', apiKey: 'test-key',
      environmentVariables: { GH_TOKEN: 'browser-token', CUSTOM: 'original-value' },
      ...(chinese ? { domain: 'e2b.example', providerSandboxId: 'existing-remote-id' } : {}) }]);
    assert.equal(workspace.domain, chinese ? 'e2b.example' : 'e2b.app');
    await page.getByRole('button', { name: /Task sandbox/ }).click();
    assert.equal((await dialog.innerText()).includes('browser-token'), false);
    const edit = async () => {
      await dialog.getByRole('button', { name: chinese ? '编辑工作区' : 'Edit workspace', exact: true }).click();
      await page.waitForFunction((domain) => document.querySelector('#edit-workspace-domain')?.value === domain, workspace.domain);
    };
    const save = () => dialog.getByRole('button', { name: chinese ? '保存修改' : 'Save changes', exact: true }).click();
    await edit();
    await dialog.getByText(domainHint, { exact: true }).waitFor();
    await dialog.getByText(environmentHint, { exact: true }).waitFor();
    assert.equal(await dialog.locator('input[name="cwd"]').count(), 0);
    assert.equal(await variableName(1).getAttribute('readonly'), '');
    assert.equal(await variableValue(1).inputValue(), '');
    assert.equal(await variableValue(2).inputValue(), '');
    await save();
    await dialog.getByRole('button', { name: chinese ? '编辑工作区' : 'Edit workspace', exact: true }).waitFor();
    assert.equal(patches[0].environmentVariables, undefined);
    assert.deepEqual(variables, { GH_TOKEN: 'browser-token', CUSTOM: 'original-value' });
    await edit();
    await dialog.getByRole('button', { name: `${chinese ? '移除变量' : 'Remove variable'} CUSTOM`, exact: true }).click();
    await variableValue(1).fill('rotated-browser-token');
    await addVariable();
    await variableName(2).fill('GH_TOKEN');
    await variableValue(2).fill('extra-value');
    await save();
    assert.equal(await variableName(2).evaluate((input) => input.checkValidity()), false);
    assert.equal(patches.length, 1);
    await variableName(2).fill('EXTRA');
    await save();
    await dialog.getByRole('button', { name: chinese ? '编辑工作区' : 'Edit workspace', exact: true }).waitFor();
    assert.deepEqual(patches[1].environmentVariables, { CUSTOM: null, GH_TOKEN: 'rotated-browser-token', EXTRA: 'extra-value' });
    assert.equal((await dialog.innerText()).includes('rotated-browser-token'), false);
    await edit();
    const domainInput = dialog.locator('#edit-workspace-domain');
    await domainInput.press('ControlOrMeta+A');
    await domainInput.press('Backspace');
    const waitForBlankDomain = () => page.waitForFunction(() => document.querySelector('#edit-workspace-domain')?.value === '');
    await waitForBlankDomain();
    for (const name of ['GH_TOKEN', 'EXTRA']) {
      await dialog.getByRole('button', { name: `${chinese ? '移除变量' : 'Remove variable'} ${name}`, exact: true }).click();
      await waitForBlankDomain();
    }
    await save();
    await dialog.getByRole('button', { name: chinese ? '编辑工作区' : 'Edit workspace', exact: true }).waitFor();
    assert.deepEqual(patches[2].environmentVariables, { EXTRA: null, GH_TOKEN: null });
    assert.equal(patches[2].domain, '');
    assert.equal(workspace.domain, 'e2b.app');
    assert.deepEqual(variables, {});
  });
}
