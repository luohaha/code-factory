import type { ManagerEventDto, RunStatus } from './agent-manager-client.ts';

export type FinishedRunStatus = Exclude<RunStatus, 'running'>;

export interface FinishedRdRun {
  runId: string;
  requirementId: string;
  requirementTitle: string;
  status: FinishedRunStatus;
}

const finishedRunStatusByEvent: Record<string, FinishedRunStatus> = {
  'run.succeeded': 'succeeded',
  'run.failed': 'failed',
  'run.timed_out': 'timed_out',
  'run.cancelled': 'cancelled',
};

export function desktopNotificationsEnabled(storedPreference: string | null): boolean {
  return storedPreference !== 'off';
}

export function takeFinishedRdRun(event: ManagerEventDto, seenRunIds: Set<string>): FinishedRdRun | null {
  const status = finishedRunStatusByEvent[event.type];
  const run = event.payload.run;
  const requirement = event.payload.requirement;
  if (!status || !run || !requirement
    || run.status !== status
    || run.role !== 'rd'
    || !event.runId
    || event.runId !== run.id
    || !event.requirementId
    || event.requirementId !== run.requirementId
    || requirement.id !== run.requirementId
    || seenRunIds.has(run.id)) return null;

  seenRunIds.add(run.id);
  return {
    runId: run.id,
    requirementId: run.requirementId,
    requirementTitle: requirement.title,
    status,
  };
}
