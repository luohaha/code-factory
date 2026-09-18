import type { AgentTrigger, AgentTriggerContext } from './agent-trigger.js';
import type { Logger } from './logger.js';
import type { AgentManagerStore } from './store.js';
import type { AgentTimer } from './types.js';

export const TIMER_AGENT_TRIGGER_ID = 'timer';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DELIVERY_RETRY_DELAY_MS = 30_000;

export interface TimerAgentTriggerOptions {
  store: AgentManagerStore;
  logger: Logger;
  onFired?: (timer: AgentTimer, scheduledFor: string) => void;
}

/** Persistent timer source that wakes an RD session with its follow-up description. */
export class TimerAgentTrigger implements AgentTrigger {
  readonly id = TIMER_AGENT_TRIGGER_ID;
  readonly source = 'timer';
  readonly #store: AgentManagerStore;
  readonly #logger: Logger;
  readonly #onFired: ((timer: AgentTimer, scheduledFor: string) => void) | undefined;
  #context: AgentTriggerContext | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: TimerAgentTriggerOptions) {
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
    const next = this.#store.listAgentTimers()
      .find((timer) => timer.status === 'active' && timer.nextFireAt !== null);
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
    const due = this.#store.listAgentTimers()
      .filter((timer) => timer.status === 'active'
        && timer.nextFireAt !== null
        && Date.parse(timer.nextFireAt) <= firedAt.getTime());

    for (const timer of due) {
      const scheduledFor = timer.nextFireAt!;
      try {
        context.deliver({
          requirementId: timer.requirementId,
          idempotencyKey: `${timer.id}:${scheduledFor}`,
          author: 'system',
          body: timerMessage(timer),
          metadata: {
            timerId: timer.id,
            description: timer.description,
            schedule: timer.schedule,
            scheduledFor,
          },
        });
        const nextFireAt = timer.schedule === 'recurring'
          ? nextRecurringFireAt(scheduledFor, timer.intervalSeconds, firedAt)
          : undefined;
        const updated = this.#store.completeAgentTimerOccurrence({
          id: timer.id,
          expectedNextFireAt: scheduledFor,
          ...(nextFireAt ? { nextFireAt } : {}),
          now: firedAt.toISOString(),
        });
        if (updated) {
          this.#logger.info('Agent Timer fired', {
            timerId: updated.id,
            requirementId: updated.requirementId,
            schedule: updated.schedule,
            scheduledFor,
            nextFireAt: updated.nextFireAt,
          });
          try {
            this.#onFired?.(updated, scheduledFor);
          } catch (error) {
            this.#logger.error('Agent Timer callback failed', {
              timerId: updated.id,
              requirementId: updated.requirementId,
              error,
            });
          }
        }
      } catch (error) {
        deliveryFailed = true;
        this.#logger.error('Agent Timer delivery failed', {
          timerId: timer.id,
          requirementId: timer.requirementId,
          scheduledFor,
          error,
        });
      }
    }

    this.#armTimer(deliveryFailed ? DELIVERY_RETRY_DELAY_MS : 0);
  }
}

function timerMessage(timer: AgentTimer): string {
  return [
    'Timer fired.',
    `Timer ID: ${timer.id}`,
    `Schedule: ${timer.schedule}`,
    `Description: ${timer.description}`,
    timer.schedule === 'recurring'
      ? `This timer is recurring. Cancel it with code-factory-cli timer cancel --id ${timer.id} when it is no longer needed.`
      : '',
  ].filter(Boolean).join('\n');
}

function nextRecurringFireAt(scheduledFor: string, intervalSeconds: number, firedAt: Date): string {
  const scheduledMs = Date.parse(scheduledFor);
  const intervalMs = intervalSeconds * 1_000;
  const elapsedIntervals = Math.floor(Math.max(0, firedAt.getTime() - scheduledMs) / intervalMs) + 1;
  return new Date(scheduledMs + elapsedIntervals * intervalMs).toISOString();
}
