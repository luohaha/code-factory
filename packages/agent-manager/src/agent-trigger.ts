import type { MessageAuthor, RequirementMessage } from './types.js';

/** A message produced by an external source and routed to one Requirement. */
export interface AgentTriggerMessage {
  requirementId: string;
  idempotencyKey: string;
  author: Exclude<MessageAuthor, 'rd_agent'>;
  body: string;
  metadata?: Record<string, unknown>;
}

/** Services owned by Agent Manager and shared with every trigger. */
export interface AgentTriggerContext {
  deliver(message: AgentTriggerMessage): RequirementMessage | null;
}

/**
 * A lifecycle-managed source of external messages for RD Agents.
 *
 * Implementations own source-specific listening or polling. Agent Manager owns
 * persistence, idempotency, conversation publication, and RD wake-up behavior.
 */
export interface AgentTrigger {
  readonly id: string;
  readonly source: string;
  start(context: AgentTriggerContext): void;
  stop(): void;
}
