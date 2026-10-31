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
    plugins: [{ name: 'artifact-download-fixture', configureServer(vite) {
      // Chromium downloads bypass page.route; serve their bytes from the fixture origin.
      vite.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/attachments/') || !request.url.endsWith('?download=1')) return next();
        response.writeHead(200, { 'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="result.bin"' });
        response.end('result');
      });
    } }],
  });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
}, { timeout: 120_000 });

after(async () => {
  await browser?.close();
  await server?.close();
});

async function fixture(t, locale = 'en', colorScheme = 'light', mobile = false) {
  const data = detailFixture();
  const context = await browser.newContext({ locale, colorScheme,
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  t.after(() => context.close());
  const page = await context.newPage();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() {
        super();
        window.dispatchManagerEvent = (event) => this.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() {}
    };
  });
  await page.route('**/api/**', (route) => route.fulfill({ json: data.reply(new URL(route.request().url()).pathname) }));
  await page.goto(baseUrl);
  await page.getByRole('heading', { name: data.requirement.title, exact: true }).waitFor();
  const open = async (sessions = true) => {
    await page.getByRole('button', { name: sessions ? (locale === 'zh-CN' ? '会话' : 'Sessions') : (locale === 'zh-CN' ? '需求' : 'Requirements'), exact: true }).click();
    if (sessions) await page.getByRole('heading', { name: locale === 'zh-CN' ? 'RD Agent 会话' : 'RD Agent Sessions', exact: true }).waitFor();
    await page.getByRole('heading', { name: data.requirement.title, exact: true }).click();
    await page.getByRole('dialog').waitFor();
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  };
  const emit = (event) => page.evaluate((payload) => window.dispatchManagerEvent(payload), event);
  return { page, data, open, emit };
}

for (const [locale, theme, mobile] of [['en', 'light', false], ['zh-CN', 'dark', true]]) {
  void test(`attachment expiry hides links from an older in-flight message snapshot (${locale})`, async (t) => {
    const { page, data, open, emit } = await fixture(t, locale, theme, mobile);
    const attachment = (id, createdAt) => ({ id, fileName: `${id}.txt`, kind: 'file', mediaType: 'text/plain', byteSize: 4,
      requirementId: data.requirement.id, messageId: 'msg_expiry', localPath: `/host/${id}`, createdAt });
    const message = { id: 'msg_expiry', requirementId: data.requirement.id, sequence: 2, author: 'human', body: 'Keep the message text',
      attachments: [attachment('old', '2026-10-01T12:00:00.000Z'), attachment('recent', '2026-10-30T12:00:00.000Z')],
      createdAt: '2026-10-31T12:00:00.000Z' };
    let release;
    const pendingResponse = new Promise((resolve) => { release = resolve; });
    await page.route(`**/api/requirements/${data.requirement.id}/messages*`, async (route) => {
      await pendingResponse;
      await route.fulfill({ json: { items: [message], hasMore: false } });
    });
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('/messages'));
    await open(false);
    await requested;
    const purge = (cutoff) => emit({ ...data.managerEvent('attachments.purged', {
      attachmentCount: 1, requirementIds: [data.requirement.id], createdBefore: cutoff,
    }), requirementId: null });
    await purge('2026-10-01T12:00:00.000Z');
    release();
    await page.getByText(message.body, { exact: true }).waitFor();
    const download = locale === 'zh-CN' ? '下载' : 'Download';
    assert.equal(await page.getByRole('link', { name: `${download} old.txt`, exact: true }).count(), 0);
    const recentLink = page.getByRole('link', { name: `${download} recent.txt`, exact: true });
    await recentLink.waitFor();
    await purge('2026-10-30T12:00:00.000Z');
    await recentLink.waitFor({ state: 'hidden' });
    assert.equal(await page.getByText(message.body, { exact: true }).isVisible(), true);
  });

  void test(`RD artifacts provide working file and image download links (${locale})`, async (t) => {
    const { page, data, open } = await fixture(t, locale, theme, mobile);
    const attachment = (id, fileName, kind, mediaType) => ({ id, fileName, kind, mediaType, byteSize: 6,
      requirementId: data.requirement.id, messageId: 'msg_artifact', localPath: '/host/private/artifact', createdAt: new Date().toISOString() });
    await page.route(`**/api/requirements/${data.requirement.id}/messages*`, (route) => route.fulfill({ json: {
      items: [{ id: 'msg_artifact', requirementId: data.requirement.id, sequence: 2, author: 'rd_agent', body: '',
        attachments: [attachment('att_report', '报告.csv', 'file', 'text/csv'), attachment('att_image', '图表.png', 'image', 'image/png')],
        createdAt: new Date().toISOString() }], hasMore: false,
    } }));
    await open(false);
    for (const [id, name] of [['att_report', '报告.csv'], ['att_image', '图表.png']]) {
      const link = page.getByRole('link', { name: `${locale === 'zh-CN' ? '下载' : 'Download'} ${name}`, exact: true });
      await link.waitFor();
      const url = new URL(await link.getAttribute('href'));
      assert.equal(url.pathname, `/api/attachments/${id}`);
      assert.equal(url.search, '?download=1');
      assert.equal(url.origin, new URL(baseUrl).origin);
      assert.equal(await link.getAttribute('download'), name);
      const pending = page.waitForEvent('download');
      await link.click();
      const download = await pending;
      assert.equal(await download.failure(), null);
    }
    assert.equal(await page.getByText('/host/private/artifact', { exact: true }).count(), 0);
  });

  void test(`tool cards preserve keyboard access, locale, theme and bounded layout (${locale}, ${theme})`, async (t) => {
    const { page, open, data } = await fixture(t, locale, theme, mobile);
    data.trace[1].detail = JSON.stringify({ lines: 120, found: true, content: "long-line".repeat(2000) });
    await open();
    const cards = page.locator('.cf-tool-call');
    await cards.nth(2).waitFor();
    assert.equal(await cards.count(), 3);
    assert.equal(await cards.nth(0).getByRole('button', { expanded: false }).count(), 1);
    assert.equal(await cards.nth(0).locator('pre').count(), 0);
    assert.equal(await cards.nth(1).getByRole('button', { expanded: true }).count(), 1);
    await page.getByText(locale === 'zh-CN' ? 'RD Agent 正在工作' : 'RD Agent is working', { exact: true }).waitFor();
    const header = cards.nth(0).getByRole('button');
    await header.focus();
    await header.press('Enter');
    await cards.nth(0).getByRole('heading', { name: locale === 'zh-CN' ? '参数' : 'Arguments', exact: true }).waitFor();
    assert.equal(await cards.nth(0).getByRole('button', { name: locale === 'zh-CN' ? '复制结果' : 'Copy result', exact: true }).count(), 1);
    assert.match(await cards.nth(0).locator('pre').last().innerText(), /"lines": 120/);
    assert.equal(await cards.nth(0).locator('pre').last().evaluate((pre) => pre.scrollHeight > pre.clientHeight), true);
    await cards.nth(0).getByRole('button', { name: locale === 'zh-CN' ? '复制结果' : 'Copy result', exact: true }).click();
    await cards.nth(0).getByRole('button', { name: locale === 'zh-CN' ? '已复制' : 'Copied', exact: true }).waitFor();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /"lines": 120/);
    // Palette comes from the same app token in either theme, without a separate white/blue palette.
    assert.equal(await cards.nth(0).evaluate((card) => {
      const expected = document.createElement('div');
      expected.style.backgroundColor = 'var(--card)';
      document.body.appendChild(expected);
      const matches = getComputedStyle(card).backgroundColor === getComputedStyle(expected).backgroundColor;
      expected.remove();
      return matches;
    }), true);
    assert.equal(await cards.nth(0).evaluate((card) => card.scrollWidth <= card.clientWidth + 1), true);
    if (mobile) assert.ok((await cards.nth(0).boundingBox()).width < 390);
    assert.equal(await cards.nth(0).locator('.cf-tool-call__body').evaluate((body) => getComputedStyle(body).transitionDuration), '0s');
  });
}

void test('live results update one card, and stopped Runs clear working indicators and unfinished timers', async (t) => {
  const { page, data, open, emit } = await fixture(t);
  await open();
  const live = page.locator('.cf-tool-call').nth(2);
  await live.locator('[aria-expanded="false"]').waitFor();
  const result = { ...data.trace[4], id: 'live-end', sequence: 30, kind: 'tool_result', status: 'failed', detail: 'Search failed', createdAt: new Date().toISOString() };
  await emit(data.managerEvent('run.trace.appended', { trace: result }));
  await live.getByText('Search failed', { exact: true }).waitFor();
  assert.equal(await page.locator('.cf-tool-call').count(), 3);
  assert.equal(await live.getAttribute('data-status'), 'error');
  // Simulate a different unfinished call followed by a stopped Run.
  const unfinished = { ...data.trace[4], id: 'unfinished', toolCallId: 'unfinished', sequence: 31 };
  await emit(data.managerEvent('run.trace.appended', { trace: unfinished }));
  const pending = page.locator('.cf-tool-call').nth(3);
  await pending.locator('.cf-tool-call__status').getByText('Running', { exact: true }).waitFor();
  await emit(data.stop());
  await pending.locator('.cf-tool-call__status').getByText('No result captured', { exact: true }).waitFor();
  await page.locator('.cf-thinking-loader').waitFor({ state: 'hidden' });
});

void test('the conversation shows the original RD working status alongside Stop Run', async (t) => {
  const { page, data, open, emit } = await fixture(t);
  await open(false);
  const workingStatus = page.getByText('RD Agent is working; new messages are queued by default.', { exact: true });
  await workingStatus.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stop Run', exact: true }).isVisible(), true);
  assert.equal(await page.locator('.cf-thinking-loader').count(), 0);
  assert.equal(await page.getByText('New messages are queued by default.', { exact: true }).count(), 0);
  await emit(data.stop());
  await workingStatus.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Complete', exact: true }).waitFor();
});
