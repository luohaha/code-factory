'use client';

import { useMemo, useState } from 'react';
import {
  Bot,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Network,
  UserRound,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import type { RequirementDto, RequirementStatus } from '@/lib/agent-manager-client';
import { buildRequirementForest, type RequirementTreeNode } from '@/lib/requirement-tree';
import { useI18n } from '@/lib/i18n';
import type { TranslationKey } from '@/locales/zh-CN';

const statusLabel: Record<RequirementStatus, TranslationKey> = {
  todo: 'TODO',
  doing: 'DOING',
  waiting_confirmation: 'Awaiting confirmation',
  done: 'DONE',
  cancelled: 'Cancelled',
};

const statusTone: Record<RequirementStatus, string> = {
  todo: 'bg-sky-500',
  doing: 'bg-amber-500',
  waiting_confirmation: 'bg-violet-500',
  done: 'bg-emerald-600',
  cancelled: 'bg-slate-400',
};

function compactId(id: string): string {
  return id.replace(/^req_/, '').slice(0, 7).toUpperCase();
}

function RequirementTreeCard({
  node,
  collapsed,
  onOpen,
  onToggle,
}: {
  node: RequirementTreeNode<RequirementDto>;
  collapsed: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { locale, t } = useI18n();
  const requirement = node.requirement;
  const hasChildren = node.children.length > 0;
  const updatedAt = new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(requirement.updatedAt));

  return (
    <article className="group relative w-64 shrink-0 rounded-xl border border-border/80 bg-card shadow-[0_2px_10px_oklch(0.18_0.02_255/0.06)] transition hover:border-foreground/25 hover:shadow-[0_10px_30px_oklch(0.18_0.02_255/0.1)]">
      <button
        type="button"
        className="block w-full rounded-xl p-3.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => onOpen(requirement.id)}
        aria-label={t('Open {name}', { name: requirement.title })}
      >
        <span className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${statusTone[requirement.status]}`} />
            <span className="font-mono text-[9px] font-semibold text-muted-foreground">REQ-{compactId(requirement.id)}</span>
          </span>
          <span className="text-[9px] text-muted-foreground">{updatedAt}</span>
        </span>
        <span className="mt-2.5 line-clamp-2 block text-[13px] leading-5 font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] group-hover:underline">
          {requirement.title}
        </span>
        <span className="mt-3 flex items-center justify-between gap-2 border-t border-border/65 pt-2.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[9px] text-muted-foreground">
            {requirement.createdBy === 'rd_agent' ? <Bot className="size-3" /> : <UserRound className="size-3" />}
            <span className="truncate">{t(requirement.createdBy === 'rd_agent' ? 'Agent-created' : 'Human-created')}</span>
          </span>
          <Badge variant="outline" className="h-4 rounded px-1.5 text-[8px]">
            {t(statusLabel[requirement.status])}
          </Badge>
        </span>
      </button>

      {hasChildren ? (
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          className="absolute top-1/2 -right-3 z-10 -translate-y-1/2 rounded-full bg-background shadow-sm"
          onClick={() => onToggle(requirement.id)}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'Expand child requirements' : 'Collapse child requirements')}
          title={t('{count} child requirements', { count: node.children.length })}
        >
          <ChevronRight className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        </Button>
      ) : null}
    </article>
  );
}

function RequirementTreeBranch({
  node,
  collapsedIds,
  onOpen,
  onToggle,
}: {
  node: RequirementTreeNode<RequirementDto>;
  collapsedIds: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const collapsed = collapsedIds.has(node.requirement.id);
  return (
    <li className="requirement-tree-branch" role="treeitem" aria-expanded={node.children.length ? !collapsed : undefined}>
      <RequirementTreeCard node={node} collapsed={collapsed} onOpen={onOpen} onToggle={onToggle} />
      {node.children.length > 0 && !collapsed ? (
        <ul className="requirement-tree-children" role="group">
          {node.children.map((child) => (
            <RequirementTreeBranch
              key={child.requirement.id}
              node={child}
              collapsedIds={collapsedIds}
              onOpen={onOpen}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function RequirementTreeView({
  requirements,
  visibleRequirementIds,
  loading,
  filtered,
  onOpen,
}: {
  requirements: readonly RequirementDto[];
  visibleRequirementIds: ReadonlySet<string>;
  loading: boolean;
  filtered: boolean;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const forest = useMemo(
    () => buildRequirementForest(requirements, visibleRequirementIds),
    [requirements, visibleRequirementIds],
  );
  const parentIds = useMemo(() => {
    const ids = new Set<string>();
    const visit = (node: RequirementTreeNode<RequirementDto>) => {
      if (node.children.length) ids.add(node.requirement.id);
      for (const child of node.children) visit(child);
    };
    for (const root of forest) visit(root);
    return ids;
  }, [forest]);

  const toggle = (id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (forest.length === 0) {
    return (
      <Empty className="min-h-[calc(100vh-260px)] border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Network /></EmptyMedia>
          <EmptyTitle>{loading ? t('Loading…') : t(filtered ? 'No matching relationships' : 'No relationship data')}</EmptyTitle>
          <EmptyDescription>
            {t(filtered ? 'Try changing the filters or search query.' : 'Create requirements or let an RD Agent propose follow-up work to build the tree.')}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="min-w-max p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Network className="size-3.5" />
          <span>{t(filtered ? 'Matches are shown with their ancestors for context.' : 'Roots are ordered by recent activity; children follow creation order.')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="xs" onClick={() => setCollapsedIds(new Set(parentIds))}>
            <ChevronsDownUp data-icon="inline-start" />{t('Collapse all')}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setCollapsedIds(new Set())}>
            <ChevronsUpDown data-icon="inline-start" />{t('Expand all')}
          </Button>
        </div>
      </div>
      <ul className="requirement-tree-roots" role="tree" aria-label={t('Requirement relationship tree')}>
        {forest.map((root) => (
          <RequirementTreeBranch
            key={root.requirement.id}
            node={root}
            collapsedIds={collapsedIds}
            onOpen={onOpen}
            onToggle={toggle}
          />
        ))}
      </ul>
    </div>
  );
}
