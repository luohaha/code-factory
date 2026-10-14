export const conversationBottomThreshold = 96;

export type RequirementDetailMode = 'conversation' | 'trace';
export type RequirementDetailSourceView = 'requirements' | 'relationships' | 'pull_requests' | 'sessions' | 'timers' | 'sandboxes';

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

export function countAppendedMessages(
  previousLatestSequence: number,
  messages: ReadonlyArray<{ sequence: number }>,
): number {
  return messages.filter((message) => message.sequence > previousLatestSequence).length;
}

export function confirmedSequenceAfterPage(
  previousSequence: number,
  page: ReadonlyArray<{ sequence: number }>,
): number {
  return Math.max(previousSequence, page.at(-1)?.sequence ?? previousSequence);
}

export function shouldResetConversationOnOpen(
  selectedRequirementId: string | null,
  detailMode: RequirementDetailMode,
  nextRequirementId: string,
  nextDetailMode: RequirementDetailMode,
): boolean {
  return nextDetailMode === 'conversation'
    && (selectedRequirementId !== nextRequirementId || detailMode !== nextDetailMode);
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
  const merged = new Map(scopedSnapshot.map((message) => [message.id, message]));
  if (conversation.requirementId === requirementId) {
    for (const message of conversation.items) merged.set(message.id, message);
  }
  return {
    requirementId,
    items: [...merged.values()].sort((left, right) => left.sequence - right.sequence),
  };
}
