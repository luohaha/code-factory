export function upsertRequirement<T extends { id: string; updatedAt: string }>(
  requirements: readonly T[],
  requirement: T,
): T[] {
  return [
    ...requirements.filter((item) => item.id !== requirement.id),
    requirement,
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function replaceRequirementRuns<
  T extends { id: string; requirementId: string; startedAt: string },
>(runs: readonly T[], requirementId: string, requirementRuns: readonly T[]): T[] {
  return [
    ...runs.filter((run) => run.requirementId !== requirementId),
    ...requirementRuns,
  ].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}
