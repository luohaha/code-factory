import type { RequirementDto } from './agent-manager-client.ts';

export interface WorkspaceRequirementSummary {
  total: number;
  doing: number;
}

export function summarizeWorkspaceRequirements(
  requirements: readonly Pick<RequirementDto, 'sandboxId' | 'status'>[],
): Map<string, WorkspaceRequirementSummary> {
  const summaries = new Map<string, WorkspaceRequirementSummary>();
  for (const requirement of requirements) {
    const workspaceId = requirement.sandboxId ?? 'local';
    const summary = summaries.get(workspaceId) ?? { total: 0, doing: 0 };
    summary.total += 1;
    if (requirement.status === 'doing') summary.doing += 1;
    summaries.set(workspaceId, summary);
  }
  return summaries;
}
