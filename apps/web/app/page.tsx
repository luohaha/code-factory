'use client';

import Image from 'next/image';
import { type SyntheticEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  CircleDot,
  Clock3,
  FileText,
  FolderGit2,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LayoutDashboard,
  Languages,
  LoaderCircle,
  MessagesSquare,
  MessageSquareReply,
  Moon,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Send,
  Settings2,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  Trash2,
  TriangleAlert,
  UserRound,
  WifiOff,
  X,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import {
  AgentManagerApiError,
  AgentManagerClient,
  DEFAULT_AGENT_MANAGER_URL,
  normalizeManagerUrl,
  type AgentConfiguration,
  type AgentManagerConfiguration,
  type AgentManagerConfigurationSnapshot,
  type AgentModelCatalogDto,
  type AgentProvider,
  type AgentReasoningEffort,
  type AgentRunDto,
  type ManagerEventDto,
  type MessageAttachmentDto,
  type PullRequestDto,
  type PullRequestStatus,
  type RequirementDto,
  type RequirementMessageDto,
  type RequirementStatus,
  type ReviewRequestDto,
  type AgentTimerDto,
  type SearchResultDto,
  type SessionState,
  type WorkspaceDto,
} from '@/lib/agent-manager-client';
import { countAddedMessages, isAwayFromConversationTop, isNearConversationBottom } from '@/lib/conversation-scroll';
import { formatDuration } from '@/lib/format-duration';
import { I18nProvider, useI18n } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import type { TranslationKey } from '@/locales/zh-CN';

type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline';
type TimeRange = '1d' | '7d' | '30d' | '90d' | 'all';
type DashboardView = 'requirements' | 'pull_requests' | 'sessions' | 'timers';

const timeRangeOptions: Array<{ value: TimeRange; label: TranslationKey }> = [
  { value: '1d', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

const timeRangeMilliseconds: Record<Exclude<TimeRange, 'all'>, number> = {
  '1d': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
  '90d': 90 * 24 * 60 * 60 * 1_000,
};
const filterClockIntervalMilliseconds = 60_000;

const requirementColumns: Array<{
  status: RequirementStatus;
  title: TranslationKey;
  description: TranslationKey;
  tone: string;
}> = [
  { status: 'todo', title: 'TODO', description: 'Session assigned, not started', tone: 'bg-sky-500' },
  { status: 'doing', title: 'DOING', description: 'Working or awaiting PR events', tone: 'bg-amber-500' },
  { status: 'waiting_confirmation', title: 'AWAITING CONFIRMATION', description: 'Reply to continue or confirm completion', tone: 'bg-violet-500' },
  { status: 'done', title: 'DONE', description: 'Completed; reply to reactivate', tone: 'bg-emerald-600' },
];

const pullRequestColumns: Array<{ status: PullRequestStatus; title: TranslationKey; description: TranslationKey; tone: string }> = [
  { status: 'draft', title: 'DRAFT', description: 'Still in preparation; review unavailable', tone: 'bg-slate-400' },
  { status: 'open', title: 'OPEN', description: 'A human can request an Agent review', tone: 'bg-emerald-500' },
  { status: 'closed', title: 'CLOSED', description: 'Closed without being merged', tone: 'bg-rose-500' },
  { status: 'merged', title: 'MERGED', description: 'Merged into the target branch', tone: 'bg-violet-500' },
];

const sessionColumns: Array<{
  state: SessionState;
  title: TranslationKey;
  description: TranslationKey;
  tone: string;
}> = [
  { state: 'idle', title: 'IDLE', description: 'Session assigned, no Run yet', tone: 'bg-slate-400' },
  { state: 'running', title: 'RUNNING', description: 'Headless CLI is running', tone: 'bg-emerald-500' },
  { state: 'waiting_human', title: 'WAITING FOR HUMAN', description: 'Awaiting a reply or completion confirmation', tone: 'bg-violet-500' },
  { state: 'failed', title: 'FAILED', description: 'Can continue in the original Session', tone: 'bg-rose-500' },
  { state: 'completed', title: 'COMPLETED', description: 'Requirement complete; reply to reactivate', tone: 'bg-teal-600' },
];

const agentTimerColumns: Array<{
  status: AgentTimerDto['status'];
  title: TranslationKey;
  description: TranslationKey;
  tone: string;
}> = [
  { status: 'active', title: 'ACTIVE', description: 'Waiting for the next scheduled wake-up', tone: 'bg-emerald-500' },
  { status: 'completed', title: 'COMPLETED', description: 'One-time wake-up delivered', tone: 'bg-violet-500' },
  { status: 'cancelled', title: 'CANCELLED', description: 'Stopped manually or with its Requirement', tone: 'bg-slate-400' },
];

const stateLabel: Record<SessionState, TranslationKey> = {
  idle: 'Idle',
  running: 'Running',
  waiting_human: 'Waiting for human',
  failed: 'Failed',
  completed: 'Completed',
};

const stateDot: Record<SessionState, string> = {
  idle: 'bg-slate-400',
  running: 'bg-emerald-500',
  waiting_human: 'bg-violet-500',
  failed: 'bg-rose-500',
  completed: 'bg-teal-600',
};

const statusLabel: Record<RequirementStatus, TranslationKey> = {
  todo: 'TODO',
  doing: 'DOING',
  waiting_confirmation: 'Awaiting confirmation',
  done: 'DONE',
  cancelled: 'Cancelled',
};

const runStatusLabel: Record<AgentRunDto['status'], TranslationKey> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
};

const authorLabel: Record<RequirementMessageDto['author'], TranslationKey> = {
  human: 'Human',
  rd_agent: 'RD Agent',
  reviewer: 'Reviewer',
  system: 'System',
};

const searchKindLabel: Record<SearchResultDto['kind'], TranslationKey> = {
  requirement: 'Requirement match',
  message: 'Conversation match',
  pull_request: 'Pull Request match',
};

function providerLabel(provider: AgentProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
}

function AgentModelSelect({ catalog, provider, value, onChange, id, name, disabled, size, ariaLabel }: {
  catalog: AgentModelCatalogDto | null;
  provider: AgentProvider;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  disabled?: boolean;
  size?: 'sm' | 'default';
  ariaLabel?: string;
}) {
  const { t } = useI18n();
  const models = catalog?.providers.find((entry) => entry.provider === provider)?.models ?? [];
  const selectedMissing = value && !models.some((model) => model.id === value);
  return (
    <NativeSelect
      id={id}
      name={name}
      value={value}
      disabled={disabled}
      size={size}
      onChange={(event) => onChange(event.target.value)}
      className="w-full"
      aria-label={ariaLabel}
    >
      <NativeSelectOption value="">{t('Use CLI default model')}</NativeSelectOption>
      {selectedMissing ? <NativeSelectOption value={value}>{value}</NativeSelectOption> : null}
      {models.map((model) => (
        <NativeSelectOption key={model.id} value={model.id} title={model.description ?? model.id}>
          {model.displayName === model.id ? model.id : `${model.displayName} · ${model.id}`}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

function agentConfigurationLabel(configuration: {
  provider: AgentProvider;
  model: string | null;
  reasoningEffort: AgentReasoningEffort | null;
}): string {
  return [providerLabel(configuration.provider), configuration.model, configuration.reasoningEffort].filter(Boolean).join(' · ');
}

function shortId(id: string): string {
  const value = id.replace(/^(req|ses|run|msg|tmr)_/, '');
  return value.length > 12 ? value.slice(0, 8) : value;
}

function formatAge(value: string, t: ReturnType<typeof useI18n>['t']): string {
  const milliseconds = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return t('just now');
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t('{count}m', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('{count}h', { count: hours });
  return t('{count}d', { count: Math.floor(hours / 24) });
}

function formatTime(value: string, locale: 'en' | 'zh-CN'): string {
  return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function isWithinTimeRange(value: string, timeRange: TimeRange, now: number): boolean {
  if (timeRange === 'all') return true;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= now - timeRangeMilliseconds[timeRange];
}

function MessageBody({ body, inverted = false }: { body: string; inverted?: boolean }) {
  return (
    <div className={`message-markdown ${inverted ? 'message-markdown-inverted' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function MessageAttachments({ attachments, apiUrl }: { attachments: MessageAttachmentDto[]; apiUrl: string }) {
  const { t } = useI18n();
  if (attachments.length === 0) return null;
  const images = attachments.filter((attachment) => attachment.kind === 'image');
  const files = attachments.filter((attachment) => attachment.kind !== 'image');
  return (
    <div className="space-y-2">
      {images.length > 0 ? (
        <div className={`grid gap-2 ${images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {images.map((attachment) => {
            const url = `${apiUrl}/api/attachments/${encodeURIComponent(attachment.id)}`;
            return (
              <a
                key={attachment.id}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="group relative block min-w-0 overflow-hidden rounded-xl border border-black/8 bg-black/4 dark:border-white/10 dark:bg-white/5"
                title={t('Open {name}', { name: attachment.fileName })}
              >
                {/* oxlint-disable-next-line next/no-img-element -- Attachment URLs are dynamic local API resources. */}
                <img
                  src={url}
                  alt={attachment.fileName}
                  loading="lazy"
                  className="max-h-72 min-h-24 w-full object-cover transition duration-200 group-hover:scale-[1.015]"
                />
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-2 py-1 text-[9px] text-white opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
                  {attachment.fileName}
                </span>
              </a>
            );
          })}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="space-y-1.5">
          {files.map((attachment) => (
            <a
              key={attachment.id}
              href={`${apiUrl}/api/attachments/${encodeURIComponent(attachment.id)}`}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-2.5 rounded-xl border border-black/8 bg-black/4 px-3 py-2.5 transition hover:bg-black/7 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/8"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background/70 text-foreground"><FileText className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium">{attachment.fileName}</span>
                <span className="mt-0.5 block text-[9px] opacity-65">{formatBytes(attachment.byteSize)} · {attachment.mediaType}</span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface DraftAttachment {
  id: string;
  file: File;
  previewUrl: string | null;
}

const previewableImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const maxAttachmentBytes = 20 * 1024 * 1024;
const maxAttachmentsPerMessage = 6;

function latestRun(requirementId: string, runs: AgentRunDto[]): AgentRunDto | undefined {
  return runs.find((run) => run.requirementId === requirementId);
}

function RequirementCard({
  requirement,
  run,
  searchMatch,
  busy,
  onOpen,
  onStart,
  onDelete,
  onConfirm,
}: {
  requirement: RequirementDto;
  run?: AgentRunDto;
  searchMatch?: SearchResultDto;
  busy: boolean;
  onOpen: () => void;
  onStart: () => void;
  onDelete: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <article className="rounded-xl border border-border/80 bg-card p-3.5 shadow-[0_1px_2px_oklch(0.18_0.02_255/0.05)] transition hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-[0_8px_24px_oklch(0.18_0.02_255/0.08)]">
      <div className="flex items-start justify-between gap-3">
        <Badge variant="outline" className="h-5 rounded-md bg-muted/45 px-1.5 font-mono text-[10px] text-muted-foreground">
          REQ-{shortId(requirement.id)}
        </Badge>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock3 className="size-3" />{formatAge(requirement.updatedAt, t)}
        </span>
      </div>

      <button type="button" className="mt-2.5 block w-full min-w-0 overflow-hidden text-left" onClick={onOpen}>
        <h3 className="line-clamp-2 text-[13px] leading-5 font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] hover:underline">{requirement.title}</h3>
        <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">{requirement.description}</p>
      </button>

      {searchMatch ? (
        <button type="button" className="mt-3 block w-full rounded-lg bg-sky-500/7 px-2.5 py-2 text-left" onClick={onOpen}>
          <span className="flex items-center gap-1.5 text-[9px] font-semibold text-sky-700 dark:text-sky-300">
            <Search className="size-3" />{t(searchKindLabel[searchMatch.kind])}
          </span>
          <span className="mt-1 line-clamp-2 block text-[10px] leading-4 text-foreground/75 [overflow-wrap:anywhere]">{searchMatch.excerpt || searchMatch.title}</span>
        </button>
      ) : null}

      {requirement.session.lastError ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-rose-500/8 px-2.5 py-2 text-[10px] leading-4 text-rose-700 dark:text-rose-300">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />{requirement.session.lastError}
        </div>
      ) : null}

      <div className="mt-3 border-t border-border/70 pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${stateDot[requirement.session.state]}`} />
            <span className="text-[10px] font-medium">RD · {t(stateLabel[requirement.session.state])}</span>
          </div>
          <span className="max-w-32 shrink-0 truncate font-mono text-[9px] text-muted-foreground" title={agentConfigurationLabel(requirement)}>{agentConfigurationLabel(requirement)}</span>
        </div>
        <p className="mt-1.5 truncate font-mono text-[9px] text-muted-foreground">ses-{shortId(requirement.session.id)}</p>
        {run ? <p className="mt-2 text-[10px] text-foreground/70">{run.taskSummary} · {t(runStatusLabel[run.status])}</p> : null}
        {requirement.session.pendingMessageCount > 0 ? (
          <p className="mt-2 text-[10px] font-medium text-amber-600">{t('{count} messages pending', { count: requirement.session.pendingMessageCount })}</p>
        ) : null}
      </div>

      {requirement.status === 'todo' ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="xs" disabled={busy} onClick={onStart}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Play data-icon="inline-start" />}{t('Start')}
          </Button>
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogTrigger render={<Button size="xs" variant="destructive" disabled={busy} />}>
              <Trash2 data-icon="inline-start" />{t('Delete')}
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>{t('Delete requirement?')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('Delete “{title}”? This only works before execution and cannot be undone.', { title: requirement.title })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    setDeleteOpen(false);
                    onDelete();
                  }}
                >
                  <Trash2 data-icon="inline-start" />{t('Delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : null}
      {requirement.status === 'waiting_confirmation' ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={onOpen}><MessageSquareReply data-icon="inline-start" />{t('Reply')}</Button>
          <Button size="xs" disabled={busy} onClick={onConfirm}><Check data-icon="inline-start" />{t('Complete')}</Button>
        </div>
      ) : null}
      {requirement.status === 'doing' && requirement.session.state !== 'running' ? (
        <Button size="xs" variant="outline" className="mt-3 w-full" onClick={onOpen}><MessageSquareReply data-icon="inline-start" />{t('Open conversation')}</Button>
      ) : null}
      {requirement.status === 'done' ? (
        <Button size="xs" variant="outline" className="mt-3 w-full" onClick={onOpen}><MessageSquareReply data-icon="inline-start" />{t('Reply')}</Button>
      ) : null}
    </article>
  );
}

function SessionCard({ requirement, run, busy, onOpen, onRetry }: {
  requirement: RequirementDto;
  run?: AgentRunDto;
  busy: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <article className="rounded-xl border border-border/80 bg-card p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${stateDot[requirement.session.state]}`} />
          <span className="font-mono text-[10px] font-semibold">REQ-{shortId(requirement.id)}</span>
        </div>
        <Badge variant="secondary" className="h-5 max-w-40 truncate font-mono text-[9px]" title={agentConfigurationLabel(requirement)}>{agentConfigurationLabel(requirement)}</Badge>
      </div>
      <button type="button" className="mt-2.5 block w-full text-left" onClick={onOpen}>
        <h3 className="truncate text-xs font-semibold hover:underline">{requirement.title}</h3>
        <p className="mt-1.5 truncate font-mono text-[9px] text-muted-foreground">ses-{shortId(requirement.session.id)}</p>
      </button>
      {run ? <p className="mt-2.5 text-[10px] leading-4 text-foreground/75">{run.taskSummary} · {t(runStatusLabel[run.status])}</p> : null}
      {requirement.session.pendingMessageCount > 0 ? (
        <p className="mt-2 text-[10px] font-medium text-amber-600">{t('{count} external messages pending', { count: requirement.session.pendingMessageCount })}</p>
      ) : null}
      {requirement.session.lastError ? (
        <Button size="xs" variant="destructive" className="mt-3 w-full" disabled={busy} onClick={onRetry}>
          {busy ? <LoaderCircle className="animate-spin" /> : <RotateCcw data-icon="inline-start" />}{t('Retry original Session')}
        </Button>
      ) : null}
    </article>
  );
}

function ReviewAgentDialog({ activeReview, busy, modelCatalog, onReview }: {
  activeReview?: ReviewRequestDto;
  busy: boolean;
  modelCatalog: AgentModelCatalogDto | null;
  onReview: (configuration: AgentConfiguration) => Promise<void>;
}) {
  const { t } = useI18n();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AgentProvider>('codex');
  const [model, setModel] = useState('');
  const disabled = busy || submitting || Boolean(activeReview);

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const reasoningEffort = form.get('reasoningEffort');
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onReview({
        provider,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(typeof reasoningEffort === 'string' && reasoningEffort
          ? { reasoningEffort: reasoningEffort as AgentReasoningEffort }
          : {}),
      });
      formElement.reset();
      setProvider('codex');
      setModel('');
      setOpen(false);
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : t('Failed to request a review'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setSubmitError(null);
      }}
    >
      <DialogTrigger render={<Button size="xs" disabled={disabled} />}>
        {disabled ? <LoaderCircle className="animate-spin" /> : <ScanSearch data-icon="inline-start" />}
        {activeReview ? t('Reviewing') : t('Request review')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('Request a PR review')}</DialogTitle>
            <DialogDescription>{t('Choose an Agent type, model, and reasoning effort for this one-off review.')}</DialogDescription>
          </DialogHeader>
          {submitError ? (
            <Alert variant="destructive" className="mt-5">
              <TriangleAlert />
              <AlertTitle>{t('Failed to request a review')}</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup className="my-5 gap-4">
            <Field>
              <FieldLabel htmlFor={`${fieldId}-provider`}>{t('Reviewer Agent')}</FieldLabel>
              <NativeSelect
                id={`${fieldId}-provider`}
                name="provider"
                className="w-full"
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as AgentProvider);
                  setModel('');
                }}
              >
                <NativeSelectOption value="codex">{t('Codex Reviewer')}</NativeSelectOption>
                <NativeSelectOption value="claude-code">{t('Claude Reviewer')}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-model`}>{t('Model')}</FieldLabel>
              <AgentModelSelect
                id={`${fieldId}-model`}
                name="model"
                catalog={modelCatalog}
                provider={provider}
                value={model}
                onChange={setModel}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-reasoning-effort`}>{t('Reasoning effort')}</FieldLabel>
              <NativeSelect id={`${fieldId}-reasoning-effort`} name="reasoningEffort" className="w-full" defaultValue="">
                <NativeSelectOption value="">{t('Default reasoning')}</NativeSelectOption>
                <NativeSelectOption value="low">Low</NativeSelectOption>
                <NativeSelectOption value="medium">Medium</NativeSelectOption>
                <NativeSelectOption value="high">High</NativeSelectOption>
                <NativeSelectOption value="xhigh">XHigh</NativeSelectOption>
                <NativeSelectOption value="max">Max</NativeSelectOption>
              </NativeSelect>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{t('Cancel')}</DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? <LoaderCircle className="animate-spin" /> : <ScanSearch data-icon="inline-start" />}
              {t('Request review')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PullRequestCard({ pullRequest, requirement, activeReview, busy, modelCatalog, onReview }: {
  pullRequest: PullRequestDto;
  requirement?: RequirementDto;
  activeReview?: ReviewRequestDto;
  busy: boolean;
  modelCatalog: AgentModelCatalogDto | null;
  onReview: (configuration: AgentConfiguration) => Promise<void>;
}) {
  return (
    <article className="rounded-xl border border-border/80 bg-card p-3.5 shadow-[0_1px_2px_oklch(0.18_0.02_255/0.05)]">
      <div className="flex items-center justify-between gap-3">
        <Badge variant="outline" className="h-5 font-mono text-[10px]">{pullRequest.repository}#{pullRequest.number}</Badge>
        <span className="font-mono text-[9px] text-muted-foreground">{pullRequest.headSha.slice(0, 8)}</span>
      </div>
      <a href={pullRequest.url} target="_blank" rel="noreferrer" className="mt-2.5 flex items-start gap-1.5 text-[13px] leading-5 font-semibold hover:underline">
        <span className="min-w-0 flex-1">{pullRequest.title}</span><ExternalLink className="mt-0.5 size-3 shrink-0" />
      </a>
      <p className="mt-1 text-[10px] text-muted-foreground">{pullRequest.headBranch} → {pullRequest.baseBranch}</p>
      {requirement ? (
        <p className="mt-2 truncate text-[10px] text-foreground/75">REQ-{shortId(requirement.id)} · {requirement.title}</p>
      ) : null}
      {pullRequest.status === 'open' ? (
        <div className="mt-3 border-t border-border/70 pt-3">
          <ReviewAgentDialog activeReview={activeReview} busy={busy} modelCatalog={modelCatalog} onReview={onReview} />
        </div>
      ) : null}
    </article>
  );
}

function AgentTimerCard({ timer, requirement, onOpenRequirement }: {
  timer: AgentTimerDto;
  requirement?: RequirementDto;
  onOpenRequirement: () => void;
}) {
  const { locale, t } = useI18n();
  const status = agentTimerColumns.find((column) => column.status === timer.status);
  const eventLabel = timer.status === 'active'
    ? t('Next wake-up')
    : timer.status === 'completed' ? t('Last wake-up') : t('Stopped');
  const eventTime = timer.status === 'active'
    ? timer.nextFireAt
    : timer.status === 'completed' ? timer.lastFiredAt : timer.updatedAt;

  return (
    <article className="rounded-xl border border-border/80 bg-card p-3.5 shadow-[0_1px_2px_oklch(0.18_0.02_255/0.05)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-primary/8 text-primary"><Clock3 className="size-3.5" /></span>
          <Badge variant="outline" className="h-5 font-mono text-[9px]">TIMER-{shortId(timer.id)}</Badge>
        </div>
        <span className="flex items-center gap-1.5 text-[9px] font-medium text-muted-foreground">
          <span className={`size-1.5 rounded-full ${status?.tone ?? 'bg-slate-400'}`} />
          {status ? t(status.title) : timer.status.toUpperCase()}
        </span>
      </div>

      <p className="mt-3 text-[13px] font-semibold">
        {timer.description}
      </p>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {timer.schedule === 'once'
          ? t('Once after {duration}', { duration: formatDuration(timer.intervalSeconds, t) })
          : t('Every {duration}', { duration: formatDuration(timer.intervalSeconds, t) })}
      </p>

      <div className="mt-3 rounded-lg border border-border/70 bg-muted/35 px-3 py-2.5">
        <p className="truncate text-[11px] font-medium">{requirement?.title ?? t('Requirement unavailable')}</p>
        <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">
          REQ-{shortId(timer.requirementId)}{requirement ? ` · ${providerLabel(requirement.provider)}` : ''}
        </p>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div className="rounded-lg bg-muted/30 px-2.5 py-2">
          <dt className="text-[9px] text-muted-foreground">{t('Interval')}</dt>
          <dd className="mt-0.5 font-medium">{formatDuration(timer.intervalSeconds, t)}</dd>
        </div>
        <div className="rounded-lg bg-muted/30 px-2.5 py-2">
          <dt className="text-[9px] text-muted-foreground">{eventLabel}</dt>
          <dd className="mt-0.5 font-medium">{eventTime ? formatTime(eventTime, locale) : '—'}</dd>
        </div>
      </dl>

      {requirement ? (
        <Button variant="ghost" size="xs" className="mt-3 w-full" onClick={onOpenRequirement}>
          <MessagesSquare data-icon="inline-start" />{t('Open requirement')}
        </Button>
      ) : null}
    </article>
  );
}

function RequirementPullRequestCard({ pullRequest, activeReview, busy, modelCatalog, onReview }: {
  pullRequest: PullRequestDto;
  activeReview?: ReviewRequestDto;
  busy: boolean;
  modelCatalog: AgentModelCatalogDto | null;
  onReview: (configuration: AgentConfiguration) => Promise<void>;
}) {
  const { t } = useI18n();
  const status = pullRequestColumns.find((column) => column.status === pullRequest.status);

  return (
    <article className="rounded-xl border border-border/80 bg-card px-4 py-3.5 shadow-[0_1px_2px_oklch(0.18_0.02_255/0.04)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="h-5 font-mono text-[10px]">{pullRequest.repository}#{pullRequest.number}</Badge>
            <span className="flex items-center gap-1.5 text-[9px] font-medium text-muted-foreground">
              <span className={`size-1.5 rounded-full ${status?.tone ?? 'bg-slate-400'}`} />
              {status ? t(status.title) : pullRequest.status.toUpperCase()}
            </span>
            <span className="font-mono text-[9px] text-muted-foreground">{pullRequest.headSha.slice(0, 8)}</span>
          </div>
          <a href={pullRequest.url} target="_blank" rel="noreferrer" className="mt-2 flex w-fit max-w-full items-start gap-1.5 text-[13px] leading-5 font-semibold hover:underline">
            <span className="min-w-0">{pullRequest.title}</span><ExternalLink className="mt-0.5 size-3 shrink-0" />
          </a>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{pullRequest.headBranch} → {pullRequest.baseBranch}</span>
          </p>
        </div>

        {pullRequest.status === 'open' ? (
          <div className="w-full shrink-0 border-t border-border/70 pt-3 sm:w-auto sm:border-t-0 sm:pt-0">
            <ReviewAgentDialog activeReview={activeReview} busy={busy} modelCatalog={modelCatalog} onReview={onReview} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function NewRequirementDialog({ disabled, modelCatalog, onCreate }: {
  disabled: boolean;
  modelCatalog: AgentModelCatalogDto | null;
  onCreate: (input: { title: string; description: string } & AgentConfiguration) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [provider, setProvider] = useState<AgentProvider>('codex');
  const [model, setModel] = useState('');

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const title = form.get('title');
    const description = form.get('description');
    const reasoningEffort = form.get('reasoningEffort');
    if (typeof title !== 'string' || typeof description !== 'string') return;
    setSubmitting(true);
    try {
      await onCreate({
        title: title.trim(),
        description: description.trim(),
        provider,
        ...(model ? { model } : {}),
        ...(typeof reasoningEffort === 'string' && reasoningEffort
          ? { reasoningEffort: reasoningEffort as AgentReasoningEffort }
          : {}),
      });
      formElement.reset();
      setProvider('codex');
      setModel('');
      setOpen(false);
    } catch {
      // The parent surfaces the API error while the dialog keeps the entered values.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" disabled={disabled} />}><Plus data-icon="inline-start" />{t('New requirement')}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-hidden p-0 sm:max-w-lg">
        <form className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col" onSubmit={submit}>
          <DialogHeader className="shrink-0 px-4 pt-4 pr-12">
            <DialogTitle>{t('Create a requirement and RD Session')}</DialogTitle>
            <DialogDescription>{t('A unique Session is assigned immediately, with no scheduling or Agent allocation.')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-4">
            <FieldGroup className="my-5 gap-4">
              <Field>
                <FieldLabel htmlFor="requirement-title">{t('Requirement title')}</FieldLabel>
                <Input id="requirement-title" name="title" required placeholder={t('For example: improve bulk import throughput')} />
              </Field>
              <Field>
                <FieldLabel htmlFor="requirement-description">{t('Task and acceptance criteria')}</FieldLabel>
                <Textarea
                  id="requirement-description"
                  name="description"
                  className="max-h-56 overflow-y-auto"
                  required
                  placeholder={t('Feature work, validation, or performance goals')}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="requirement-provider">{t('RD Agent')}</FieldLabel>
                <NativeSelect
                  id="requirement-provider"
                  name="provider"
                  className="w-full"
                  value={provider}
                  onChange={(event) => {
                    setProvider(event.target.value as AgentProvider);
                    setModel('');
                  }}
                >
                  <NativeSelectOption value="codex">Codex headless</NativeSelectOption>
                  <NativeSelectOption value="claude-code">Claude Code headless</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="requirement-model">{t('Model')}</FieldLabel>
                <AgentModelSelect
                  id="requirement-model"
                  name="model"
                  catalog={modelCatalog}
                  provider={provider}
                  value={model}
                  onChange={setModel}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="requirement-reasoning-effort">{t('Reasoning effort')}</FieldLabel>
                <NativeSelect id="requirement-reasoning-effort" name="reasoningEffort" className="w-full" defaultValue="">
                  <NativeSelectOption value="">{t('Default reasoning')}</NativeSelectOption>
                  <NativeSelectOption value="low">Low</NativeSelectOption>
                  <NativeSelectOption value="medium">Medium</NativeSelectOption>
                  <NativeSelectOption value="high">High</NativeSelectOption>
                  <NativeSelectOption value="xhigh">XHigh</NativeSelectOption>
                  <NativeSelectOption value="max">Max</NativeSelectOption>
                </NativeSelect>
              </Field>
            </FieldGroup>
          </div>
          <DialogFooter className="mx-0 mb-0 shrink-0">
            <DialogClose render={<Button type="button" variant="outline" />}>{t('Cancel')}</DialogClose>
            <Button type="submit" disabled={submitting}>{submitting ? <LoaderCircle className="animate-spin" /> : null}{t('Create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionDialog({ apiUrl, onConnect }: { apiUrl: string; onConnect: (url: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(apiUrl);
  const [error, setError] = useState<string | null>(null);

  function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    try {
      onConnect(normalizeManagerUrl(value));
      setError(null);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Invalid URL'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setValue(apiUrl); }}>
      <DialogTrigger render={<Button variant="outline" size="icon" aria-label={t('Agent Manager connection settings')} />}><Settings2 /></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('Connect to Agent Manager')}</DialogTitle>
            <DialogDescription>{t('The URL is stored in this browser and is not written to the project or uploaded.')}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-5">
            <Field>
              <FieldLabel htmlFor="manager-url">{t('HTTP URL')}</FieldLabel>
              <Input id="manager-url" value={value} onChange={(event) => setValue(event.target.value)} placeholder={DEFAULT_AGENT_MANAGER_URL} />
            </Field>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{t('Cancel')}</DialogClose>
            <Button type="submit">{t('Connect')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ManagerConfigurationDialog({
  configuration,
  disabled,
  onSave,
  workspace,
}: {
  configuration: AgentManagerConfigurationSnapshot | null;
  disabled: boolean;
  onSave: (values: Partial<AgentManagerConfiguration>) => Promise<void>;
  workspace: WorkspaceDto | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<AgentManagerConfiguration | null>(configuration?.values ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof AgentManagerConfiguration>(field: K, value: AgentManagerConfiguration[K]) {
    setValues((current) => current ? { ...current, [field]: value } : current);
  }

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (!values || !configuration) return;
    const patch = Object.fromEntries(
      (Object.keys(values) as Array<keyof AgentManagerConfiguration>)
        .filter((field) => values[field] !== configuration.values[field])
        .map((field) => [field, values[field]]),
    ) as Partial<AgentManagerConfiguration>;
    setSubmitting(true);
    setError(null);
    try {
      if (Object.keys(patch).length > 0) await onSave(patch);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Failed to save configuration'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValues(configuration?.values ?? null);
          setError(null);
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="icon" disabled={disabled} aria-label={t('Agent Manager configuration')} />}>
        <SlidersHorizontal />
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('Agent Manager configuration')}</DialogTitle>
            <DialogDescription>{t('Reconciliation and log level changes apply immediately. Other settings take effect after restart.')}</DialogDescription>
          </DialogHeader>
          {configuration?.restartRequired ? (
            <Alert className="mt-4">
              <TriangleAlert />
              <AlertTitle>{t('Restart required')}</AlertTitle>
              <AlertDescription>{t('One or more saved settings will apply the next time Agent Manager starts.')}</AlertDescription>
            </Alert>
          ) : null}
          {values ? (
            <FieldGroup className="my-5 gap-5">
              <div>
                <p className="mb-3 text-xs font-semibold">{t('Runtime settings')}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="configuration-reconcile-interval">{t('PR reconcile interval (seconds)')}</FieldLabel>
                    <Input id="configuration-reconcile-interval" type="number" min="0" max="2147483" step="1" value={values.pullRequestReconcileIntervalSeconds} onChange={(event) => update('pullRequestReconcileIntervalSeconds', Number(event.target.value))} required />
                    <p className="text-[10px] text-muted-foreground">{t('Use 0 to disable GitHub polling.')}</p>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="configuration-log-level">{t('Log level')}</FieldLabel>
                    <NativeSelect id="configuration-log-level" value={values.logLevel} onChange={(event) => update('logLevel', event.target.value as AgentManagerConfiguration['logLevel'])}>
                      <NativeSelectOption value="debug">debug</NativeSelectOption>
                      <NativeSelectOption value="info">info</NativeSelectOption>
                      <NativeSelectOption value="warn">warn</NativeSelectOption>
                      <NativeSelectOption value="error">error</NativeSelectOption>
                      <NativeSelectOption value="silent">silent</NativeSelectOption>
                    </NativeSelect>
                  </Field>
                </div>
              </div>
              <div>
                <p className="mb-3 text-xs font-semibold">{t('Startup settings')}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="configuration-host">{t('Listen host')}</FieldLabel>
                    <Input id="configuration-host" value={values.host} onChange={(event) => update('host', event.target.value)} required />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="configuration-port">{t('Listen port')}</FieldLabel>
                    <Input id="configuration-port" type="number" min="1" max="65535" step="1" value={values.port} onChange={(event) => update('port', Number(event.target.value))} required />
                  </Field>
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="configuration-origin">{t('Allowed CORS origin')}</FieldLabel>
                    <Input id="configuration-origin" value={values.allowedOrigin ?? ''} onChange={(event) => update('allowedOrigin', event.target.value.trim() ? event.target.value : null)} placeholder={t('Leave empty to disable CORS')} />
                  </Field>
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="configuration-database">{t('Database path')}</FieldLabel>
                    <Input id="configuration-database" value={values.databasePath ?? ''} onChange={(event) => update('databasePath', event.target.value.trim() ? event.target.value : null)} placeholder={workspace?.databasePath ?? t('Use workspace default')} />
                  </Field>
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="configuration-log-file">{t('Log file path')}</FieldLabel>
                    <Input id="configuration-log-file" value={values.logFilePath ?? ''} onChange={(event) => update('logFilePath', event.target.value.trim() ? event.target.value : null)} placeholder={workspace?.logFilePath ?? t('Use workspace default')} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="configuration-log-size">{t('Log rotation size')}</FieldLabel>
                    <Input id="configuration-log-size" value={values.logMaxSize} onChange={(event) => update('logMaxSize', event.target.value)} required />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="configuration-log-files">{t('Log retention')}</FieldLabel>
                    <Input id="configuration-log-files" value={values.logMaxFiles} onChange={(event) => update('logMaxFiles', event.target.value)} required />
                  </Field>
                  <label className="flex items-center gap-2 text-xs sm:col-span-2">
                    <input type="checkbox" checked={values.openDashboard} onChange={(event) => update('openDashboard', event.target.checked)} />
                    {t('Open dashboard when Agent Manager starts')}
                  </label>
                </div>
              </div>
              {configuration?.path ? <p className="break-all font-mono text-[10px] text-muted-foreground">{t('Configuration file')}: {configuration.path}</p> : null}
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </FieldGroup>
          ) : <p className="my-6 text-xs text-muted-foreground">{t('Configuration unavailable')}</p>}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{t('Cancel')}</DialogClose>
            <Button type="submit" disabled={!values || submitting}>{submitting ? <LoaderCircle className="animate-spin" /> : null}{t('Save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentTimerDialog({
  timers,
  disabled,
  busy,
  onCreate,
  onCancel,
}: {
  timers: AgentTimerDto[];
  disabled: boolean;
  busy: boolean;
  onCreate: (input: { description: string; schedule: 'once' | 'recurring'; intervalSeconds: number }) => Promise<void>;
  onCancel: (timerId: string) => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [schedule, setSchedule] = useState<'once' | 'recurring'>('once');
  const [amount, setAmount] = useState(1);
  const [unit, setUnit] = useState<'minutes' | 'hours' | 'days'>('hours');
  const active = timers.filter((timer) => timer.status === 'active');
  const secondsPerUnit = unit === 'minutes' ? 60 : unit === 'hours' ? 3_600 : 86_400;
  const intervalSeconds = amount * secondsPerUnit;
  const normalizedDescription = description.trim();
  const valid = normalizedDescription.length > 0
    && normalizedDescription.length <= 500
    && Number.isInteger(amount)
    && amount > 0
    && intervalSeconds <= 31_536_000;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || disabled || busy) return;
    try {
      await onCreate({ description: normalizedDescription, schedule, intervalSeconds });
      setDescription('');
      setOpen(false);
    } catch {
      // The dashboard-level error banner reports the API error.
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 rounded-xl px-2 text-[10px] text-muted-foreground"
            disabled={disabled}
            aria-label={t('Scheduled wake-ups')}
          />
        )}
      >
        <Clock3 data-icon="inline-start" />
        {active.length > 0 ? t('{count} scheduled', { count: active.length }) : t('Schedule')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Scheduled wake-ups')}</DialogTitle>
          <DialogDescription>{t('Wake this RD Session with a specific follow-up, once or repeatedly.')}</DialogDescription>
        </DialogHeader>

        <div className="my-4 space-y-2">
          <p className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{t('Active schedules')}</p>
          {active.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-[10px] text-muted-foreground">
              {t('No scheduled wake-ups')}
            </div>
          ) : active.map((timer) => (
            <div key={timer.id} className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary"><Clock3 className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">
                  {timer.description}
                </p>
                <p className="mt-0.5 text-[9px] text-muted-foreground">
                  {timer.schedule === 'once'
                    ? t('Once after {duration}', { duration: formatDuration(timer.intervalSeconds, t) })
                    : t('Every {duration}', { duration: formatDuration(timer.intervalSeconds, t) })}
                  {timer.nextFireAt ? ` · ${t('Next wake-up: {time}', { time: formatTime(timer.nextFireAt, locale) })}` : null}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                aria-label={t('Cancel scheduled wake-up')}
                onClick={() => void onCancel(timer.id).catch(() => undefined)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>

        <form onSubmit={submit}>
          <FieldGroup className="gap-4 border-t border-border pt-4">
            <Field>
              <FieldLabel htmlFor={`${fieldId}-description`}>{t('Timer description')}</FieldLabel>
              <Textarea
                id={`${fieldId}-description`}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={500}
                required
                placeholder={t('For example: check the compiler status')}
              />
              <p className="text-[10px] text-muted-foreground">{t('The RD Agent receives this description when the timer fires.')}</p>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor={`${fieldId}-schedule`}>{t('Pattern')}</FieldLabel>
                <NativeSelect
                  id={`${fieldId}-schedule`}
                  value={schedule}
                  onChange={(event) => setSchedule(event.target.value as 'once' | 'recurring')}
                >
                  <NativeSelectOption value="once">{t('One time')}</NativeSelectOption>
                  <NativeSelectOption value="recurring">{t('Recurring')}</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${fieldId}-amount`}>{t('Delay / interval')}</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id={`${fieldId}-amount`}
                    type="number"
                    min="1"
                    step="1"
                    value={amount}
                    onChange={(event) => setAmount(Number(event.target.value))}
                    required
                  />
                  <NativeSelect className="w-24 shrink-0" value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}>
                    <NativeSelectOption value="minutes">{t('Minutes')}</NativeSelectOption>
                    <NativeSelectOption value="hours">{t('Hours')}</NativeSelectOption>
                    <NativeSelectOption value="days">{t('Days')}</NativeSelectOption>
                  </NativeSelect>
                </div>
              </Field>
            </div>
            <p className="text-[10px] text-muted-foreground">{t('The first wake-up occurs after this interval. Recurring schedules then repeat at the same interval.')}</p>
          </FieldGroup>
          <DialogFooter className="mt-5">
            <DialogClose render={<Button type="button" variant="outline" />}>{t('Close')}</DialogClose>
            <Button type="submit" disabled={!valid || busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Clock3 />}{t('Schedule wake-up')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RequirementDetail({
  requirement,
  runs,
  messages,
  agentTimers,
  pullRequests,
  reviewRequests,
  modelCatalog,
  messageLoading,
  busy,
  busyPullRequestId,
  onOpenChange,
  onStart,
  onReply,
  onInterrupt,
  onConfirm,
  onReview,
  onCreateAgentTimer,
  onCancelAgentTimer,
  apiUrl,
}: {
  requirement: RequirementDto | null;
  runs: AgentRunDto[];
  messages: RequirementMessageDto[];
  agentTimers: AgentTimerDto[];
  pullRequests: PullRequestDto[];
  reviewRequests: ReviewRequestDto[];
  modelCatalog: AgentModelCatalogDto | null;
  messageLoading: boolean;
  busy: boolean;
  busyPullRequestId: string | null;
  onOpenChange: (open: boolean) => void;
  onStart: (message?: string, attachments?: File[]) => Promise<void>;
  onReply: (message: string, attachments?: File[]) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onConfirm: () => Promise<void>;
  onReview: (pullRequestId: string, configuration: AgentConfiguration) => Promise<void>;
  onCreateAgentTimer: (
    input: { description: string; schedule: 'once' | 'recurring'; intervalSeconds: number },
  ) => Promise<void>;
  onCancelAgentTimer: (timerId: string) => Promise<void>;
  apiUrl: string;
}) {
  const { locale, t } = useI18n();
  const [message, setMessage] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [newMessages, setNewMessages] = useState<{ requirementId: string; count: number } | null>(null);
  const [scrollToTopRequirementId, setScrollToTopRequirementId] = useState<string | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const followsLatestRef = useRef(true);
  const initializedRequirementIdRef = useRef<string | undefined>(undefined);
  const loadedRequirementIdRef = useRef<string | undefined>(undefined);
  const previousMessageIdsRef = useRef<Set<string>>(new Set());
  const open = requirement !== null;
  const requirementId = requirement?.id;
  const newMessageCount = newMessages && newMessages.requirementId === requirementId
    ? newMessages.count
    : 0;
  const showScrollToTop = scrollToTopRequirementId === requirementId;

  const scrollToLatest = useCallback(() => {
    followsLatestRef.current = true;
    setNewMessages(null);
    const viewport = scrollViewportRef.current;
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' });
  }, []);

  const scrollToTop = useCallback(() => {
    followsLatestRef.current = false;
    setScrollToTopRequirementId(null);
    scrollViewportRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  useEffect(() => {
    if (!requirementId) {
      followsLatestRef.current = true;
      initializedRequirementIdRef.current = undefined;
      loadedRequirementIdRef.current = undefined;
      previousMessageIdsRef.current = new Set();
      return;
    }
    if (messageLoading) {
      loadedRequirementIdRef.current = requirementId;
      return;
    }
    if (
      loadedRequirementIdRef.current !== requirementId
      || messages.some((item) => item.requirementId !== requirementId)
    ) return;

    const nextMessageIds = new Set(messages.map((item) => item.id));
    const isInitialLoad = initializedRequirementIdRef.current !== requirementId;
    const addedMessageCount = isInitialLoad
      ? 0
      : countAddedMessages(previousMessageIdsRef.current, messages);
    initializedRequirementIdRef.current = requirementId;
    previousMessageIdsRef.current = nextMessageIds;

    if (isInitialLoad || (addedMessageCount > 0 && followsLatestRef.current)) {
      const frame = window.requestAnimationFrame(scrollToLatest);
      return () => window.cancelAnimationFrame(frame);
    }
    if (addedMessageCount > 0) {
      const frame = window.requestAnimationFrame(() => {
        setNewMessages((current) => followsLatestRef.current
          ? null
          : {
              requirementId,
              count: (current?.requirementId === requirementId ? current.count : 0) + addedMessageCount,
            });
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [messageLoading, messages, requirementId, scrollToLatest]);

  useEffect(() => {
    draftAttachmentsRef.current = draftAttachments;
  }, [draftAttachments]);

  useEffect(() => () => {
    for (const attachment of draftAttachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  if (!requirement) return <Sheet open={false} onOpenChange={onOpenChange} />;
  const canWrite = requirement.status !== 'cancelled';

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const body = message.trim();
    if ((!body && draftAttachments.length === 0) || !canWrite) return;
    const attachmentFiles = draftAttachments.map((attachment) => attachment.file);
    try {
      if (requirement!.status === 'todo') await onStart(body || undefined, attachmentFiles);
      else await onReply(body, attachmentFiles);
      scrollToLatest();
      setMessage('');
      for (const attachment of draftAttachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      setDraftAttachments([]);
      setAttachmentError(null);
    } catch {
      // Keep the reply in the editor so it can be retried.
    }
  }

  function addAttachments(files: File[]) {
    const remaining = maxAttachmentsPerMessage - draftAttachments.length;
    if (files.some((file) => file.size > maxAttachmentBytes)) {
      setAttachmentError(t('Each attachment must be 20 MB or smaller.'));
      return;
    }
    if (files.length > remaining) {
      setAttachmentError(t('Each message supports up to {count} attachments.', { count: maxAttachmentsPerMessage }));
      return;
    }
    setDraftAttachments((current) => [
      ...current,
      ...files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: previewableImageTypes.has(file.type) ? URL.createObjectURL(file) : null,
      })),
    ]);
    setAttachmentError(null);
  }

  function removeAttachment(id: string) {
    setDraftAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
    setAttachmentError(null);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="data-[side=right]:w-full! data-[side=right]:max-w-none! gap-0 sm:data-[side=right]:w-[min(820px,calc(100vw-48px))]!"
        side="right"
        initialFocus={requirement.status === 'todo' ? messageInputRef : true}
      >
        <SheetHeader className="max-h-[40dvh] shrink-0 overflow-y-auto border-b border-border bg-card py-4 pr-12 pl-5 sm:pr-12 sm:pl-6">
          <div className="mb-2.5 flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-[10px]">REQ-{shortId(requirement.id)}</Badge>
            <Badge variant="secondary" className="text-[10px]">{t(statusLabel[requirement.status])}</Badge>
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className={`size-2 rounded-full ${stateDot[requirement.session.state]}`} />
              {t(stateLabel[requirement.session.state])}
            </span>
          </div>
          <SheetTitle className="text-xl leading-7 font-semibold tracking-[-0.025em]">{requirement.title}</SheetTitle>
          <SheetDescription className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span>{agentConfigurationLabel(requirement)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">ses-{shortId(requirement.session.id)}</span>
          </SheetDescription>
        </SheetHeader>

        <ScrollArea
          className="min-h-0 flex-1 bg-muted/15"
          viewportRef={scrollViewportRef}
          onViewportScroll={(event) => {
            const followsLatest = isNearConversationBottom(event.currentTarget);
            followsLatestRef.current = followsLatest;
            if (followsLatest && newMessageCount > 0) setNewMessages(null);
            setScrollToTopRequirementId(
              requirementId && isAwayFromConversationTop(event.currentTarget)
                ? requirementId
                : null,
            );
          }}
          overlay={(
            <>
              {showScrollToTop ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="absolute top-4 right-4 z-10 rounded-full border border-border bg-background shadow-lg hover:bg-muted"
                  onClick={scrollToTop}
                >
                  <ArrowUp data-icon="inline-start" />
                  {t('Back to top')}
                </Button>
              ) : null}
              {newMessageCount > 0 ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background shadow-lg hover:bg-muted"
                  onClick={scrollToLatest}
                >
                  {newMessageCount === 1
                    ? t('New message')
                    : t('{count} new messages', { count: newMessageCount })}
                  <ArrowDown data-icon="inline-end" />
                </Button>
              ) : null}
            </>
          )}
        >
          <div className="px-5 py-5 sm:px-6">
            <section className="rounded-xl border border-border/80 bg-card px-4 py-3.5">
              <p className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{t('Requirement description')}</p>
              <p className="mt-1.5 text-xs leading-5 whitespace-pre-wrap">{requirement.description}</p>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/70 pt-3 text-[10px] text-muted-foreground sm:grid-cols-3">
                <div><dt className="sr-only">{t('Created at')}</dt><dd>{t('Created {time}', { time: formatTime(requirement.createdAt, locale) })}</dd></div>
                <div><dt className="sr-only">{t('Run count')}</dt><dd>{t('{count} Runs', { count: runs.length })}</dd></div>
                <div className="col-span-2 min-w-0 sm:col-span-1"><dt className="sr-only">{t('Native Session')}</dt><dd className="truncate" title={requirement.session.nativeSessionId ?? undefined}>{t('Native: {id}', { id: requirement.session.nativeSessionId ? shortId(requirement.session.nativeSessionId) : t('Not created') })}</dd></div>
              </dl>
            </section>

            {pullRequests.length > 0 ? (
              <section className="mt-5" aria-labelledby="linked-pull-requests">
                <div className="mb-2.5 flex items-center gap-2">
                  <GitPullRequest className="size-3.5 text-muted-foreground" />
                  <h3 id="linked-pull-requests" className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{t('Linked Pull Requests')}</h3>
                  <Badge variant="secondary" className="ml-1 h-5 min-w-5 justify-center px-1.5 font-mono text-[9px]">{pullRequests.length}</Badge>
                </div>
                <div className="space-y-2">
                  {pullRequests.map((pullRequest) => (
                    <RequirementPullRequestCard
                      key={pullRequest.id}
                      pullRequest={pullRequest}
                      activeReview={reviewRequests.find((review) => review.pullRequestId === pullRequest.id && review.status === 'running')}
                      busy={busyPullRequestId === pullRequest.id}
                      modelCatalog={modelCatalog}
                      onReview={(provider) => onReview(pullRequest.id, provider)}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            <section className="mt-6" aria-labelledby="requirement-conversation">
              <div className="mb-4 flex items-center gap-2 border-b border-border/80 pb-3">
                <span className="grid size-7 place-items-center rounded-lg bg-primary/8 text-primary"><MessagesSquare className="size-3.5" /></span>
                <div>
                  <h3 id="requirement-conversation" className="text-xs font-semibold">{t('Activity and conversation')}</h3>
                  <p className="mt-0.5 text-[9px] text-muted-foreground">{t('{count} messages · Continue with the same RD Session', { count: messages.length })}</p>
                </div>
              </div>

            {messageLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t('Loading messages')}</div>
            ) : null}
            {!messageLoading && messages.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
                <Bot className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-2 text-xs font-medium">{t('No Agent output yet')}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">{t('RD Agent messages will appear here in real time after the requirement starts.')}</p>
              </div>
            ) : null}

            <div className="space-y-3" aria-live="polite">
            {messages.map((item) => {
              const human = item.author === 'human';
              const system = item.author === 'system';
              const reviewer = item.author === 'reviewer';
              const attachments = item.attachments ?? [];
              if (system) {
                return (
                  <article key={item.id} className="flex items-start gap-3 rounded-xl border border-sky-500/15 bg-sky-500/6 px-3.5 py-3 text-sky-950 dark:text-sky-100">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-sky-500/12 text-sky-600 dark:text-sky-300"><Activity className="size-3.5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[10px] font-semibold">{t('System event')}</span>
                        <span className="shrink-0 text-[9px] text-muted-foreground">{formatTime(item.createdAt, locale)}</span>
                      </div>
                      {item.body ? <div className="mt-1 text-[11px] leading-5 break-words"><MessageBody body={item.body} /></div> : null}
                      {attachments.length > 0 ? <div className="mt-2"><MessageAttachments attachments={attachments} apiUrl={apiUrl} /></div> : null}
                    </div>
                  </article>
                );
              }
              return (
                <article key={item.id} className={`flex gap-3 ${human ? 'flex-row-reverse' : ''}`}>
                  <span className={`grid size-8 shrink-0 place-items-center rounded-xl ${human ? 'bg-primary text-primary-foreground' : reviewer ? 'bg-violet-500/12 text-violet-700 dark:text-violet-300' : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'}`}>
                    {human ? <UserRound className="size-3.5" /> : <Bot className="size-3.5" />}
                  </span>
                  <div className={`min-w-0 max-w-[86%] ${human ? 'text-right' : ''}`}>
                    <div className={`flex items-center gap-2 ${human ? 'justify-end' : ''}`}>
                      <span className="text-[10px] font-semibold">{t(authorLabel[item.author])}</span>
                      <span className="text-[9px] text-muted-foreground">{formatTime(item.createdAt, locale)}</span>
                    </div>
                    <div className={`mt-1.5 rounded-2xl px-3.5 py-2.5 text-left text-xs leading-5 break-words shadow-[0_1px_2px_oklch(0.18_0.02_255/0.04)] ${human ? 'rounded-tr-md bg-primary text-primary-foreground' : reviewer ? 'rounded-tl-md border border-violet-500/15 bg-violet-500/7' : 'rounded-tl-md border border-border/80 bg-card'}`}>
                      {item.body ? <MessageBody body={item.body} inverted={human} /> : null}
                      {attachments.length > 0 ? <div className={item.body ? 'mt-2.5' : ''}><MessageAttachments attachments={attachments} apiUrl={apiUrl} /></div> : null}
                    </div>
                  </div>
                </article>
              );
            })}
            </div>

            {requirement.session.state === 'running' ? (
              <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-emerald-500/12 text-emerald-600"><Bot className="size-3.5" /></span>
                <span className="flex min-w-0 flex-1 items-center gap-2"><LoaderCircle className="size-3.5 shrink-0 animate-spin" />{t('RD Agent is working; new messages are queued by default.')}</span>
                <Button type="button" variant="ghost" size="xs" className="shrink-0 text-amber-700 dark:text-amber-300" disabled={busy} onClick={() => void onInterrupt().catch(() => undefined)}>
                  <Square data-icon="inline-start" />{t('Steering')}
                </Button>
              </div>
            ) : null}
            {requirement.session.pendingMessageCount > 0 ? (
              <div className="mt-3 rounded-lg bg-amber-500/8 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300">
                {t('{count} external messages will be processed by the RD Agent {when}.', {
                  count: requirement.session.pendingMessageCount,
                  when: t(requirement.session.state === 'running' ? 'after the current Run' : 'during the next Run'),
                })}
              </div>
            ) : null}
            </section>
          </div>
        </ScrollArea>

        <div className="max-h-[60dvh] min-h-0 shrink-0 overflow-y-auto border-t border-border bg-card px-4 py-3 sm:px-6">
          {requirement.status === 'waiting_confirmation' ? (
            <div className="mb-2.5 flex items-center justify-between gap-3 rounded-xl border border-violet-500/15 bg-violet-500/7 px-3 py-2 text-[10px] text-violet-700 dark:text-violet-300">
              <span>{t('The Agent reported completion. You can still ask follow-up questions.')}</span>
              <Button size="xs" className="shrink-0" disabled={busy} onClick={() => void onConfirm().catch(() => undefined)}><Check data-icon="inline-start" />{t('Complete')}</Button>
            </div>
          ) : null}
          <form
            className="rounded-2xl border border-input bg-background p-2 shadow-[0_3px_16px_oklch(0.18_0.02_255/0.07)] transition focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/15"
            onSubmit={submit}
          >
            {draftAttachments.length > 0 ? (
              <div className="mb-1.5 flex gap-2 overflow-x-auto px-1 pt-1">
                {draftAttachments.map((attachment) => (
                  <div key={attachment.id} className={`group relative h-16 shrink-0 overflow-hidden rounded-xl border border-border bg-muted ${attachment.previewUrl ? 'w-16' : 'w-48'}`}>
                    {attachment.previewUrl ? (
                      <>
                        {/* oxlint-disable-next-line next/no-img-element -- Blob previews cannot use the framework image optimizer. */}
                        <img src={attachment.previewUrl} alt={attachment.file.name} className="size-full object-cover" />
                      </>
                    ) : (
                      <div className="flex size-full items-center gap-2.5 px-3 pr-8">
                        <FileText className="size-5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate text-[10px] font-medium">{attachment.file.name}</span>
                          <span className="mt-0.5 block text-[9px] text-muted-foreground">{formatBytes(attachment.file.size)}</span>
                        </span>
                      </div>
                    )}
                    <button
                      type="button"
                      className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-black/65 text-white opacity-80 transition hover:opacity-100"
                      aria-label={t('Remove {name}', { name: attachment.file.name })}
                      onClick={() => removeAttachment(attachment.id)}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <Textarea
              ref={messageInputRef}
              aria-label={t('Reply to RD Agent')}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onPaste={(event) => {
                const attachments = Array.from(event.clipboardData.files);
                if (attachments.length === 0) return;
                event.preventDefault();
                addAttachments(attachments);
              }}
              onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
              onDrop={(event) => {
                if (event.dataTransfer.files.length === 0) return;
                event.preventDefault();
                addAttachments(Array.from(event.dataTransfer.files));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              disabled={!canWrite || busy}
              className="max-h-[min(9rem,20dvh)] min-h-14 resize-none border-0 bg-transparent px-2 py-1.5 text-xs shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent"
              placeholder={requirement.status === 'todo'
                ? t('Add instructions and start; paste or drop attachments…')
                : requirement.status === 'done'
                  ? t('Reply to reactivate this completed requirement; paste or drop attachments…')
                  : requirement.session.state === 'running'
                    ? t('Send a message or attachment; it will wait for the next Run by default…')
                    : canWrite
                      ? t('Reply to the RD Agent; paste or drop attachments…')
                      : t('Replies are unavailable in the current state')}
            />
            <div className="mt-1 flex items-center justify-between gap-3 px-1">
              <div className="flex min-w-0 items-center gap-2">
                <input
                  ref={attachmentInputRef}
                  type="file"
                  className="sr-only"
                  multiple
                  disabled={!canWrite || busy}
                  onChange={(event) => {
                    addAttachments(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-xl text-muted-foreground"
                  disabled={!canWrite || busy || draftAttachments.length >= maxAttachmentsPerMessage}
                  aria-label={t('Add attachment')}
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  <Paperclip />
                </Button>
                <AgentTimerDialog
                  timers={agentTimers}
                  disabled={requirement.status === 'done' || requirement.status === 'cancelled'}
                  busy={busy}
                  onCreate={onCreateAgentTimer}
                  onCancel={onCancelAgentTimer}
                />
                <span className="truncate text-[9px] text-muted-foreground">{t('Enter to send · Up to 6 attachments')}</span>
              </div>
              <Button type="submit" size="icon-sm" className="rounded-xl" disabled={!canWrite || busy || (!message.trim() && draftAttachments.length === 0)} aria-label={t('Send reply')}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Send />}
              </Button>
            </div>
          </form>
          {attachmentError ? <p className="mt-1.5 px-1 text-[10px] text-destructive">{attachmentError}</p> : null}
          {requirement.status === 'todo' ? (
            <Button className="mt-2 w-full" variant="ghost" size="xs" disabled={busy} onClick={() => void onStart()}>
              <Play data-icon="inline-start" />{t('Start without additional instructions')}
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Dashboard() {
  const { locale, setLocale, t } = useI18n();
  const { theme, setTheme } = useTheme();
  const [view, setView] = useState<DashboardView>('requirements');
  const [apiUrl, setApiUrl] = useState(DEFAULT_AGENT_MANAGER_URL);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [workspace, setWorkspace] = useState<WorkspaceDto | null>(null);
  const [configuration, setConfiguration] = useState<AgentManagerConfigurationSnapshot | null>(null);
  const [modelCatalog, setModelCatalog] = useState<AgentModelCatalogDto | null>(null);
  const [requirements, setRequirements] = useState<RequirementDto[]>([]);
  const [runs, setRuns] = useState<AgentRunDto[]>([]);
  const [pullRequests, setPullRequests] = useState<PullRequestDto[]>([]);
  const [reviewRequests, setReviewRequests] = useState<ReviewRequestDto[]>([]);
  const [messages, setMessages] = useState<RequirementMessageDto[]>([]);
  const [agentTimers, setAgentTimers] = useState<AgentTimerDto[]>([]);
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageRevision, setMessageRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchResponse, setSearchResponse] = useState<{ query: string; items: SearchResultDto[] }>({ query: '', items: [] });
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [provider, setProvider] = useState<'all' | AgentProvider>('all');
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyPullRequestId, setBusyPullRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [filterReferenceTime, setFilterReferenceTime] = useState(0);

  const client = useMemo(() => new AgentManagerClient(apiUrl), [apiUrl]);

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [nextWorkspace, nextConfiguration, nextModelCatalog, nextRequirements, nextRuns, nextPullRequests, nextReviewRequests, nextAgentTimers] = await Promise.all([
        client.getWorkspace(),
        client.getConfiguration(),
        client.listAgentModels(),
        client.listRequirements(),
        client.listRuns(),
        client.listPullRequests(),
        client.listReviewRequests(),
        client.listAgentTimers(),
      ]);
      setWorkspace(nextWorkspace);
      setConfiguration(nextConfiguration);
      setModelCatalog(nextModelCatalog);
      setRequirements(nextRequirements);
      setRuns(nextRuns);
      setPullRequests(nextPullRequests);
      setReviewRequests(nextReviewRequests);
      setAgentTimers(nextAgentTimers);
      setConnection('online');
      setError(null);
      const syncedAt = new Date();
      setLastSynced(syncedAt);
      setFilterReferenceTime(syncedAt.getTime());
    } catch (caught) {
      setConnection('offline');
      setError(caught instanceof Error ? caught.message : t('Unable to connect to Agent Manager'));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [client, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem('code-factory.agent-manager-url');
      const location = window.location;
      const isEmbeddedDashboard = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname)
        && location.port !== '3000';
      try {
        setApiUrl(normalizeManagerUrl(saved || (isEmbeddedDashboard ? location.origin : DEFAULT_AGENT_MANAGER_URL)));
      } catch {
        if (saved) {
          window.localStorage.removeItem('code-factory.agent-manager-url');
        }
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const advanceFilterClock = () => setFilterReferenceTime(Date.now());
    const timer = window.setInterval(advanceFilterClock, filterClockIntervalMilliseconds);
    window.addEventListener('focus', advanceFilterClock);
    document.addEventListener('visibilitychange', advanceFilterClock);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', advanceFilterClock);
      document.removeEventListener('visibilitychange', advanceFilterClock);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(true), 0);
    const disconnect = client.connectEvents({
      onOpen: () => setConnection('online'),
      onError: () => setConnection((current) => current === 'online' ? 'reconnecting' : 'offline'),
      onEvent: (event: ManagerEventDto) => {
        if (event.type === 'message.created') setMessageRevision((value) => value + 1);
        void reload(false);
      },
    });
    return () => {
      window.clearTimeout(timer);
      disconnect();
    };
  }, [client, reload]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setMessageLoading(true);
      client.listMessages(selectedId)
        .then((items) => { if (!cancelled) setMessages(items); })
        .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : t('Failed to load messages')); })
        .finally(() => { if (!cancelled) setMessageLoading(false); });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, messageRevision, selectedId, t]);

  useEffect(() => {
    const trimmed = query.trim();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!trimmed || view === 'timers') {
        setSearchResponse({ query: '', items: [] });
        setSearching(false);
        setSearchError(null);
        return;
      }
      setSearching(true);
      client.search(trimmed, 200)
        .then((items) => {
          if (!cancelled) {
            setSearchResponse({ query: trimmed, items });
            setSearchError(null);
          }
        })
        .catch((caught: unknown) => {
          if (!cancelled) setSearchError(caught instanceof Error ? caught.message : t('Search failed'));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, trimmed ? 200 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, lastSynced, query, t, view]);

  const selectedRequirement = requirements.find((item) => item.id === selectedId) ?? null;
  const selectedRuns = runs.filter((run) => run.requirementId === selectedId);
  const selectedPullRequests = pullRequests.filter((pullRequest) => pullRequest.requirementId === selectedId);
  const normalizedQuery = query.trim();
  const searchResults = useMemo(
    () => searchResponse.query === normalizedQuery ? searchResponse.items : [],
    [normalizedQuery, searchResponse],
  );
  const matchingRequirementIds = useMemo(
    () => new Set(searchResults.map((result) => result.requirementId)),
    [searchResults],
  );
  const matchingPullRequestIds = useMemo(
    () => new Set(searchResults.filter((result) => result.kind === 'pull_request').map((result) => result.sourceId)),
    [searchResults],
  );
  const searchMatchByRequirement = useMemo(() => {
    const matches = new Map<string, SearchResultDto>();
    for (const result of searchResults) {
      if (!matches.has(result.requirementId)) matches.set(result.requirementId, result);
    }
    return matches;
  }, [searchResults]);

  const filteredRequirements = useMemo(() => {
    return requirements.filter((requirement) => {
      const matchesQuery = !normalizedQuery || matchingRequirementIds.has(requirement.id);
      return matchesQuery
        && (provider === 'all' || requirement.provider === provider)
        && isWithinTimeRange(requirement.createdAt, timeRange, filterReferenceTime);
    });
  }, [filterReferenceTime, matchingRequirementIds, normalizedQuery, provider, requirements, timeRange]);

  const filteredSessions = useMemo(() => {
    return requirements.filter((requirement) => {
      const matchesQuery = !normalizedQuery || matchingRequirementIds.has(requirement.id);
      return matchesQuery
        && (provider === 'all' || requirement.provider === provider)
        && isWithinTimeRange(requirement.session.createdAt, timeRange, filterReferenceTime);
    });
  }, [filterReferenceTime, matchingRequirementIds, normalizedQuery, provider, requirements, timeRange]);

  const filteredPullRequests = useMemo(() => {
    return pullRequests.filter((pullRequest) => {
      const matchesQuery = !normalizedQuery || matchingPullRequestIds.has(pullRequest.id);
      return matchesQuery && isWithinTimeRange(pullRequest.createdAt, timeRange, filterReferenceTime);
    });
  }, [filterReferenceTime, matchingPullRequestIds, normalizedQuery, pullRequests, timeRange]);

  const requirementsById = useMemo(
    () => new Map(requirements.map((requirement) => [requirement.id, requirement])),
    [requirements],
  );

  const filteredAgentTimers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agentTimers.filter((timer) => {
      const requirement = requirementsById.get(timer.requirementId);
      const matchesQuery = !needle || [
        timer.id,
        timer.description,
        timer.requirementId,
        requirement?.title ?? '',
        requirement?.description ?? '',
        requirement?.session.id ?? '',
      ].some((value) => value.toLowerCase().includes(needle));
      return matchesQuery
        && (provider === 'all' || requirement?.provider === provider)
        && isWithinTimeRange(
          timer.status === 'active' ? timer.nextFireAt ?? timer.createdAt : timer.updatedAt,
          timeRange,
          filterReferenceTime,
        );
    }).sort((left, right) => {
      if (left.status === 'active' && right.status === 'active') {
        return Date.parse(left.nextFireAt ?? '') - Date.parse(right.nextFireAt ?? '');
      }
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  }, [agentTimers, filterReferenceTime, provider, query, requirementsById, timeRange]);

  async function runAction(requirementId: string, action: () => Promise<unknown>): Promise<void> {
    setBusyId(requirementId);
    setError(null);
    try {
      await action();
      await reload(false);
      setMessageRevision((value) => value + 1);
    } catch (caught) {
      const prefix = caught instanceof AgentManagerApiError && caught.status === 409 ? t('This action conflicts with the current state. Refresh and try again.') : '';
      setError(prefix || (caught instanceof Error ? caught.message : t('Operation failed')));
      throw caught;
    } finally {
      setBusyId(null);
    }
  }

  async function requestReview(pullRequestId: string, configuration: AgentConfiguration): Promise<void> {
    setBusyPullRequestId(pullRequestId);
    setError(null);
    try {
      await client.requestReview(pullRequestId, configuration);
      await reload(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Failed to request a review'));
      throw caught;
    } finally {
      setBusyPullRequestId(null);
    }
  }

  async function createAgentTimer(
    input: { description: string; schedule: 'once' | 'recurring'; intervalSeconds: number },
  ): Promise<void> {
    if (!selectedId) return;
    await runAction(selectedId, () => client.createAgentTimer(selectedId, input));
  }

  async function cancelAgentTimer(timerId: string): Promise<void> {
    if (!selectedId) return;
    await runAction(selectedId, () => client.cancelAgentTimer(selectedId, timerId));
  }

  async function uploadMessageAttachments(requirementId: string, files: File[]): Promise<string[]> {
    const attachments = await Promise.all(files.map((file) => client.uploadMessageAttachment(requirementId, file)));
    return attachments.map((attachment) => attachment.id);
  }

  async function createRequirement(input: { title: string; description: string } & AgentConfiguration) {
    setError(null);
    try {
      const created = await client.createRequirement(input);
      await reload(false);
      setSelectedId(created.id);
      setView('requirements');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Failed to create requirement'));
      throw caught;
    }
  }

  async function saveConfiguration(values: Partial<AgentManagerConfiguration>): Promise<void> {
    setError(null);
    try {
      const next = await client.updateConfiguration(values);
      setConfiguration(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Failed to save configuration'));
      throw caught;
    }
  }

  function connect(url: string) {
    window.localStorage.setItem('code-factory.agent-manager-url', url);
    setApiUrl(url);
    setConnection('connecting');
    setError(null);
  }

  const cycleProvider = () => setProvider((current) => current === 'all' ? 'codex' : current === 'codex' ? 'claude-code' : 'all');
  const activeSessions = requirements.filter((item) => item.session.state === 'running').length;
  const waitingHumans = requirements.filter((item) => item.session.state === 'waiting_human').length;
  const failures = requirements.filter((item) => item.session.state === 'failed').length;
  const activeTimers = agentTimers.filter((item) => item.status === 'active');
  const oneTimeTimers = activeTimers.filter((item) => item.schedule === 'once').length;
  const recurringTimers = activeTimers.filter((item) => item.schedule === 'recurring').length;
  const workspaceLabel = workspace?.root ?? t('Workspace not connected');
  const viewTitle: TranslationKey = view === 'requirements'
    ? 'Requirement workflow'
    : view === 'pull_requests' ? 'Pull Requests' : view === 'sessions' ? 'RD Agent Sessions' : 'Scheduled wake-ups';
  const viewDescription: TranslationKey = view === 'requirements'
    ? 'The requirement conversation is the RD Agent message stream; messages remain available while it runs'
    : view === 'pull_requests'
      ? 'A human can select Codex or Claude to run a one-off review on an Open PR'
      : view === 'sessions'
        ? 'Sessions inherit the Agent Manager working directory and native Skills'
        : 'Track timers and the Requirements they will wake';
  const searchLabel: TranslationKey = view === 'timers'
    ? 'Search timers or Requirements'
    : 'Search requirements, conversations, or PRs';
  const boardLabel: TranslationKey = view === 'requirements'
    ? 'Requirement board'
    : view === 'pull_requests' ? 'Pull Request board' : view === 'sessions' ? 'Agent Session board' : 'Timer board';

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/92 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
          <div className="flex items-center gap-2.5">
            <Image src="/favicon.svg" alt="" aria-hidden="true" width={32} height={32} className="size-8 shrink-0" />
            <div className="hidden sm:block">
              <p className="text-sm leading-4 font-semibold tracking-[-0.02em]">Code Factory</p>
              <p className="text-[9px] font-medium tracking-[0.14em] text-muted-foreground uppercase">Agent Manager</p>
            </div>
          </div>

          <nav className="ml-1 flex h-full items-center gap-1 sm:ml-5" aria-label={t('Main navigation')}>
            <Button variant="ghost" size="sm" className={view === 'requirements' ? 'bg-muted' : 'text-muted-foreground'} onClick={() => setView('requirements')}><LayoutDashboard data-icon="inline-start" />{t('Requirements')}</Button>
            <Button variant="ghost" size="sm" className={view === 'pull_requests' ? 'bg-muted' : 'text-muted-foreground'} onClick={() => setView('pull_requests')}><GitPullRequest data-icon="inline-start" />PR</Button>
            <Button variant="ghost" size="sm" className={view === 'sessions' ? 'bg-muted' : 'text-muted-foreground'} onClick={() => setView('sessions')}><Activity data-icon="inline-start" />{t('Sessions')}</Button>
            <Button variant="ghost" size="sm" className={view === 'timers' ? 'bg-muted' : 'text-muted-foreground'} onClick={() => setView('timers')}><Clock3 data-icon="inline-start" />{t('Timers')}</Button>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <div className="hidden max-w-80 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[10px] lg:flex">
              <CircleDot className={`size-3 shrink-0 ${connection === 'online' ? 'text-emerald-500' : connection === 'reconnecting' ? 'text-amber-500' : 'text-rose-500'}`} />
              <span className="truncate font-mono">{workspaceLabel}</span>
            </div>
            <Button
              variant="outline"
              size="icon"
              aria-label={theme === 'dark' ? t('Switch to light mode') : t('Switch to dark mode')}
              title={theme === 'dark' ? t('Switch to light mode') : t('Switch to dark mode')}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
            <Button variant="outline" size="sm" aria-label={t('Switch language')} onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}><Languages data-icon="inline-start" />{locale === 'en' ? t('Chinese') : t('English')}</Button>
            <Button variant="outline" size="icon" aria-label={t('Refresh')} disabled={loading} onClick={() => void reload(true)}><RefreshCw className={loading ? 'animate-spin' : ''} /></Button>
            <ManagerConfigurationDialog configuration={configuration} disabled={connection !== 'online'} onSave={saveConfiguration} workspace={workspace} />
            <ConnectionDialog apiUrl={apiUrl} onConnect={connect} />
            <NewRequirementDialog disabled={connection !== 'online'} modelCatalog={modelCatalog} onCreate={createRequirement} />
          </div>
        </div>
      </header>

      <section className="border-b border-border/70 px-4 py-4 lg:px-6" aria-labelledby="overview-title">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 id="overview-title" className="text-xl font-semibold tracking-[-0.03em]">
                {t(viewTitle)}
              </h1>
              <Badge variant="secondary" className="font-mono text-[9px]">{connection === 'online' ? t('LIVE') : t('OFFLINE')}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(viewDescription)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-5 text-xs">
            {view === 'timers' ? (
              <>
                <div><span className="mr-1.5 text-lg font-semibold tabular-nums text-emerald-600">{activeTimers.length}</span><span className="text-muted-foreground">{t('Active')}</span></div>
                <div><span className="mr-1.5 text-lg font-semibold tabular-nums">{oneTimeTimers}</span><span className="text-muted-foreground">{t('One time')}</span></div>
                <div><span className="mr-1.5 text-lg font-semibold tabular-nums text-violet-600">{recurringTimers}</span><span className="text-muted-foreground">{t('Recurring')}</span></div>
              </>
            ) : (
              <>
                <div><span className="mr-1.5 text-lg font-semibold tabular-nums">{activeSessions}</span><span className="text-muted-foreground">{t('Running')}</span></div>
                <div><span className="mr-1.5 text-lg font-semibold tabular-nums text-violet-600">{waitingHumans}</span><span className="text-muted-foreground">{t('Waiting for human')}</span></div>
                <div><span className="mr-1.5 text-lg font-semibold tabular-nums text-rose-600">{failures}</span><span className="text-muted-foreground">{t('Failed')}</span></div>
              </>
            )}
            <div className="hidden h-7 w-px bg-border sm:block" />
            <div className="relative hidden sm:block">
              {view !== 'timers' && searching
                ? <LoaderCircle className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
                : <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />}
              <Input aria-label={t(searchLabel)} value={query} onChange={(event) => setQuery(event.target.value)} className="w-64 pr-3 pl-8 text-xs" placeholder={t(searchLabel)} />
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <div className="px-4 pt-4 lg:px-6">
          <Alert variant="destructive">
            <WifiOff />
            <AlertTitle>{connection === 'offline' ? t('Agent Manager not connected') : t('Operation incomplete')}</AlertTitle>
            <AlertDescription>{error} {connection === 'offline' ? t('Confirm that Agent Manager is running and allows access from http://localhost:3000.') : ''}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {searchError ? (
        <div className="px-4 pt-4 lg:px-6">
          <Alert variant="destructive">
            <Search />
            <AlertTitle>{t('Search failed')}</AlertTitle>
            <AlertDescription>{searchError}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2.5 lg:px-6">
        <Button variant="secondary" size="xs" title={workspace?.root}><FolderGit2 data-icon="inline-start" />{workspaceLabel}</Button>
        <Button variant={provider === 'all' ? 'ghost' : 'secondary'} size="xs" className={provider === 'all' ? 'text-muted-foreground' : ''} onClick={cycleProvider}>{provider === 'all' ? t('All Agents') : providerLabel(provider)}</Button>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Clock3 className="size-3.5" aria-hidden="true" />
          <NativeSelect
            size="sm"
            value={timeRange}
            onChange={(event) => setTimeRange(event.target.value as TimeRange)}
            aria-label={view === 'timers' ? t('Timer activity within') : t('Created within')}
            className="[&_select]:text-[10px]"
          >
            {timeRangeOptions.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>{t(option.label)}</NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground">{lastSynced ? t('Last synced {time}', { time: lastSynced.toLocaleTimeString(locale === 'zh-CN' ? 'zh-CN' : 'en-US') }) : apiUrl}</span>
      </div>

      <section className="kanban-scroll overflow-x-auto" aria-label={t(boardLabel)}>
        {view === 'requirements' ? (
          <div className="grid min-h-[calc(100vh-176px)] min-w-max grid-cols-4 gap-4 p-4 lg:p-5">
            {requirementColumns.map((column) => {
              const items = filteredRequirements.filter((item) => item.status === column.status);
              return (
                <section key={column.status} className="w-[300px]" aria-labelledby={`requirement-${column.status}`}>
                  <header className="mb-3 h-11 px-1">
                    <div className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${column.tone}`} /><h2 id={`requirement-${column.status}`} className="text-xs font-semibold">{t(column.title)}</h2><span className="font-mono text-[10px] text-muted-foreground">{items.length}</span></div>
                    <p className="mt-1 pl-3.5 text-[10px] text-muted-foreground">{t(column.description)}</p>
                  </header>
                  <div className="space-y-2.5">
                    {items.map((item) => (
                      <RequirementCard
                        key={item.id}
                        requirement={item}
                        run={latestRun(item.id, runs)}
                        searchMatch={normalizedQuery ? searchMatchByRequirement.get(item.id) : undefined}
                        busy={busyId === item.id}
                        onOpen={() => setSelectedId(item.id)}
                        onStart={() => setSelectedId(item.id)}
                        onDelete={() => void runAction(item.id, () => client.deleteRequirement(item.id)).then(() => {
                          if (selectedId === item.id) setSelectedId(null);
                        }).catch(() => undefined)}
                        onConfirm={() => void runAction(item.id, () => client.confirmRequirement(item.id)).catch(() => undefined)}
                      />
                    ))}
                    {items.length === 0 ? <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-border text-[10px] text-muted-foreground">{loading ? t('Loading…') : t('No requirements')}</div> : null}
                  </div>
                </section>
              );
            })}
          </div>
        ) : view === 'pull_requests' ? (
          <div className="grid min-h-[calc(100vh-176px)] min-w-max grid-cols-4 gap-4 p-4 lg:p-5">
            {pullRequestColumns.map((column) => {
              const items = filteredPullRequests.filter((item) => item.status === column.status);
              return (
                <section key={column.status} className="w-[320px]" aria-labelledby={`pull-request-${column.status}`}>
                  <header className="mb-3 h-11 px-1">
                    <div className="flex items-center gap-2">
                      <span className={`size-1.5 rounded-full ${column.tone}`} />
                      <h2 id={`pull-request-${column.status}`} className="text-xs font-semibold">{t(column.title)}</h2>
                      <span className="font-mono text-[10px] text-muted-foreground">{items.length}</span>
                    </div>
                    <p className="mt-1 pl-3.5 text-[10px] text-muted-foreground">{t(column.description)}</p>
                  </header>
                  <div className="space-y-2.5">
                    {items.map((pullRequest) => (
                      <PullRequestCard
                        key={pullRequest.id}
                        pullRequest={pullRequest}
                        requirement={requirements.find((requirement) => requirement.id === pullRequest.requirementId)}
                        activeReview={reviewRequests.find((review) => review.pullRequestId === pullRequest.id && review.status === 'running')}
                        busy={busyPullRequestId === pullRequest.id}
                        modelCatalog={modelCatalog}
                        onReview={(reviewer) => requestReview(pullRequest.id, reviewer)}
                      />
                    ))}
                    {items.length === 0 ? (
                      <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-border text-[10px] text-muted-foreground">
                        {loading ? t('Loading…') : t('No Pull Requests')}
                      </div>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        ) : view === 'timers' ? (
          <div className="grid min-h-[calc(100vh-176px)] min-w-max grid-cols-3 gap-4 p-4 lg:p-5">
            {agentTimerColumns.map((column) => {
              const items = filteredAgentTimers.filter((item) => item.status === column.status);
              return (
                <section key={column.status} className="w-[340px]" aria-labelledby={`timer-${column.status}`}>
                  <header className="mb-3 h-11 px-1">
                    <div className="flex items-center gap-2">
                      <span className={`size-1.5 rounded-full ${column.tone}`} />
                      <h2 id={`timer-${column.status}`} className="text-xs font-semibold">{t(column.title)}</h2>
                      <span className="font-mono text-[10px] text-muted-foreground">{items.length}</span>
                    </div>
                    <p className="mt-1 pl-3.5 text-[10px] text-muted-foreground">{t(column.description)}</p>
                  </header>
                  <div className="space-y-2.5">
                    {items.map((timer) => (
                      <AgentTimerCard
                        key={timer.id}
                        timer={timer}
                        requirement={requirementsById.get(timer.requirementId)}
                        onOpenRequirement={() => setSelectedId(timer.requirementId)}
                      />
                    ))}
                    {items.length === 0 ? (
                      <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-border text-[10px] text-muted-foreground">
                        {loading ? t('Loading…') : t('No timers')}
                      </div>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <div className="grid min-h-[calc(100vh-176px)] min-w-max grid-cols-5 gap-3 p-4 lg:p-5">
            {sessionColumns.map((column) => {
              const items = filteredSessions.filter((item) => item.session.state === column.state);
              return (
                <section key={column.state} className="w-[266px]" aria-labelledby={`session-${column.state}`}>
                  <header className="mb-3 h-11 px-1">
                    <div className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${column.tone}`} /><h2 id={`session-${column.state}`} className="text-xs font-semibold">{t(column.title)}</h2><span className="font-mono text-[10px] text-muted-foreground">{items.length}</span></div>
                    <p className="mt-1 pl-3.5 text-[10px] text-muted-foreground">{t(column.description)}</p>
                  </header>
                  <div className="space-y-2.5">
                    {items.map((item) => (
                      <SessionCard
                        key={item.session.id}
                        requirement={item}
                        run={latestRun(item.id, runs)}
                        busy={busyId === item.id}
                        onOpen={() => setSelectedId(item.id)}
                        onRetry={() => void runAction(item.id, () => client.retryRequirement(item.id)).catch(() => undefined)}
                      />
                    ))}
                    {items.length === 0 ? <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-border text-[10px] text-muted-foreground">{t('No Sessions')}</div> : null}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </section>

      <RequirementDetail
        key={selectedRequirement?.id ?? 'closed'}
        requirement={selectedRequirement}
        runs={selectedRuns}
        messages={messages}
        agentTimers={agentTimers.filter((timer) => timer.requirementId === selectedId)}
        pullRequests={selectedPullRequests}
        reviewRequests={reviewRequests}
        modelCatalog={modelCatalog}
        messageLoading={messageLoading}
        busy={selectedRequirement ? busyId === selectedRequirement.id : false}
        busyPullRequestId={busyPullRequestId}
        apiUrl={apiUrl}
        onOpenChange={(open) => { if (!open) setSelectedId(null); }}
        onStart={(message, attachments = []) => selectedRequirement ? runAction(selectedRequirement.id, async () => {
          const attachmentIds = await uploadMessageAttachments(selectedRequirement.id, attachments);
          return await client.startRequirement(selectedRequirement.id, message, attachmentIds);
        }) : Promise.resolve()}
        onReply={(message, attachments = []) => selectedRequirement ? runAction(selectedRequirement.id, async () => {
          const attachmentIds = await uploadMessageAttachments(selectedRequirement.id, attachments);
          return await client.replyToRequirement(selectedRequirement.id, message, attachmentIds);
        }) : Promise.resolve()}
        onInterrupt={() => selectedRequirement ? runAction(selectedRequirement.id, () => client.interruptRequirement(selectedRequirement.id)) : Promise.resolve()}
        onConfirm={() => selectedRequirement ? runAction(selectedRequirement.id, () => client.confirmRequirement(selectedRequirement.id)) : Promise.resolve()}
        onReview={requestReview}
        onCreateAgentTimer={createAgentTimer}
        onCancelAgentTimer={cancelAgentTimer}
      />

      <div className="fixed right-4 bottom-4 hidden items-center gap-2 rounded-lg border border-border bg-card/95 px-3 py-2 text-[10px] text-muted-foreground shadow-lg backdrop-blur sm:flex">
        <Terminal className="size-3.5" />
        <span>{connection === 'online' ? t('Agent Manager online') : connection === 'reconnecting' ? t('Reconnecting') : t('Agent Manager offline')}</span>
        <span className={`size-1.5 rounded-full ${connection === 'online' ? 'bg-emerald-500' : connection === 'reconnecting' ? 'bg-amber-500' : 'bg-rose-500'}`} />
      </div>
    </main>
  );
}

export default function Home() {
  return <I18nProvider><Dashboard /></I18nProvider>;
}
