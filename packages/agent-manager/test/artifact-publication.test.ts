import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { runCodeFactoryCli } from '../src/cli/code-factory-cli.js';
import { AgentManager, MAX_MESSAGE_ATTACHMENT_BYTES } from '../src/core/agent-manager.js';
import type { PublishedArtifact, RunOutcome } from '../src/core/types.js';
import { createAgentManagerServer } from '../src/http/server.js';
import { silentLogger } from '../src/infrastructure/logger.js';
import type { AgentProcessRunner, ProcessRunRequest } from '../src/runtime/process-runner.js';
import { SqliteAgentManagerStore } from '../src/storage/sqlite-store.js';
import type { AppendMessageRecord } from '../src/storage/store.js';

class DeferredRunner implements AgentProcessRunner {
  requests: ProcessRunRequest[] = [];
  finish: ((outcome: RunOutcome) => void) | undefined;
  run(request: ProcessRunRequest): Promise<RunOutcome> {
    this.requests.push(request);
    return new Promise((resolve) => { this.finish = resolve; });
  }
}

async function fixture(t: TestContext, makeStore = (path: string) => new SqliteAgentManagerStore(path)) {
  const directory = mkdtempSync(join(tmpdir(), 'code-factory-artifact-'));
  const databasePath = join(directory, 'factory.sqlite');
  const store = makeStore(databasePath);
  const runner = new DeferredRunner();
  const manager = new AgentManager({ workspaceRoot: directory, databasePath, store, runner,
    attachmentDirectory: join(directory, 'attachments'), logger: silentLogger });
  const server = createAgentManagerServer(manager);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, databasePath, store, manager, runner, url: `http://127.0.0.1:${address.port}` };
}

for (const provider of ['codex', 'claude-code'] as const) {
  test(`${provider} publishes binary output through the shared CLI without re-delivering it to RD`, async (t) => {
    const { directory, databasePath, manager, runner, url } = await fixture(t);
    const requirement = manager.createRequirement({ title: 'Produce a report', description: 'Return a downloadable report', provider });
    const run = manager.runRequirement(requirement.id);
    const source = join(directory, 'result.bin');
    const bytes = Buffer.from('ARTIFACT_BYTES_STAY_OUT_OF_MODEL_CONTEXT\0\xff', 'latin1');
    writeFileSync(source, bytes);
    const output: string[] = [];
    const errors: string[] = [];
    const status = await runCodeFactoryCli(['artifact', 'publish', '--path', source, '--name', '../报告.bin'], {
      environment: { CODE_FACTORY_API_URL: `${url}/api`, CODE_FACTORY_REQUIREMENT_ID: requirement.id,
        CODE_FACTORY_SESSION_ID: requirement.session.id },
      writeOut: (value) => output.push(value), writeError: (value) => errors.push(value),
    });
    assert.equal(status, 0, errors.join(''));
    const receipt = JSON.parse(output.join('')) as PublishedArtifact;
    assert.equal(receipt.attachment.fileName, '报告.bin');
    assert.equal(receipt.attachment.byteSize, bytes.length);
    assert.equal(receipt.attachment.kind, 'file');
    assert.equal(receipt.attachment.mediaType, 'application/octet-stream');
    assert.equal(output.join('').includes(directory), false);
    assert.equal(output.join('').includes('ARTIFACT_BYTES'), false);
    assert.equal(output.join('').includes(bytes.toString('base64')), false);
    const message = manager.listMessages(requirement.id).find((item) => item.id === receipt.messageId)!;
    assert.equal(message.author, 'rd_agent');
    assert.equal(message.deliverToRd, false);
    assert.equal(message.body, '');
    assert.equal(message.runId, manager.listRuns(requirement.id)[0]?.id);
    assert.equal(message.attachments[0]?.id, receipt.attachment.id);
    assert.equal(manager.getRequirement(requirement.id)?.session.pendingMessageCount, 0);
    assert.ok(manager.listEvents().some((event) => event.type === 'message.created'
      && (event.payload.message as { id: string }).id === receipt.messageId));
    assert.deepEqual(readFileSync(source), bytes);
    const saved = message.attachments[0]!;
    assert.equal(statSync(saved.localPath).mode & 0o777, 0o600);
    const response = await fetch(`${url}${receipt.downloadPath}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(runner.requests.length, 1);
    assert.equal(runner.requests[0]?.invocation.input.includes('ARTIFACT_BYTES'), false);
    runner.finish!({ status: 'succeeded', exitCode: 0, nativeSessionId: 'native-report', finalMessage: 'Report ready', error: null });
    await run;
    assert.equal(runner.requests.length, 1, 'publication does not queue another RD Run');
    assert.equal(manager.getRequirement(requirement.id)?.session.pendingMessageCount, 0);

    await manager.close();
    const reopened = new AgentManager({ workspaceRoot: directory, databasePath, logger: silentLogger });
    try {
      assert.equal(reopened.listMessages(requirement.id)[0]?.attachments[0]?.id, receipt.attachment.id);
      reopened.updateConfiguration({ doneRequirementRetentionDays: 0 });
      reopened.confirmRequirement(requirement.id);
      assert.equal(reopened.getRequirement(requirement.id), null);
      assert.equal(existsSync(saved.localPath), false, 'published files use normal attachment retention');
      assert.equal(existsSync(source), true, 'retention preserves the source file');
    } finally { await reopened.close(); }
  });
}

test('artifact API validates session ownership, size, MIME and terminal states, and forces image downloads', async (t) => {
  const { manager, directory, url } = await fixture(t);
  const requirement = manager.createRequirement({ title: 'Artifact validation', description: 'Validate output', provider: 'codex' });
  const other = manager.createRequirement({ title: 'Other task', description: 'Separate session', provider: 'claude-code' });
  const endpoint = `${url}/api/agent/requirements/${requirement.id}/artifacts`;
  const upload = (sessionId: string, data: Buffer, mediaType = 'application/octet-stream') => fetch(
    `${endpoint}?sourceSessionId=${encodeURIComponent(sessionId)}`, {
      method: 'POST', headers: { 'content-type': mediaType, 'x-file-name': encodeURIComponent('报告.png') }, body: data,
    });
  assert.equal((await upload(other.session.id, Buffer.from('data'))).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', body: 'data' })).status, 400);
  assert.equal((await upload(requirement.session.id, Buffer.alloc(0))).status, 400);
  assert.throws(() => manager.publishAgentArtifact(requirement.id, requirement.session.id, {
    fileName: 'large.bin', data: Buffer.alloc(MAX_MESSAGE_ATTACHMENT_BYTES + 1),
  }), /exceeds 20 MB/);
  assert.equal((await upload(requirement.session.id, Buffer.alloc(MAX_MESSAGE_ATTACHMENT_BYTES + 1))).status, 400);
  assert.equal(existsSync(join(directory, 'attachments')), false);
  assert.equal(manager.listMessages(requirement.id).length, 0);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
  const result = await upload(requirement.session.id, image, 'text/html');
  assert.equal(result.status, 201);
  const receipt = await result.json() as PublishedArtifact;
  assert.equal(receipt.attachment.kind, 'image');
  assert.equal(receipt.attachment.mediaType, 'image/png', 'signature overrides the claimed MIME');
  const inline = await fetch(`${url}/api/attachments/${receipt.attachment.id}`);
  assert.match(inline.headers.get('content-disposition')!, /^inline;/);
  const download = await fetch(`${url}${receipt.downloadPath}`);
  assert.match(download.headers.get('content-disposition')!, /^attachment;/);
  assert.match(download.headers.get('content-disposition')!, /%E6%8A%A5%E5%91%8A/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), image);
  const html = await upload(requirement.session.id, Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml');
  const htmlReceipt = await html.json() as PublishedArtifact;
  assert.equal(htmlReceipt.attachment.kind, 'file');
  const htmlResponse = await fetch(`${url}/api/attachments/${htmlReceipt.attachment.id}`);
  assert.match(htmlResponse.headers.get('content-disposition')!, /^attachment;/);
  manager.deleteRequirement(other.id);
  assert.throws(() => manager.publishAgentArtifact(other.id, other.session.id, {
    fileName: 'late.txt', data: Buffer.from('late'),
  }), /terminal Requirement/);
  assert.equal((await fetch(`${url}/api/attachments/missing`)).status, 404);
});

test('failed publication rolls back metadata and removes the newly stored file', async (t) => {
  class ConflictingStore extends SqliteAgentManagerStore {
    conflictingId: string | undefined;
    attemptedAttachmentId: string | undefined;
    override appendMessage(input: AppendMessageRecord) {
      this.attemptedAttachmentId = input.newAttachments?.[0]?.id;
      return super.appendMessage(input.newAttachments && this.conflictingId ? { ...input, id: this.conflictingId } : input);
    }
  }
  const { manager, store, directory } = await fixture(t, (path) => new ConflictingStore(path));
  const requirement = manager.createRequirement({ title: 'Atomic publication', description: 'Rollback failures', provider: 'codex' });
  const prior = store.appendMessage({ id: 'msg-existing', requirementId: requirement.id, sessionId: requirement.session.id,
    author: 'rd_agent', body: 'Existing output', deliverToRd: false, now: new Date().toISOString() });
  (store as ConflictingStore).conflictingId = prior.id;
  assert.throws(() => manager.publishAgentArtifact(requirement.id, requirement.session.id, {
    fileName: 'result.txt', data: Buffer.from('result'),
  }), /UNIQUE constraint/);
  assert.deepEqual(readdirSync(join(directory, 'attachments')), []);
  assert.equal(manager.listMessages(requirement.id).length, 1);
  assert.equal(store.getMessageAttachment((store as ConflictingStore).attemptedAttachmentId!), null);
  // A second connection observes no orphan metadata after the transaction rolls back.
  const reader = new SqliteAgentManagerStore(join(directory, 'factory.sqlite'));
  try { assert.equal(reader.listMessages(requirement.id)[0]?.attachments.length, 0); }
  finally { reader.close(); }
});

test('artifact CLI rejects invalid file inputs and hides raw transport/server errors without retries', async (t) => {
  const { directory } = await fixture(t);
  const source = join(directory, 'source.bin');
  writeFileSync(source, 'safe bytes');
  const environment = { CODE_FACTORY_API_URL: 'http://127.0.0.1:4310/api', CODE_FACTORY_REQUIREMENT_ID: 'req_cli',
    CODE_FACTORY_SESSION_ID: 'ses_cli' };
  let calls = 0;
  for (const mode of ['transport', 'server'] as const) {
    const errors: string[] = [];
    const status = await runCodeFactoryCli(['artifact', 'publish', '--path', source], {
      environment, writeOut: () => assert.fail('failed publication must not emit a receipt'), writeError: (value) => errors.push(value),
      fetch: async () => { calls++; if (mode === 'transport') throw new Error('secret-provider-credential');
        return new Response(JSON.stringify({ error: 'secret-provider-credential' }), { status: 500 }); },
    });
    assert.equal(status, 1);
    assert.equal(errors.join('').includes('secret-provider-credential'), false);
    assert.match(errors.join(''), /write may have succeeded/);
  }
  assert.equal(calls, 2, 'no automatic retry');
  for (const args of [
    ['--path', 'relative.bin'], ['--path', directory], ['--path', source, '--media-type', 'text/html\r\nAuthorization: secret'],
  ]) {
    assert.equal(await runCodeFactoryCli(['artifact', 'publish', ...args], {
      environment, writeError: () => undefined, fetch: async () => assert.fail('invalid inputs must not upload'),
    }), 2);
  }
  for (const size of [0, MAX_MESSAGE_ATTACHMENT_BYTES + 1]) {
    truncateSync(source, size);
    assert.equal(await runCodeFactoryCli(['artifact', 'publish', '--path', source], {
      environment, writeError: () => undefined, fetch: async () => assert.fail('invalid sizes must not upload'),
    }), 2);
  }
});
