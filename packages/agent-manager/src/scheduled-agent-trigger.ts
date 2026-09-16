import type { AgentTrigger, AgentTriggerContext } from './agent-trigger.js';
import type { Logger } from './logger.js';
import type { AgentManagerStore } from './store.js';
import type { ScheduledAgentTrigger } from './types.js';

export const SCHEDULED_CONTINUE_TRIGGER_ID = 'scheduled.continue';
export const SCHEDULED_CONTINUE_MESSAGE = 'continue.';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DELIVERY_RETRY_DELAY_MS = 30_000;

export interface ScheduledContinueTriggerOptions {
  store: AgentManagerStore;
  logger: Logger;
  onFired?: (trigger: ScheduledAgentTrigger, scheduledFor: string) => void;
}

/** Persistent timer source that wakes an RD session by delivering `continue.`. */
export class ScheduledContinueTrigger implements AgentTrigger {
  readonly id = SCHEDULED_CONTINUE_TRIGGER_ID;
  readonly source = 'scheduled';
  readonly #store: AgentManagerStore;
  readonly #logger: Logger;
  readonly #onFired: ((trigger: ScheduledAgentTrigger, scheduledFor: string) => void) | undefined;
  #context: AgentTriggerContext | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: ScheduledContinueTriggerOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#onFired = options.onFired;
  }

  start(context: AgentTriggerContext): void {
    this.#context = context;
    this.refresh();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#context = null;
  }

  /** Re-arms the timer after a schedule is created or cancelled. */
  refresh(): void {
    this.#armTimer(0);
  }

  #armTimer(minimumDelayMs: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#context) return;
    const next = this.#store.listScheduledAgentTriggers()
      .find((trigger) => trigger.status === 'active' && trigger.nextFireAt !== null);
    if (!next?.nextFireAt) return;
    const targetMs = Date.parse(next.nextFireAt);
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(minimumDelayMs, Number.isFinite(targetMs) ? targetMs - Date.now() : 0, 0),
    );
    this.#timer = setTimeout(() => this.#fireDue(), delayMs);
    this.#timer.unref();
  }

  #fireDue(): void {
    this.#timer = null;
    const context = this.#context;
    if (!context) return;
    const firedAt = new Date();
    let deliveryFailed = false;
    const due = this.#store.listScheduledAgentTriggers()
      .filter((trigger) => trigger.status === 'active'
        && trigger.nextFireAt !== null
        && Date.parse(trigger.nextFireAt) <= firedAt.getTime());

    for (const trigger of due) {
      const scheduledFor = trigger.nextFireAt!;
      try {
        context.deliver({
          requirementId: trigger.requirementId,
          idempotencyKey: `${trigger.id}:${scheduledFor}`,
          author: 'system',
          body: SCHEDULED_CONTINUE_MESSAGE,
          metadata: {
            scheduledAgentTriggerId: trigger.id,
            schedule: trigger.schedule,
            scheduledFor,
          },
        });
        const nextFireAt = trigger.schedule === 'recurring'
          ? nextRecurringFireAt(scheduledFor, trigger.intervalSeconds, firedAt)
          : undefined;
        const updated = this.#store.completeScheduledAgentTriggerOccurrence({
          id: trigger.id,
          expectedNextFireAt: scheduledFor,
          ...(nextFireAt ? { nextFireAt } : {}),
          now: firedAt.toISOString(),
        });
        if (updated) {
          this.#logger.info('Scheduled Agent Trigger fired', {
            scheduledAgentTriggerId: updated.id,
            requirementId: updated.requirementId,
            schedule: updated.schedule,
            scheduledFor,
            nextFireAt: updated.nextFireAt,
          });
          try {
            this.#onFired?.(updated, scheduledFor);
          } catch (error) {
            this.#logger.error('Scheduled Agent Trigger callback failed', {
              scheduledAgentTriggerId: updated.id,
              requirementId: updated.requirementId,
              error,
            });
          }
        }
      } catch (error) {
        deliveryFailed = true;
        this.#logger.error('Scheduled Agent Trigger delivery failed', {
          scheduledAgentTriggerId: trigger.id,
          requirementId: trigger.requirementId,
          scheduledFor,
          error,
        });
      }
    }

    this.#armTimer(deliveryFailed ? DELIVERY_RETRY_DELAY_MS : 0);
  }
}

function nextRecurringFireAt(scheduledFor: string, intervalSeconds: number, firedAt: Date): string {
  const scheduledMs = Date.parse(scheduledFor);
  const intervalMs = intervalSeconds * 1_000;
  const elapsedIntervals = Math.floor(Math.max(0, firedAt.getTime() - scheduledMs) / intervalMs) + 1;
  return new Date(scheduledMs + elapsedIntervals * intervalMs).toISOString();
}
