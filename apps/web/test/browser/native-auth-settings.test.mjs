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

async function fixture(t, locale) {
  const context = await browser.newContext({ locale });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  // Keep these form tests independent of SSE reconnect timing.
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() {}
    };
  });
  const profiles = [];
  const profileWrites = [];
  const configurationWrites = [];
  let failSave = false;
  const configuration = {
    path: null,
    values: {
      host: '127.0.0.1', port: 4310, allowedOrigin: null, openDashboard: false,
      databasePath: null, commitCoAuthorEnabled: true, jevApiKey: null,
      pullRequestReconcileIntervalSeconds: 30, cancelledRequirementRetentionDays: 7,
      doneRequirementRetentionDays: 365, attachmentRetentionDays: 30, logLevel: 'info', logFilePath: null,
      logMaxSize: '20m', logMaxFiles: '14d',
    },
    jevApiKeyConfigured: false, restartRequired: false, restartRequiredFields: [],
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = { items: [] };
    let status = 200;
    if (path === '/api/workspace') body = { root: '/fixture', databasePath: '/fixture/data.sqlite', logFilePath: null };
    if (path === '/api/agent-models') body = { providers: [], refreshIntervalSeconds: 86_400 };
    if (path === '/api/configuration') {
      if (request.method() === 'PATCH') {
        const patch = request.postDataJSON();
        configurationWrites.push(patch);
        Object.assign(configuration.values, patch);
      }
      body = configuration;
    }
    if (path === '/api/native-auth') body = { items: profiles };
    if (path.startsWith('/api/native-auth/profiles')) {
      const input = request.postDataJSON();
      profileWrites.push({ method: request.method(), input });
      if (failSave) {
        status = 400;
        body = { error: 'Profile save failed' };
      } else {
        const { apiKey: _apiKey, ...metadata } = input;
        body = { ...metadata, id: input.id ?? `profile-${profiles.length + 1}` };
        const index = profiles.findIndex((item) => item.id === body.id);
        if (index < 0) profiles.push(body);
        else profiles[index] = body;
        status = request.method() === 'POST' ? 201 : 200;
      }
    }
    await route.fulfill({ status, json: body });
  });
  await page.goto(baseUrl);
  const name = locale === 'zh-CN' ? 'Agent Manager 配置' : 'Agent Manager configuration';
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  const saveName = locale === 'zh-CN' ? '保存' : 'Save';
  return {
    page, dialog, profiles, profileWrites, configurationWrites,
    failNextSave: () => { failSave = true; },
    allowSave: () => { failSave = false; },
    add: () => dialog.getByRole('button', { name: locale === 'zh-CN' ? '新增配置项' : 'Add item', exact: true }).click(),
    profileSave: () => dialog.getByRole('button', { name: saveName, exact: true }).first().click(),
    managerSave: () => dialog.getByRole('button', { name: saveName, exact: true }).last().click(),
  };
}

for (const locale of ['en', 'zh-CN']) {
  void test(`attachment retention defaults to 30 days and saves in settings (${locale})`, async (t) => {
    const f = await fixture(t, locale);
    const input = f.dialog.getByRole('spinbutton', { name: locale === 'zh-CN' ? '附件保留周期（天）' : 'Attachment retention (days)', exact: true });
    assert.equal(await input.inputValue(), '30');
    await input.fill('45');
    const request = f.page.waitForRequest((request) => request.method() === 'PATCH'
      && new URL(request.url()).pathname === '/api/configuration');
    await f.managerSave();
    assert.equal((await request).postDataJSON().attachmentRetentionDays, 45);
    await f.dialog.waitFor({ state: 'hidden' });
  });

  void test(`Native API profile saves stay inside the configuration dialog (${locale})`, async (t) => {
    const f = await fixture(t, locale);
    const { page, dialog } = f;
    await f.add();
    // Invalid Manager settings must not block saving an independent profile.
    await page.locator('#configuration-port').fill('0');
    await page.locator('#native-api-key').fill('test-key');
    await page.locator('#native-model-name').fill('first-model');
    await f.profileSave();
    await dialog.getByText('first-model', { exact: false }).waitFor();
    assert.equal(await dialog.isVisible(), true);
    assert.equal(f.profileWrites.length, 1);
    assert.equal(f.profileWrites[0].method, 'POST');
    assert.equal(f.profileWrites[0].input.apiKey, 'test-key');
    assert.deepEqual(f.configurationWrites, []);

    await dialog.getByRole('button', { name: locale === 'zh-CN' ? '编辑' : 'Edit', exact: true }).click();
    await page.locator('#native-model-name').fill('updated-model');
    await page.locator('#native-model-name').press('Enter');
    await dialog.getByText('updated-model', { exact: false }).waitFor();
    assert.equal(f.profileWrites[1].method, 'PUT');
    assert.equal(Object.hasOwn(f.profileWrites[1].input, 'apiKey'), false);
    assert.deepEqual(f.configurationWrites, []);

    await f.add();
    await page.locator('#native-api-format').selectOption('anthropic');
    await page.locator('#native-api-key').fill('another-key');
    await page.locator('#native-model-name').fill('second-model');
    await page.locator('#native-model-name').press('Enter');
    await dialog.getByText('second-model', { exact: false }).waitFor();
    assert.equal(f.profileWrites[2].input.format, 'anthropic');
    assert.equal(f.profileWrites[2].input.baseUrl, 'https://api.anthropic.com');
    assert.equal(f.profiles.length, 2);
    assert.deepEqual(f.configurationWrites, []);

    // An incomplete profile must not block the Manager's separate save.
    await f.add();
    await page.locator('#configuration-port').fill('4311');
    await f.managerSave();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(f.configurationWrites, [{ port: 4311 }]);
    assert.equal(f.profileWrites.length, 3);
  });
}

void test('Native API profile errors remain visible and allow retry', async (t) => {
  const f = await fixture(t, 'en');
  await f.add();
  await f.page.locator('#native-api-key').fill('test-key');
  await f.page.locator('#native-model-name').fill('retry-model');
  f.failNextSave();
  await f.profileSave();
  await f.dialog.getByText('Profile save failed', { exact: true }).waitFor();
  assert.equal(await f.page.locator('#native-api-key').inputValue(), 'test-key');
  assert.deepEqual(f.configurationWrites, []);
  f.allowSave();
  await f.profileSave();
  await f.dialog.getByText('retry-model', { exact: false }).waitFor();
  assert.equal(f.profiles.length, 1);
  assert.equal(await f.dialog.isVisible(), true);
});

void test('Manager settings keep browser validation and Enter submission', async (t) => {
  const f = await fixture(t, 'en');
  const port = f.page.locator('#configuration-port');
  await port.fill('0');
  await f.managerSave();
  assert.equal(await port.evaluate((input) => input.validity.rangeUnderflow), true);
  assert.deepEqual(f.configurationWrites, []);
  assert.equal(await f.dialog.isVisible(), true);
  await port.fill('4311');
  await port.press('Enter');
  await f.dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(f.configurationWrites, [{ port: 4311 }]);
});
