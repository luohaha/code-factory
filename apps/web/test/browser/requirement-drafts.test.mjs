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

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6DigAAAAASUVORK5CYII=', 'base64');
const imageFile = { name: 'draft.png', mimeType: 'image/png', buffer: imageBytes };
const textFile = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsent attachment contents') };

function requirement(id, status) {
  const now = new Date().toISOString();
  return {
    id, title: `Draft ${id}`, description: 'Draft fixture', status, provider: 'codex',
    model: null, reasoningEffort: null, sandboxId: null, createdBy: 'human',
    parentRequirementId: null, sourceSessionId: null, createdAt: now, updatedAt: now, completedAt: null,
    session: {
      id: `ses_${id}`, requirementId: id, provider: 'codex', nativeSessionId: null,
      state: status === 'todo' ? 'idle' : 'waiting_human', lastError: null,
      lastConsumedMessageSequence: 0, pendingMessageCount: 0, queuedMessageCount: 0,
      autoResumePaused: false, createdAt: now, updatedAt: now,
    },
  };
}

async function fixture(t, { locale = 'en', status = 'waiting_confirmation', storageFailure = null } = {}) {
  const context = await browser.newContext({ locale });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.addInitScript((failure) => {
    window.EventSource = class extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() {}
    };
    if (failure === 'open') {
      IDBFactory.prototype.open = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    } else if (failure === 'write') {
      IDBObjectStore.prototype.put = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
    }
  }, storageFailure);
  const requirements = [requirement('req_first', status), requirement('req_second', status)];
  const uploads = [];
  const sends = [];
  let failUpload = false;
  let failSend = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = { items: [] };
    let responseStatus = 200;
    if (path === '/api/workspace') body = { root: '/fixture', databasePath: '/fixture/data.sqlite', logFilePath: null };
    if (path === '/api/agent-models') body = { providers: [], refreshIntervalSeconds: 86_400 };
    if (path === '/api/requirements') body = { items: requirements };
    if (path.endsWith('/messages')) body = { items: [], hasMore: false };
    const target = requirements.find((item) => path.startsWith(`/api/requirements/${item.id}/`));
    if (target && path.endsWith('/attachments')) {
      uploads.push({ name: decodeURIComponent(request.headers()['x-file-name']), type: request.headers()['content-type'], bytes: request.postDataBuffer() });
      body = { id: `att_${uploads.length}` };
      if (failUpload) { responseStatus = 500; body = { error: 'Upload failed' }; }
    }
    if (target && /\/(start|reply)$/.test(path)) {
      const input = request.postDataJSON();
      sends.push({ path, input });
      body = {
        accepted: true, queued: false, requirementId: target.id, action: 'start', requirement: target, run: null,
        message: {
          id: `msg_${sends.length}`, requirementId: target.id, sessionId: target.session.id,
          runId: null, sourceRequirementId: null, author: 'human', body: input.message ?? '',
          attachments: [], sequence: sends.length, deliverToRd: true, createdAt: new Date().toISOString(),
        },
      };
      if (failSend) { responseStatus = 500; body = { error: 'Send failed' }; }
    }
    await route.fulfill({ status: responseStatus, json: body });
  });
  await page.goto(baseUrl);
  const inputName = locale === 'zh-CN' ? '回复 RD Agent' : 'Reply to RD Agent';
  const dialog = page.getByRole('dialog');
  const editor = dialog.getByRole('textbox', { name: inputName, exact: true });
  return {
    page, context, dialog, editor, uploads, sends,
    files: dialog.locator('input[type=file]'),
    send: () => dialog.getByRole('button', { name: locale === 'zh-CN' ? '发送回复' : 'Send reply', exact: true }).click(),
    open: async (id = 'req_first') => {
      await page.getByRole('button', { name: `Draft ${id} Draft fixture`, exact: true }).click();
      await editor.waitFor();
      await page.waitForFunction((label) => document.querySelector(`textarea[aria-label="${label}"]`)?.disabled === false, inputName);
    },
    close: async () => {
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    },
    remove: (name) => dialog.getByRole('button', { name: locale === 'zh-CN' ? `移除 ${name}` : `Remove ${name}`, exact: true }),
    failUpload: (value) => { failUpload = value; },
    failSend: (value) => { failSend = value; },
  };
}

async function saved(page, message, count) {
  await page.waitForFunction(async ({ message, count }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('code-factory.requirement-drafts', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return message === null ? records.length === 0 : records.some((draft) => draft.message === message && draft.attachmentIds.length === count);
  }, { message, count });
}

for (const locale of ['en', 'zh-CN']) {
  void test(`Conversation text and files survive reopening, switching and reload (${locale})`, async (t) => {
    const f = await fixture(t, { locale });
    await f.open();
    await f.editor.fill('  First draft\nwith a second line  ');
    await f.files.setInputFiles([textFile, imageFile]);
    await f.page.getByRole('img', { name: 'draft.png', exact: true }).waitFor();
    const firstPreview = await f.page.getByRole('img', { name: 'draft.png', exact: true }).getAttribute('src');
    await f.close();
    await f.open('req_second');
    assert.equal(await f.editor.inputValue(), '');
    assert.equal(await f.remove('notes.txt').count(), 0);
    await f.editor.fill('Second requirement draft');
    await f.close();
    await f.open();
    assert.equal(await f.editor.inputValue(), '  First draft\nwith a second line  ');
    await f.remove('notes.txt').waitFor();
    const image = f.page.getByRole('img', { name: 'draft.png', exact: true });
    assert.notEqual(await image.getAttribute('src'), firstPreview);
    assert.equal(await f.page.evaluate(async (url) => fetch(url).then(() => false, () => true), firstPreview), true);
    await saved(f.page, '  First draft\nwith a second line  ', 2);
    await f.page.reload();
    await f.open();
    assert.equal(await f.editor.inputValue(), '  First draft\nwith a second line  ');
    await f.remove('notes.txt').waitFor();
    await f.page.waitForFunction(() => document.querySelector('img[alt="draft.png"]')?.naturalWidth === 1);
    await f.remove('notes.txt').click();
    await saved(f.page, '  First draft\nwith a second line  ', 1);
    await f.page.reload();
    await f.open();
    assert.equal(await f.remove('notes.txt').count(), 0);
    await f.remove('draft.png').waitFor();
    assert.equal(f.uploads.length, 0);
    await f.close();
    await f.open('req_second');
    assert.equal(await f.editor.inputValue(), 'Second requirement draft');
  });
}

for (const status of ['todo', 'waiting_confirmation']) {
  void test(`Upload/send failure retains drafts; successful ${status === 'todo' ? 'start' : 'reply'} clears them`, async (t) => {
    const f = await fixture(t, { status });
    await f.open();
    await f.editor.fill(' Retry this draft ');
    await f.files.setInputFiles([textFile, imageFile]);
    f.failUpload(true);
    await f.send();
    await f.page.getByText('Upload failed', { exact: false }).waitFor();
    await f.close();
    await f.open();
    assert.equal(await f.editor.inputValue(), ' Retry this draft ');
    await f.remove('notes.txt').waitFor();
    assert.equal(f.sends.length, 0);
    f.failUpload(false);
    f.failSend(true);
    await f.send();
    await f.page.getByText('Send failed', { exact: false }).waitFor();
    await saved(f.page, ' Retry this draft ', 2);
    await f.page.reload();
    await f.open();
    assert.equal(await f.editor.inputValue(), ' Retry this draft ');
    await f.remove('draft.png').waitFor();
    f.failSend(false);
    await f.send();
    await f.page.waitForFunction(() => document.querySelector('textarea[aria-label="Reply to RD Agent"]')?.value === '');
    assert.deepEqual(f.uploads.slice(-2).sort((left, right) => left.name.localeCompare(right.name)), [
      { name: 'draft.png', type: 'image/png', bytes: imageBytes },
      { name: 'notes.txt', type: 'text/plain', bytes: textFile.buffer },
    ]);
    assert.equal(f.sends.at(-1).path.endsWith(status === 'todo' ? '/start' : '/reply'), true);
    assert.equal(f.sends.at(-1).input.message, 'Retry this draft');
    assert.equal(f.sends.at(-1).input.attachmentIds.length, 2);
    await saved(f.page, null);
    await f.page.reload();
    await f.open();
    assert.equal(await f.editor.inputValue(), '');
    assert.equal(await f.remove('notes.txt').count(), 0);
    assert.equal(await f.remove('draft.png').count(), 0);
  });
}

void test('Drafts are isolated by Manager address and clearing the editor persists', async (t) => {
  const f = await fixture(t);
  await f.open();
  await f.editor.fill('Original Manager draft');
  await saved(f.page, 'Original Manager draft', 0);
  await f.page.evaluate(() => localStorage.setItem('code-factory.agent-manager-url', 'http://localhost:4311'));
  await f.page.reload();
  await f.open();
  assert.equal(await f.editor.inputValue(), '');
  await f.editor.fill('Other Manager draft');
  await saved(f.page, 'Other Manager draft', 0);
  await f.page.evaluate((url) => localStorage.setItem('code-factory.agent-manager-url', `${url}/`), baseUrl.replace(/\/$/, ''));
  await f.page.reload();
  await f.open();
  assert.equal(await f.editor.inputValue(), 'Original Manager draft');
  await f.editor.fill('');
  await f.files.setInputFiles(textFile);
  await saved(f.page, '', 1);
  await f.page.reload();
  await f.open();
  assert.equal(await f.editor.inputValue(), '');
  await f.remove('notes.txt').click();
  await f.close();
  await f.open();
  assert.equal(await f.remove('notes.txt').count(), 0);
});

for (const storageFailure of ['open', 'write']) {
  void test(`Unavailable browser storage preserves drafts in the tab (${storageFailure})`, async (t) => {
    const f = await fixture(t, { storageFailure });
    await f.open();
    await f.editor.fill('Fallback draft');
    await f.files.setInputFiles(textFile);
    await f.dialog.getByText('Browser storage is unavailable. This draft is kept only until this tab closes or reloads.', { exact: true }).waitFor();
    await f.close();
    await f.open();
    assert.equal(await f.editor.inputValue(), 'Fallback draft');
    await f.remove('notes.txt').waitFor();
    await f.send();
    await f.page.waitForFunction(() => document.querySelector('textarea[aria-label="Reply to RD Agent"]')?.value === '');
    await f.close();
    await f.open();
    assert.equal(await f.editor.inputValue(), '');
    assert.equal(await f.remove('notes.txt').count(), 0);
  });
}
