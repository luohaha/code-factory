import assert from 'node:assert/strict';
import test from 'node:test';

import { decideJevMessage, type JevMessageContext } from '../src/triggers/jev-message-decision.ts';

const context: JevMessageContext = {
  sourceRequirement: { id: 'req_source', title: 'API implementation', description: 'Implement the shared API.' },
  targetRequirement: { id: 'req_target', title: 'API consumer', description: 'Use the shared API.' },
  message: 'Use contract version 2.',
  sourceRecentMessages: [
    { author: 'human', body: 'Update the shared API contract.' },
    { author: 'rd_agent', body: 'Contract version 2 is ready.' },
  ],
  targetRecentMessages: [{ author: 'human', body: 'Waiting for the contract.' }],
};

test('Jev message decisions send the candidate and both conversation histories as a typed choice', async () => {
  const previous = globalThis.fetch;
  try {
    for (const choice of ['deliver', 'reject'] as const) {
      globalThis.fetch = async (input, init) => {
        assert.equal(input, 'https://api.typesafe.ai/v1/systemone');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer secret');
        assert.ok(init?.signal);
        const body = JSON.parse(String(init?.body)) as {
          model: string; state: unknown;
          questions: { message_action: { type: string; criteria: Record<string, string> } };
        };
        assert.equal(body.model, 'jev-latest');
        assert.deepEqual(body.state, {
          source_requirement: context.sourceRequirement, target_requirement: context.targetRequirement,
          message: context.message,
          source_recent_messages: context.sourceRecentMessages,
          target_recent_messages: context.targetRecentMessages,
        });
        assert.equal(body.questions.message_action.type, 'choice');
        assert.deepEqual(Object.keys(body.questions.message_action.criteria), ['deliver', 'reject']);
        return Response.json({ answers: { message_action: { type: 'choice', choice } } });
      };
      assert.equal(await decideJevMessage('secret', context), choice);
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test('Jev message decisions reject HTTP failures and malformed answers', async () => {
  const previous = globalThis.fetch;
  try {
    for (const body of [null, {}, { answers: null }, { answers: {} },
      { answers: { message_action: { type: 'score', choice: 'deliver' } } },
      { answers: { message_action: { type: 'choice', choice: 'unknown' } } }]) {
      globalThis.fetch = async () => Response.json(body);
      await assert.rejects(decideJevMessage('secret', context), /Invalid Jev/);
    }
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    await assert.rejects(decideJevMessage('secret', context), /HTTP 503/);
    globalThis.fetch = async () => new Response('not json');
    await assert.rejects(decideJevMessage('secret', context), SyntaxError);
  } finally {
    globalThis.fetch = previous;
  }
});

test('Jev message decisions forward cancellation to the request', async () => {
  const previous = globalThis.fetch;
  try {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    };
    const controller = new AbortController();
    const decision = decideJevMessage('secret', context, controller.signal);
    assert.equal(requestSignal?.aborted, false);
    controller.abort();
    assert.equal(requestSignal?.aborted, true);
    await assert.rejects(decision, { name: 'AbortError' });
  } finally {
    globalThis.fetch = previous;
  }
});
