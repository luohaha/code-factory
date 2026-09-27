import assert from 'node:assert/strict';
import test from 'node:test';

import { decideJevWake } from '../src/jev-wake-decision.ts';

test('Jev sends a typed Choice and Score and maps delayed scores to minutes', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(input, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer secret');
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        state: { requirement: { title: string; description: string }; run_status: string; recent_messages: Array<{ author: string; body: string }> };
        questions: { wake_action: { type: string; instructions: string }; delay: { type: string } };
      };
      assert.equal(body.model, 'jev-latest');
      assert.deepEqual(body.state.recent_messages, [
        { author: 'human', body: 'Please check the build.' },
        { author: 'rd_agent', body: 'A build is still running.' },
      ]);
      assert.deepEqual(body.state.requirement, {
        title: 'Add a report', description: 'Implement the report and test it.',
      });
      assert.equal(body.state.run_status, 'succeeded');
      assert.equal(body.questions.wake_action.type, 'choice');
      assert.match(body.questions.wake_action.instructions, /requirement\.description/);
      assert.match(body.questions.wake_action.instructions, /recent_messages/);
      assert.match(body.questions.wake_action.instructions, /run_status/);
      assert.equal(body.questions.delay.type, 'score');
      return new Response(JSON.stringify({ answers: {
        wake_action: { type: 'choice', choice: 'delayed' },
        delay: { type: 'score', score: 3.5 },
      } }), { status: 200 });
    };
    assert.deepEqual(await decideJevWake('secret', {
      requirement: { title: 'Add a report', description: 'Implement the report and test it.' },
      runStatus: 'succeeded',
      recentMessages: [
        { author: 'human', body: 'Please check the build.' },
        { author: 'rd_agent', body: 'A build is still running.' },
      ],
    }), {
      kind: 'delayed', minutes: 20,
    });
  } finally {
    globalThis.fetch = previous;
  }
});

test('Jev rejects malformed answers and unsuccessful requests', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ answers: {
      wake_action: { type: 'choice', choice: 'unknown' },
    } }), { status: 200 });
    const context = { requirement: { title: 'Task', description: 'Finish work' }, runStatus: 'failed' as const,
      recentMessages: [{ author: 'rd_agent' as const, body: 'done' }] };
    await assert.rejects(decideJevWake('secret', context), /Invalid Jev choice/);
    globalThis.fetch = async () => new Response('{}', { status: 429 });
    await assert.rejects(decideJevWake('secret', context), /HTTP 429/);
  } finally {
    globalThis.fetch = previous;
  }
});

test('Jev request forwards the caller abort signal', async () => {
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
    const decision = decideJevWake('secret', {
      requirement: { title: 'Task', description: 'Work' },
      runStatus: 'timed_out',
      recentMessages: [{ author: 'rd_agent', body: 'Still working.' }],
    }, controller.signal);
    assert.equal(requestSignal?.aborted, false);
    controller.abort();
    assert.equal(requestSignal?.aborted, true);
    await assert.rejects(decision, { name: 'AbortError' });
  } finally {
    globalThis.fetch = previous;
  }
});
