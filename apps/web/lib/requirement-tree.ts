export interface RequirementRelationRecord {
  id: string;
  parentRequirementId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementTreeNode<T extends RequirementRelationRecord> {
  requirement: T;
  children: RequirementTreeNode<T>[];
  depth: number;
}

export interface RequirementRelationSummary {
  roots: number;
  linked: number;
  levels: number;
}

function createsCycle<T extends RequirementRelationRecord>(
  requirement: T,
  requirementsById: ReadonlyMap<string, T>,
): boolean {
  let ancestorId = requirement.parentRequirementId;
  const visited = new Set<string>();

  while (ancestorId) {
    if (ancestorId === requirement.id) return true;
    if (visited.has(ancestorId)) return true;
    visited.add(ancestorId);
    ancestorId = requirementsById.get(ancestorId)?.parentRequirementId ?? null;
  }

  return false;
}

function sortTree<T extends RequirementRelationRecord>(nodes: RequirementTreeNode<T>[], roots: boolean): void {
  nodes.sort((left, right) => roots
    ? right.requirement.updatedAt.localeCompare(left.requirement.updatedAt)
    : left.requirement.createdAt.localeCompare(right.requirement.createdAt));
  for (const node of nodes) sortTree(node.children, false);
}

export function buildRequirementForest<T extends RequirementRelationRecord>(
  requirements: readonly T[],
  visibleRequirementIds?: ReadonlySet<string>,
): RequirementTreeNode<T>[] {
  const requirementsById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const includedIds = visibleRequirementIds
    ? new Set([...visibleRequirementIds].filter((id) => requirementsById.has(id)))
    : new Set(requirementsById.keys());

  for (const id of includedIds) {
    let parentId = requirementsById.get(id)?.parentRequirementId ?? null;
    const visited = new Set<string>([id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (!requirementsById.has(parentId)) break;
      includedIds.add(parentId);
      parentId = requirementsById.get(parentId)?.parentRequirementId ?? null;
    }
  }

  const nodesById = new Map<string, RequirementTreeNode<T>>();
  for (const requirement of requirements) {
    if (includedIds.has(requirement.id)) {
      nodesById.set(requirement.id, { requirement, children: [], depth: 0 });
    }
  }

  const roots: RequirementTreeNode<T>[] = [];
  for (const node of nodesById.values()) {
    const parent = node.requirement.parentRequirementId
      ? nodesById.get(node.requirement.parentRequirementId)
      : undefined;
    if (!parent || createsCycle(node.requirement, requirementsById)) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  const assignDepth = (node: RequirementTreeNode<T>, depth: number) => {
    node.depth = depth;
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  for (const root of roots) assignDepth(root, 0);
  sortTree(roots, true);

  return roots;
}

export function summarizeRequirementRelations<T extends RequirementRelationRecord>(
  requirements: readonly T[],
): RequirementRelationSummary {
  const forest = buildRequirementForest(requirements);
  let levels = 0;
  const visit = (node: RequirementTreeNode<T>) => {
    levels = Math.max(levels, node.depth + 1);
    for (const child of node.children) visit(child);
  };
  for (const root of forest) visit(root);

  return {
    roots: forest.length,
    linked: requirements.filter((requirement) => requirement.parentRequirementId !== null).length,
    levels,
  };
}
