import type { AgentTriggerContext } from './agent-trigger.js';
import { MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS } from './configuration.js';
import type { GitHubClient } from './github-client.js';
import type { Logger } from './logger.js';
import {
  gitHubCheckState,
  type PullRequestSnapshotTrigger,
  type PullRequestTriggerRegistration,
} from './pull-request-triggers.js';
import type { AgentManagerStore } from './store.js';
import type { PullRequest, TrackPullRequestInput } from './types.js';

/** @deprecated Built-in PR events now use event-specific trigger IDs. */
export const PULL_REQUEST_TRIGGER_ID = 'github.pull-request';

export interface PullRequestReconcilerOptions {
  store: AgentManagerStore;
  githubClient: GitHubClient;
  logger: Logger;
  synchronizePullRequest(input: TrackPullRequestInput): void;
  isClosed(): boolean;
}

/** Polls each tracked PR once and shares its snapshot with independent PR triggers. */
export class PullRequestReconciler {
  readonly #store: AgentManagerStore;
  readonly #githubClient: GitHubClient;
  readonly #logger: Logger;
  readonly #synchronizePullRequest: (input: TrackPullRequestInput) => void;
  readonly #isClosed: () => boolean;
  readonly #registrations = new Map<string, PullRequestTriggerRegistration>();
  #intervalMs = 30_000;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(options: PullRequestReconcilerOptions) {
    this.#store = options.store;
    this.#githubClient = options.githubClient;
    this.#logger = options.logger;
    this.#synchronizePullRequest = options.synchronizePullRequest;
    this.#isClosed = options.isClosed;
  }

  get isRunning(): boolean {
    return this.#timer !== null;
  }

  setInterval(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000
      || intervalMs > MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS * 1_000) {
      throw new RangeError(`Pull request reconcile interval must be from 1000ms to ${MAX_PULL_REQUEST_RECONCILE_INTERVAL_SECONDS * 1_000}ms`);
    }
    if (this.#timer) throw new Error('Cannot change the interval of a running pull request reconciler');
    this.#intervalMs = intervalMs;
  }

  register(trigger: PullRequestSnapshotTrigger, context: AgentTriggerContext): void {
    const current = this.#registrations.get(trigger.id);
    if (current?.trigger === trigger) return;
    if (current) throw new Error(`Pull request trigger ${trigger.id} is already registered`);
    this.#registrations.set(trigger.id, { trigger, context });
  }

  unregister(trigger: PullRequestSnapshotTrigger): void {
    if (this.#registrations.get(trigger.id)?.trigger !== trigger) return;
    this.#registrations.delete(trigger.id);
    if (this.#registrations.size === 0) this.stop();
  }

  start(): void {
    if (this.#timer) return;
    const reconcile = () => {
      void this.reconcile().catch((error: unknown) => {
        this.#logger.error('Pull request reconciliation failed', { error });
      });
    };
    reconcile();
    this.#timer = setInterval(reconcile, this.#intervalMs);
    this.#timer.unref();
    this.#logger.info('Pull request reconciler started', {
      intervalMs: this.#intervalMs,
      triggerIds: [...this.#registrations.keys()],
    });
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async reconcile(registrations?: readonly PullRequestTriggerRegistration[]): Promise<void> {
    if (this.#isClosed()) return;
    if (this.#inFlight) return await this.#inFlight;
    const activeRegistrations = registrations ?? [...this.#registrations.values()];
    const run = this.reconcileInternal(activeRegistrations);
    this.#inFlight = run;
    try {
      await run;
    } finally {
      if (this.#inFlight === run) this.#inFlight = null;
    }
  }

  private async reconcileInternal(registrations: readonly PullRequestTriggerRegistration[]): Promise<void> {
    if (registrations.length === 0) return;
    const errors: Error[] = [];
    for (const pullRequest of this.#store.listPullRequests()
      .filter((item) => item.status === 'draft' || item.status === 'open')) {
      try {
        const snapshot = await this.#githubClient.inspectPullRequest(pullRequest);
        if (this.#isClosed()) return;
        this.reconcileSnapshot(registrations, pullRequest, snapshot);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${errors.length} pull request(s) could not be reconciled`);
  }

  private reconcileSnapshot(
    registrations: readonly PullRequestTriggerRegistration[],
    pullRequest: PullRequest,
    snapshot: Awaited<ReturnType<GitHubClient['inspectPullRequest']>>,
  ): void {
    const now = new Date().toISOString();
    const { observation, created } = this.#store.ensurePullRequestObservation(pullRequest.id, now);

    for (const { trigger, context } of registrations) {
      trigger.reconcileSnapshot(context, pullRequest, snapshot, observation, created);
    }

    const checkStates = Object.fromEntries(snapshot.checks.map((check) => [check.key, gitHubCheckState(check)]));
    this.#store.updatePullRequestCheckStates(pullRequest.id, checkStates, now);

    if (pullRequestChanged(pullRequest, snapshot)) {
      this.#synchronizePullRequest({
        requirementId: pullRequest.requirementId,
        repository: pullRequest.repository,
        number: pullRequest.number,
        url: snapshot.url,
        title: snapshot.title,
        baseBranch: snapshot.baseBranch,
        headBranch: snapshot.headBranch,
        headSha: snapshot.headSha,
        status: snapshot.status,
      });
    }
  }
}

function pullRequestChanged(
  pullRequest: PullRequest,
  snapshot: Awaited<ReturnType<GitHubClient['inspectPullRequest']>>,
): boolean {
  return pullRequest.status !== snapshot.status
    || pullRequest.title !== snapshot.title
    || pullRequest.url !== snapshot.url
    || pullRequest.baseBranch !== snapshot.baseBranch
    || pullRequest.headBranch !== snapshot.headBranch
    || pullRequest.headSha !== snapshot.headSha;
}
