import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationBottomThreshold,
  countAddedMessages,
  isAwayFromConversationBottom,
  isAwayFromConversationTop,
  isNearConversationBottom,
  mergeConversationSnapshot,
  mergeSelectedConversationMessage,
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

void test('counts only message ids that were not present in the previous refresh', () => {
  const previousMessageIds = new Set(['message-1', 'message-2']);

  assert.equal(
    countAddedMessages(previousMessageIds, [
      { id: 'message-1' },
      { id: 'message-2' },
      { id: 'message-3' },
      { id: 'message-4' },
    ]),
    2,
  );
  assert.equal(
    countAddedMessages(previousMessageIds, [
      { id: 'message-1' },
      { id: 'message-2' },
    ]),
    0,
  );
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
