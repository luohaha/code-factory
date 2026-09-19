import type { ManagerEventDto } from './agent-manager-client.ts';

function upsertVersioned<T extends { id: string }>(
  items: readonly T[],
  item: T,
  version: (value: T) => string,
  order: (left: T, right: T) => number,
): T[] {
  const current = items.find((value) => value.id === item.id);
  const accepted = current && version(current) > version(item) ? current : item;
  return [
    ...items.filter((value) => value.id !== item.id),
    accepted,
  ].sort(order);
}

function latestTimestamp(...values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? '';
}

export function mergeVersionedSnapshot<T>(
  snapshot: readonly T[],
  current: readonly T[],
  upsert: (items: readonly T[], item: T) => T[],
): T[] {
  return current.reduce((merged, item) => upsert(merged, item), [...snapshot]);
}

export function applyRequirementScopedUpdate<T>(
  current: T,
  requirementId: string,
  removedRequirementIds: ReadonlySet<string>,
  update: (value: T) => T,
): T {
  return removedRequirementIds.has(requirementId) ? current : update(current);
}

export function upsertRequirement<
  T extends { id: string; updatedAt: string; session?: { updatedAt: string } },
>(requirements: readonly T[], requirement: T): T[] {
  return upsertVersioned(
    requirements,
    requirement,
    (value) => latestTimestamp(value.updatedAt, value.session?.updatedAt),
    (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function upsertRun<
  T extends { id: string; startedAt: string; finishedAt?: string | null },
>(runs: readonly T[], run: T): T[] {
  return upsertVersioned(
    runs,
    run,
    (value) => latestTimestamp(value.startedAt, value.finishedAt),
    (left, right) => right.startedAt.localeCompare(left.startedAt),
  );
}

export function mergeAgentTrace<T extends { id: string; sequence: number }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
}

export function collectRequirementAgentTrace<
  T extends { createdAt: string; runId: string; sequence: number },
>(
  runIds: ReadonlySet<string>,
  tracesByRun: Readonly<Record<string, readonly T[] | undefined>>,
): T[] {
  return Object.entries(tracesByRun)
    .filter(([runId]) => runIds.has(runId))
    .flatMap(([, trace]) => trace ?? [])
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence);
}

export function replaceRequirementRuns<
  T extends { id: string; requirementId: string; startedAt: string; finishedAt?: string | null },
>(runs: readonly T[], requirementId: string, requirementRuns: readonly T[]): T[] {
  return requirementRuns.filter((run) => run.requirementId === requirementId).reduce<T[]>(
    (current, run) => upsertRun(current, run),
    [...runs],
  ).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function upsertPullRequest<T extends { id: string; updatedAt: string }>(
  pullRequests: readonly T[],
  pullRequest: T,
): T[] {
  return upsertVersioned(
    pullRequests,
    pullRequest,
    (value) => value.updatedAt,
    (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function replaceRequirementPullRequests<T extends { id: string; requirementId: string; updatedAt: string }>(
  pullRequests: readonly T[],
  requirementId: string,
  requirementPullRequests: readonly T[],
): T[] {
  const scoped = requirementPullRequests.filter((pullRequest) => pullRequest.requirementId === requirementId);
  return scoped.reduce<T[]>(
    (current, pullRequest) => upsertPullRequest(current, pullRequest),
    [...pullRequests],
  );
}

export function upsertReviewRequest<
  T extends { id: string; createdAt: string; finishedAt: string | null },
>(reviews: readonly T[], review: T): T[] {
  return upsertVersioned(
    reviews,
    review,
    (value) => latestTimestamp(value.createdAt, value.finishedAt),
    (left, right) => right.createdAt.localeCompare(left.createdAt),
  );
}

export function replacePullRequestReviews<
  T extends { id: string; pullRequestId: string; createdAt: string; finishedAt: string | null },
>(reviews: readonly T[], pullRequestId: string, pullRequestReviews: readonly T[]): T[] {
  const scoped = pullRequestReviews.filter((review) => review.pullRequestId === pullRequestId);
  return scoped.reduce<T[]>(
    (current, review) => upsertReviewRequest(current, review),
    [...reviews],
  );
}

export function upsertAgentTimer<T extends { id: string; updatedAt: string }>(
  timers: readonly T[],
  timer: T,
): T[] {
  return upsertVersioned(
    timers,
    timer,
    (value) => value.updatedAt,
    (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function replaceRequirementTimers<T extends { id: string; requirementId: string; updatedAt: string }>(
  timers: readonly T[],
  requirementId: string,
  requirementTimers: readonly T[],
): T[] {
  const scoped = requirementTimers.filter((timer) => timer.requirementId === requirementId);
  return scoped.reduce<T[]>(
    (current, timer) => upsertAgentTimer(current, timer),
    [...timers],
  );
}

export type DashboardRefreshTarget =
  | { scope: 'workspace' }
  | { scope: 'requirements' }
  | { scope: 'requirement'; requirementId: string; includeRuns: boolean }
  | { scope: 'messages'; requirementId: string }
  | { scope: 'pull_requests'; requirementId: string }
  | { scope: 'review_requests'; pullRequestId?: string; requirementId?: string }
  | { scope: 'timers'; requirementId: string }
  | { scope: 'configuration' }
  | { scope: 'models' };

function stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  return typeof payload[key] === 'string' ? payload[key] : undefined;
}

export function refreshTargetsForManagerEvent(event: ManagerEventDto): DashboardRefreshTarget[] {
  const requirementId = event.requirementId ?? undefined;
  const hasRequirement = Boolean(requirementId && event.payload.requirement?.id === requirementId);
  const hasRun = Boolean(requirementId && event.payload.run?.requirementId === requirementId);
  const hasMessage = Boolean(requirementId && event.payload.message?.requirementId === requirementId);
  const hasPullRequest = Boolean(requirementId
    && event.payload.pullRequest?.requirementId === requirementId);
  const hasReviewRequest = Boolean(hasPullRequest
    && event.payload.reviewRequest?.pullRequestId === event.payload.pullRequest?.id);
  const hasTimer = Boolean(requirementId && event.payload.timer?.requirementId === requirementId);
  switch (event.type) {
    case 'requirement.created':
      return !hasRequirement && requirementId
        ? [{ scope: 'requirement', requirementId, includeRuns: false }]
        : [];
    case 'requirement.completed':
      return [
        ...(!hasRequirement && requirementId
          ? [{ scope: 'requirement' as const, requirementId, includeRuns: false }]
          : []),
        ...(!(event.payload.timers?.every((timer) => timer.requirementId === requirementId)) && requirementId
          ? [{ scope: 'timers' as const, requirementId }]
          : []),
      ];
    case 'requirement.deleted':
      return [];
    case 'requirements.purged':
      return event.payload.requirementIds?.every((id) => typeof id === 'string')
        ? []
        : [{ scope: 'workspace' }];
    case 'message.created':
      if (!requirementId) return [];
      return [
        ...(!hasMessage ? [{ scope: 'messages' as const, requirementId }] : []),
        ...(!hasRequirement
          ? [{ scope: 'requirement' as const, requirementId, includeRuns: false }]
          : []),
      ];
    case 'pull_request.created':
    case 'pull_request.updated':
      return !hasPullRequest && requirementId
        ? [{ scope: 'pull_requests', requirementId }]
        : [];
    case 'review_request.started': {
      const pullRequestId = stringPayload(event.payload, 'pullRequestId');
      return [
        ...(!hasReviewRequest
          ? [{
              scope: 'review_requests' as const,
              ...(pullRequestId ? { pullRequestId } : {}),
              ...(requirementId ? { requirementId } : {}),
            }]
          : []),
        ...(!hasRun && requirementId
          ? [{ scope: 'requirement' as const, requirementId, includeRuns: true }]
          : []),
      ];
    }
    case 'timer.created':
    case 'timer.fired':
    case 'timer.cancelled':
      return !hasTimer && requirementId
        ? [{ scope: 'timers', requirementId }]
        : [];
    case 'run.started':
    case 'run.succeeded':
    case 'run.failed':
    case 'run.timed_out':
    case 'run.cancelled':
      return [
        ...((!hasRun || !hasRequirement) && requirementId
          ? [{ scope: 'requirement' as const, requirementId, includeRuns: true }]
          : []),
        ...(event.payload.role === 'reviewer' && !hasReviewRequest
          ? [{
              scope: 'review_requests' as const,
              ...(requirementId ? { requirementId } : {}),
            }]
          : []),
      ];
    case 'manager.reconciled':
      return Array.isArray(event.payload.requirementIds)
        ? event.payload.requirementIds.map((id) => ({ scope: 'requirement', requirementId: id, includeRuns: true }))
        : [{ scope: 'requirements' }];
    case 'manager.configuration.updated':
      return event.payload.configuration ? [] : [{ scope: 'configuration' }];
    case 'agent_models.updated':
      return event.payload.modelCatalog ? [] : [{ scope: 'models' }];
    default:
      return [];
  }
}

function refreshTargetKey(target: DashboardRefreshTarget): string {
  switch (target.scope) {
    case 'requirement': return `requirement:${target.requirementId}`;
    case 'messages': return `messages:${target.requirementId}`;
    case 'pull_requests': return `pull_requests:${target.requirementId}`;
    case 'review_requests': return `review_requests:${target.pullRequestId ?? '*'}`;
    case 'timers': return `timers:${target.requirementId}`;
    default: return target.scope;
  }
}

export function mergeRefreshTargets(
  current: readonly DashboardRefreshTarget[],
  incoming: readonly DashboardRefreshTarget[],
): DashboardRefreshTarget[] {
  if ([...current, ...incoming].some((target) => target.scope === 'workspace')) {
    return [{ scope: 'workspace' }];
  }
  const merged = new Map<string, DashboardRefreshTarget>();
  for (const target of [...current, ...incoming]) {
    const key = refreshTargetKey(target);
    const previous = merged.get(key);
    if (target.scope === 'requirement' && previous?.scope === 'requirement') {
      merged.set(key, { ...target, includeRuns: previous.includeRuns || target.includeRuns });
    } else {
      merged.set(key, target);
    }
  }
  return [...merged.values()];
}

export function managerEventInvalidatesSearch(event: ManagerEventDto): boolean {
  return [
    'requirement.created',
    'requirement.deleted',
    'requirements.purged',
    'message.created',
    'pull_request.created',
    'pull_request.updated',
  ].includes(event.type);
}
