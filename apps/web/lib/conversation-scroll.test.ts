import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationBottomThreshold,
  confirmedSequenceAfterPage,
  countAppendedMessages,
  isAwayFromConversationBottom,
  isAwayFromConversationTop,
  isNearConversationBottom,
  mergeConversationSnapshot,
  mergeSelectedConversationMessage,
  requirementDetailModeForView,
  shouldResetConversationOnOpen,
  shouldAutoScrollTrace,
  upsertConversationMessage,
} from './conversation-scroll.ts';

void test('treats a viewport within the bottom threshold as following the conversation', () => {
  assert.equal(
    isNearConversationBottom({
      clientHeight: 500,
      scrollHeight: 1_000,
      scrollTop: 404,
    }),
    true,
  );
  assert.equal(
    isNearConversationBottom({
      clientHeight: 500,
      scrollHeight: 1_000,
      scrollTop: 403,
    }),
    false,
  );
  assert.equal(conversationBottomThreshold, 96);
});

void test('treats content that does not overflow as already at the bottom', () => {
  assert.equal(
    isNearConversationBottom({
      clientHeight: 500,
      scrollHeight: 400,
      scrollTop: 0,
    }),
    true,
  );
});

void test('shows the return-to-top control only after leaving the top threshold', () => {
  assert.equal(isAwayFromConversationTop({ scrollTop: 96 }), false);
  assert.equal(isAwayFromConversationTop({ scrollTop: 97 }), true);
});

void test('shows the return-to-bottom control only after leaving the bottom threshold', () => {
  assert.equal(
    isAwayFromConversationBottom({
      clientHeight: 500,
      scrollHeight: 1_000,
      scrollTop: 404,
    }),
    false,
  );
  assert.equal(
    isAwayFromConversationBottom({
      clientHeight: 500,
      scrollHeight: 1_000,
      scrollTop: 403,
    }),
    true,
  );
});

void test('uses a trace-only detail mode exclusively for the Session board', () => {
  assert.equal(requirementDetailModeForView('sessions'), 'trace');
  for (const view of ['requirements', 'relationships', 'pull_requests', 'timers'] as const) {
    assert.equal(requirementDetailModeForView(view), 'conversation');
  }
});

void test('keeps Trace pinned to new events only while the viewport follows the latest event', () => {
  assert.equal(shouldAutoScrollTrace(undefined, 4, true), true);
  assert.equal(shouldAutoScrollTrace(4, 5, true), true);
  assert.equal(shouldAutoScrollTrace(4, 5, false), false);
  assert.equal(shouldAutoScrollTrace(4, 4, true), false);
});

void test('counts appended messages without treating older pages as new', () => {
  assert.equal(countAppendedMessages(203, [
    { sequence: 102 }, { sequence: 202 }, { sequence: 203 },
  ]), 0);
  assert.equal(countAppendedMessages(203, [
    { sequence: 102 }, { sequence: 203 }, { sequence: 204 }, { sequence: 205 },
  ]), 2);
});

void test('keeps the refresh boundary behind live messages until a page confirms them', () => {
  const requirementId = 'req-1';
  const existing = { id: 'msg-201', sequence: 201, requirementId };
  const legacy = { id: 'msg-202', sequence: 202, requirementId };
  const live = { id: 'msg-203', sequence: 203, requirementId };
  const displayed = mergeSelectedConversationMessage(
    { requirementId, items: [existing] }, requirementId, live,
  );
  assert.deepEqual(displayed.items.map((message) => message.sequence), [201, 203]);

  const confirmedThrough = 201; // A live SSE message does not advance the fetch cursor.
  const page = [legacy, live];
  const refreshed = mergeConversationSnapshot(displayed, requirementId, page);
  assert.deepEqual(refreshed.items.map((message) => message.sequence), [201, 202, 203]);
  assert.equal(confirmedSequenceAfterPage(confirmedThrough, page), 203);
  assert.equal(confirmedSequenceAfterPage(203, [legacy]), 203);
});

void test('reopening the same conversation keeps its loaded history', () => {
  assert.equal(shouldResetConversationOnOpen('req-1', 'conversation', 'req-1', 'conversation'), false);
  assert.equal(shouldResetConversationOnOpen('req-1', 'conversation', 'req-2', 'conversation'), true);
  assert.equal(shouldResetConversationOnOpen('req-1', 'trace', 'req-1', 'conversation'), true);
});

void test('inserts an echoed reply in conversation order', () => {
  const messages = [
    { id: 'message-1', sequence: 1, body: 'first' },
    { id: 'message-3', sequence: 3, body: 'third' },
  ];

  assert.deepEqual(
    upsertConversationMessage(messages, { id: 'message-2', sequence: 2, body: 'second' }),
    [
      { id: 'message-1', sequence: 1, body: 'first' },
      { id: 'message-2', sequence: 2, body: 'second' },
      { id: 'message-3', sequence: 3, body: 'third' },
    ],
  );
});

void test('reconciles an echoed reply with the same message received over SSE', () => {
  const messages = [
    { id: 'message-1', sequence: 1, body: 'first' },
    { id: 'message-2', sequence: 2, body: 'stale' },
  ];

  assert.deepEqual(
    upsertConversationMessage(messages, { id: 'message-2', sequence: 2, body: 'persisted' }),
    [
      { id: 'message-1', sequence: 1, body: 'first' },
      { id: 'message-2', sequence: 2, body: 'persisted' },
    ],
  );
});

void test('keeps a selected Requirement message received while its conversation is loading', () => {
  const loadingConversation = {
    requirementId: 'requirement-2',
    items: [{
      id: 'message-2',
      requirementId: 'requirement-2',
      sequence: 1,
      body: 'previous conversation',
    }],
  };
  const liveMessage = {
    id: 'message-1-live',
    requirementId: 'requirement-1',
    sequence: 2,
    body: 'arrived over SSE',
  };

  const afterEvent = mergeSelectedConversationMessage(
    loadingConversation,
    'requirement-1',
    liveMessage,
  );
  assert.deepEqual(afterEvent, {
    requirementId: 'requirement-1',
    items: [liveMessage],
  });

  assert.deepEqual(
    mergeConversationSnapshot(afterEvent, 'requirement-1', [{
      id: 'message-1-old',
      requirementId: 'requirement-1',
      sequence: 1,
      body: 'captured before the SSE append',
    }]),
    {
      requirementId: 'requirement-1',
      items: [
        {
          id: 'message-1-old',
          requirementId: 'requirement-1',
          sequence: 1,
          body: 'captured before the SSE append',
        },
        liveMessage,
      ],
    },
  );
});

void test('merges older pages without replacing live messages or changing sequence order', () => {
  const current = {
    requirementId: 'requirement-1',
    items: [
      { id: 'message-3', requirementId: 'requirement-1', sequence: 3, body: 'live' },
      { id: 'message-4', requirementId: 'requirement-1', sequence: 4, body: 'latest' },
    ],
  };
  const merged = mergeConversationSnapshot(current, 'requirement-1', [
    { id: 'message-1', requirementId: 'requirement-1', sequence: 1, body: 'oldest' },
    { id: 'message-2', requirementId: 'requirement-1', sequence: 2, body: 'older' },
    { id: 'message-3', requirementId: 'requirement-1', sequence: 3, body: 'stale snapshot' },
  ]);
  assert.deepEqual(merged.items.map((message) => message.sequence), [1, 2, 3, 4]);
  assert.equal(merged.items[2]?.body, 'live');
});

void test('does not merge a message from another Requirement into the selected conversation', () => {
  const conversation = {
    requirementId: 'requirement-1',
    items: [{
      id: 'message-1',
      requirementId: 'requirement-1',
      sequence: 1,
    }],
  };

  assert.equal(
    mergeSelectedConversationMessage(conversation, 'requirement-1', {
      id: 'message-2',
      requirementId: 'requirement-2',
      sequence: 2,
    }),
    conversation,
  );
});
