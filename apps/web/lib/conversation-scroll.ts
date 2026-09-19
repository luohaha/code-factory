export const conversationBottomThreshold = 96;

export type RequirementDetailMode = 'conversation' | 'trace';
export type RequirementDetailSourceView = 'requirements' | 'relationships' | 'pull_requests' | 'sessions' | 'timers';

type ScrollMetrics = Pick<
  HTMLElement,
  'clientHeight' | 'scrollHeight' | 'scrollTop'
>;

export function isNearConversationBottom(
  { clientHeight, scrollHeight, scrollTop }: ScrollMetrics,
  threshold = conversationBottomThreshold,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function isAwayFromConversationBottom(
  metrics: ScrollMetrics,
  threshold = conversationBottomThreshold,
): boolean {
  return !isNearConversationBottom(metrics, threshold);
}

export function isAwayFromConversationTop(
  { scrollTop }: Pick<HTMLElement, 'scrollTop'>,
  threshold = conversationBottomThreshold,
): boolean {
  return scrollTop > threshold;
}

export function requirementDetailModeForView(
  view: RequirementDetailSourceView,
): RequirementDetailMode {
  return view === 'sessions' ? 'trace' : 'conversation';
}

export function shouldAutoScrollTrace(
  previousEventCount: number | undefined,
  nextEventCount: number,
  followsLatest: boolean,
): boolean {
  return followsLatest && previousEventCount !== nextEventCount;
}

export function countAddedMessages(
  previousMessageIds: ReadonlySet<string>,
  messages: ReadonlyArray<{ id: string }>,
): number {
  return messages.reduce(
    (count, message) => count + (previousMessageIds.has(message.id) ? 0 : 1),
    0,
  );
}

export function upsertConversationMessage<T extends { id: string; sequence: number }>(
  messages: readonly T[],
  message: T,
): T[] {
  return [
    ...messages.filter((item) => item.id !== message.id),
    message,
  ].sort((left, right) => left.sequence - right.sequence);
}

export interface RequirementConversation<T> {
  requirementId: string | null;
  items: T[];
}

export function mergeSelectedConversationMessage<
  T extends { id: string; sequence: number; requirementId: string },
>(
  conversation: RequirementConversation<T>,
  selectedRequirementId: string | null,
  message: T,
): RequirementConversation<T> {
  if (!selectedRequirementId || message.requirementId !== selectedRequirementId) {
    return conversation;
  }
  return {
    requirementId: selectedRequirementId,
    items: upsertConversationMessage(
      conversation.requirementId === selectedRequirementId ? conversation.items : [],
      message,
    ),
  };
}

export function mergeConversationSnapshot<
  T extends { id: string; sequence: number; requirementId: string },
>(
  conversation: RequirementConversation<T>,
  requirementId: string,
  snapshot: readonly T[],
): RequirementConversation<T> {
  const scopedSnapshot = snapshot.filter((message) => message.requirementId === requirementId);
  return {
    requirementId,
    items: conversation.requirementId === requirementId
      ? conversation.items.reduce(
          (messages, message) => upsertConversationMessage(messages, message),
          scopedSnapshot,
        )
      : [...scopedSnapshot],
  };
}
