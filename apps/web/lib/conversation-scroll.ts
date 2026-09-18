export const conversationBottomThreshold = 96;

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
