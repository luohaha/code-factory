'use client';

import { type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
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
  LoaderCircle,
  MessagesSquare,
  MessageSquareReply,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Send,
  Settings2,
  Square,
  Terminal,
  TriangleAlert,
  UserRound,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  type AgentProvider,
  type AgentRunDto,
  type ManagerEventDto,
  type MessageAttachmentDto,
  type PullRequestDto,
  type PullRequestStatus,
  type RequirementDto,
  type RequirementMessageDto,
  type RequirementStatus,
  type ReviewRequestDto,
  type SessionState,
  type WorkspaceDto,
} from '@/lib/agent-manager-client';

type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline';

const requirementColumns: Array<{
  status: RequirementStatus;
  title: string;
  description: string;
  tone: string;
}> = [
  { status: 'todo', title: 'TODO', description: 'Session assigned, not started', tone: 'bg-sky-500' },
  { status: 'doing', title: 'DOING', description: 'Working or awaiting PR events', tone: 'bg-amber-500' },
  { status: 'waiting_confirmation', title: 'AWAITING CONFIRMATION', description: 'Reply to continue or confirm completion', tone: 'bg-violet-500' },
  { status: 'done', title: 'DONE', description: 'Completion confirmed by a human', tone: 'bg-emerald-600' },
];

const pullRequestColumns: Array<{ status: PullRequestStatus; title: string; description: string; tone: string }> = [
  { status: 'draft', title: 'DRAFT', description: 'Still in preparation; review unavailable', tone: 'bg-slate-400' },
  { status: 'open', title: 'OPEN', description: 'A human can request an Agent review', tone: 'bg-emerald-500' },
  { status: 'closed', title: 'CLOSED', description: 'Closed without being merged', tone: 'bg-rose-500' },
  { status: 'merged', title: 'MERGED', description: 'Merged into the target branch', tone: 'bg-violet-500' },
];

const sessionColumns: Array<{
  state: SessionState;
  title: string;
  description: string;
  tone: string;
}> = [
  { state: 'idle', title: 'IDLE', description: 'Session assigned, no Run yet', tone: 'bg-slate-400' },
  { state: 'running', title: 'RUNNING', description: 'Headless CLI is running', tone: 'bg-emerald-500' },
  { state: 'waiting_human', title: 'WAITING FOR HUMAN', description: 'Awaiting a reply or completion confirmation', tone: 'bg-violet-500' },
  { state: 'failed', title: 'FAILED', description: 'Can continue in the original Session', tone: 'bg-rose-500' },
  { state: 'completed', title: 'COMPLETED', description: 'Requirement complete; Session archived', tone: 'bg-teal-600' },
];

const stateLabel: Record<SessionState, string> = {
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

const statusLabel: Record<RequirementStatus, string> = {
  todo: 'TODO',
  doing: 'DOING',
  waiting_confirmation: 'Awaiting confirmation',
  done: 'DONE',
  cancelled: 'Cancelled',
};

const authorLabel: Record<RequirementMessageDto['author'], string> = {
  human: 'Human',
  rd_agent: 'RD Agent',
  reviewer: 'Reviewer',
  system: 'System',
};

function providerLabel(provider: AgentProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
}

function shortId(id: string): string {
  const value = id.replace(/^(req|ses|run|msg)_/, '');
  return value.length > 12 ? value.slice(0, 8) : value;
}

function formatAge(value: string): string {
  const milliseconds = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'just now';
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
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
                title={`Open ${attachment.fileName}`}
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
  busy,
  onOpen,
  onStart,
  onConfirm,
}: {
  requirement: RequirementDto;
  run?: AgentRunDto;
  busy: boolean;
  onOpen: () => void;
  onStart: () => void;
  onConfirm: () => void;
}) {
  return (
    <article className="rounded-xl border border-border/80 bg-card p-3.5 shadow-[0_1px_2px_oklch(0.18_0.02_255/0.05)] transition hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-[0_8px_24px_oklch(0.18_0.02_255/0.08)]">
      <div className="flex items-start justify-between gap-3">
        <Badge variant="outline" className="h-5 rounded-md bg-muted/45 px-1.5 font-mono text-[10px] text-muted-foreground">
          REQ-{shortId(requirement.id)}
        </Badge>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock3 className="size-3" />{formatAge(requirement.updatedAt)}
        </span>
      </div>

      <button type="button" className="mt-2.5 block w-full text-left" onClick={onOpen}>
        <h3 className="text-[13px] leading-5 font-semibold tracking-[-0.01em] hover:underline">{requirement.title}</h3>
        <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{requirement.description}</p>
      </button>

      {requirement.session.lastError ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-rose-500/8 px-2.5 py-2 text-[10px] leading-4 text-rose-700 dark:text-rose-300">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />{requirement.session.lastError}
        </div>
      ) : null}

      <div className="mt-3 border-t border-border/70 pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${stateDot[requirement.session.state]}`} />
            <span className="text-[10px] font-medium">RD · {stateLabel[requirement.session.state]}</span>
          </div>
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{providerLabel(requirement.provider)}</span>
        </div>
        <p className="mt-1.5 truncate font-mono text-[9px] text-muted-foreground">ses-{shortId(requirement.session.id)}</p>
        {run ? <p className="mt-2 text-[10px] text-foreground/70">{run.taskSummary} · {run.status}</p> : null}
        {requirement.session.pendingMessageCount > 0 ? (
          <p className="mt-2 text-[10px] font-medium text-amber-600">{requirement.session.pendingMessageCount} messages pending</p>
        ) : null}
      </div>

      {requirement.status === 'todo' ? (
        <Button size="xs" className="mt-3 w-full" disabled={busy} onClick={onStart}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Play data-icon="inline-start" />}Start
        </Button>
      ) : null}
      {requirement.status === 'waiting_confirmation' ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={onOpen}><MessageSquareReply data-icon="inline-start" />Reply</Button>
          <Button size="xs" disabled={busy} onClick={onConfirm}><Check data-icon="inline-start" />Confirm completion</Button>
        </div>
      ) : null}
      {requirement.status === 'doing' && requirement.session.state !== 'running' ? (
        <Button size="xs" variant="outline" className="mt-3 w-full" onClick={onOpen}><MessageSquareReply data-icon="inline-start" />Open conversation</Button>
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
  return (
    <article className="rounded-xl border border-border/80 bg-card p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${stateDot[requirement.session.state]}`} />
          <span className="font-mono text-[10px] font-semibold">REQ-{shortId(requirement.id)}</span>
        </div>
        <Badge variant="secondary" className="h-5 font-mono text-[9px]">{providerLabel(requirement.provider)}</Badge>
      </div>
      <button type="button" className="mt-2.5 block w-full text-left" onClick={onOpen}>
        <h3 className="truncate text-xs font-semibold hover:underline">{requirement.title}</h3>
        <p className="mt-1.5 truncate font-mono text-[9px] text-muted-foreground">ses-{shortId(requirement.session.id)}</p>
      </button>
      {run ? <p className="mt-2.5 text-[10px] leading-4 text-foreground/75">{run.taskSummary} · {run.status}</p> : null}
      {requirement.session.pendingMessageCount > 0 ? (
        <p className="mt-2 text-[10px] font-medium text-amber-600">{requirement.session.pendingMessageCount} external messages pending</p>
      ) : null}
      {requirement.session.lastError ? (
        <Button size="xs" variant="destructive" className="mt-3 w-full" disabled={busy} onClick={onRetry}>
          {busy ? <LoaderCircle className="animate-spin" /> : <RotateCcw data-icon="inline-start" />}Retry original Session
        </Button>
      ) : null}
    </article>
  );
}

function PullRequestCard({ pullRequest, requirement, activeReview, busy, onReview }: {
  pullRequest: PullRequestDto;
  requirement?: RequirementDto;
  activeReview?: ReviewRequestDto;
  busy: boolean;
  onReview: (provider: AgentProvider) => Promise<void>;
}) {
  const [reviewer, setReviewer] = useState<AgentProvider>('codex');
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
        <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 border-t border-border/70 pt-3">
          <NativeSelect size="sm" value={reviewer} disabled={busy || Boolean(activeReview)} onChange={(event) => setReviewer(event.target.value as AgentProvider)} className="w-full">
            <NativeSelectOption value="codex">Codex Reviewer</NativeSelectOption>
            <NativeSelectOption value="claude-code">Claude Reviewer</NativeSelectOption>
          </NativeSelect>
          <Button size="xs" disabled={busy || Boolean(activeReview)} onClick={() => void onReview(reviewer).catch(() => undefined)}>
            {busy || activeReview ? <LoaderCircle className="animate-spin" /> : <ScanSearch data-icon="inline-start" />}
            {activeReview ? 'Reviewing' : 'Request review'}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function RequirementPullRequestCard({ pullRequest, activeReview, busy, onReview }: {
  pullRequest: PullRequestDto;
  activeReview?: ReviewRequestDto;
  busy: boolean;
  onReview: (provider: AgentProvider) => Promise<void>;
}) {
  const [reviewer, setReviewer] = useState<AgentProvider>('codex');
  const status = pullRequestColumns.find((column) => column.status === pullRequest.status);

  return (
    <article className="rounded-xl border border-border/80 bg-card px-4 py-3.5 shadow-[0_1px_2px_oklch(0.18_0.02_255/0.04)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="h-5 font-mono text-[10px]">{pullRequest.repository}#{pullRequest.number}</Badge>
            <span className="flex items-center gap-1.5 text-[9px] font-medium text-muted-foreground">
              <span className={`size-1.5 rounded-full ${status?.tone ?? 'bg-slate-400'}`} />
              {status?.title ?? pullRequest.status.toUpperCase()}
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
          <div className="flex shrink-0 items-center gap-2 border-t border-border/70 pt-3 sm:border-t-0 sm:pt-0">
            <NativeSelect
              size="sm"
              value={reviewer}
              disabled={busy || Boolean(activeReview)}
              onChange={(event) => setReviewer(event.target.value as AgentProvider)}
              className="min-w-0 flex-1 sm:w-40 sm:flex-none"
              aria-label="Select Reviewer Agent"
            >
              <NativeSelectOption value="codex">Codex Reviewer</NativeSelectOption>
              <NativeSelectOption value="claude-code">Claude Reviewer</NativeSelectOption>
            </NativeSelect>
            <Button size="sm" disabled={busy || Boolean(activeReview)} onClick={() => void onReview(reviewer).catch(() => undefined)}>
              {busy || activeReview ? <LoaderCircle className="animate-spin" /> : <ScanSearch data-icon="inline-start" />}
              {activeReview ? 'Reviewing' : 'Request review'}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function NewRequirementDialog({ disabled, onCreate }: {
  disabled: boolean;
  onCreate: (input: { title: string; description: string; provider: AgentProvider }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const title = form.get('title');
    const description = form.get('description');
    if (typeof title !== 'string' || typeof description !== 'string') return;
    setSubmitting(true);
    try {
      await onCreate({
        title: title.trim(),
        description: description.trim(),
        provider: form.get('provider') === 'claude-code' ? 'claude-code' : 'codex',
      });
      formElement.reset();
      setOpen(false);
    } catch {
      // The parent surfaces the API error while the dialog keeps the entered values.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" disabled={disabled} />}><Plus data-icon="inline-start" />New requirement</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create a requirement and RD Session</DialogTitle>
            <DialogDescription>A unique Session is assigned immediately, with no scheduling or Agent allocation.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-5 gap-4">
            <Field>
              <FieldLabel htmlFor="requirement-title">Requirement title</FieldLabel>
              <Input id="requirement-title" name="title" required placeholder="For example: improve bulk import throughput" />
            </Field>
            <Field>
              <FieldLabel htmlFor="requirement-description">Task and acceptance criteria</FieldLabel>
              <Textarea id="requirement-description" name="description" required placeholder="Feature work, validation, or performance goals" />
            </Field>
            <Field>
              <FieldLabel htmlFor="requirement-provider">RD Agent</FieldLabel>
              <NativeSelect id="requirement-provider" name="provider" className="w-full" defaultValue="codex">
                <NativeSelectOption value="codex">Codex headless</NativeSelectOption>
                <NativeSelectOption value="claude-code">Claude Code headless</NativeSelectOption>
              </NativeSelect>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={submitting}>{submitting ? <LoaderCircle className="animate-spin" /> : null}Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionDialog({ apiUrl, onConnect }: { apiUrl: string; onConnect: (url: string) => void }) {
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
      setError(caught instanceof Error ? caught.message : 'Invalid URL');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setValue(apiUrl); }}>
      <DialogTrigger render={<Button variant="outline" size="icon" aria-label="Agent Manager connection settings" />}><Settings2 /></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Connect to Agent Manager</DialogTitle>
            <DialogDescription>The URL is stored in this browser and is not written to the project or uploaded.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-5">
            <Field>
              <FieldLabel htmlFor="manager-url">HTTP URL</FieldLabel>
              <Input id="manager-url" value={value} onChange={(event) => setValue(event.target.value)} placeholder={DEFAULT_AGENT_MANAGER_URL} />
            </Field>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit">Connect</Button>
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
  pullRequests,
  reviewRequests,
  messageLoading,
  busy,
  busyPullRequestId,
  onOpenChange,
  onStart,
  onReply,
  onInterrupt,
  onConfirm,
  onReview,
  apiUrl,
}: {
  requirement: RequirementDto | null;
  runs: AgentRunDto[];
  messages: RequirementMessageDto[];
  pullRequests: PullRequestDto[];
  reviewRequests: ReviewRequestDto[];
  messageLoading: boolean;
  busy: boolean;
  busyPullRequestId: string | null;
  onOpenChange: (open: boolean) => void;
  onStart: (message?: string, attachments?: File[]) => Promise<void>;
  onReply: (message: string, attachments?: File[]) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onConfirm: () => Promise<void>;
  onReview: (pullRequestId: string, provider: AgentProvider) => Promise<void>;
  apiUrl: string;
}) {
  const [message, setMessage] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const open = requirement !== null;
  const requirementId = requirement?.id;

  useEffect(() => {
    if (!requirementId || messageLoading) return;
    const frame = window.requestAnimationFrame(() => {
      conversationEndRef.current?.scrollIntoView({ block: 'end' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messageLoading, messages.length, requirementId]);

  useEffect(() => {
    draftAttachmentsRef.current = draftAttachments;
  }, [draftAttachments]);

  useEffect(() => () => {
    for (const attachment of draftAttachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  if (!requirement) return <Sheet open={false} onOpenChange={onOpenChange} />;
  const canWrite = requirement.status !== 'done' && requirement.status !== 'cancelled';

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const body = message.trim();
    if ((!body && draftAttachments.length === 0) || !canWrite) return;
    const attachmentFiles = draftAttachments.map((attachment) => attachment.file);
    try {
      if (requirement!.status === 'todo') await onStart(body || undefined, attachmentFiles);
      else await onReply(body, attachmentFiles);
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
      setAttachmentError('Each attachment must be 20 MB or smaller.');
      return;
    }
    if (files.length > remaining) {
      setAttachmentError(`Each message supports up to ${maxAttachmentsPerMessage} attachments.`);
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
      <SheetContent className="data-[side=right]:w-full! data-[side=right]:max-w-none! gap-0 sm:data-[side=right]:w-[min(820px,calc(100vw-48px))]!" side="right">
        <SheetHeader className="border-b border-border bg-card py-4 pr-12 pl-5 sm:pr-12 sm:pl-6">
          <div className="mb-2.5 flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-[10px]">REQ-{shortId(requirement.id)}</Badge>
            <Badge variant="secondary" className="text-[10px]">{statusLabel[requirement.status]}</Badge>
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className={`size-2 rounded-full ${stateDot[requirement.session.state]}`} />
              {stateLabel[requirement.session.state]}
            </span>
          </div>
          <SheetTitle className="text-xl leading-7 font-semibold tracking-[-0.025em]">{requirement.title}</SheetTitle>
          <SheetDescription className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span>{providerLabel(requirement.provider)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">ses-{shortId(requirement.session.id)}</span>
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 bg-muted/15">
          <div className="px-5 py-5 sm:px-6">
            <section className="rounded-xl border border-border/80 bg-card px-4 py-3.5">
              <p className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Requirement description</p>
              <p className="mt-1.5 text-xs leading-5 whitespace-pre-wrap">{requirement.description}</p>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/70 pt-3 text-[10px] text-muted-foreground sm:grid-cols-3">
                <div><dt className="sr-only">Created at</dt><dd>Created {formatTime(requirement.createdAt)}</dd></div>
                <div><dt className="sr-only">Run count</dt><dd>{runs.length} Runs</dd></div>
                <div className="col-span-2 min-w-0 sm:col-span-1"><dt className="sr-only">Native Session</dt><dd className="truncate" title={requirement.session.nativeSessionId ?? undefined}>Native: {requirement.session.nativeSessionId ? shortId(requirement.session.nativeSessionId) : 'Not created'}</dd></div>
              </dl>
            </section>

            {pullRequests.length > 0 ? (
              <section className="mt-5" aria-labelledby="linked-pull-requests">
                <div className="mb-2.5 flex items-center gap-2">
                  <GitPullRequest className="size-3.5 text-muted-foreground" />
                  <h3 id="linked-pull-requests" className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Linked Pull Requests</h3>
                  <Badge variant="secondary" className="ml-1 h-5 min-w-5 justify-center px-1.5 font-mono text-[9px]">{pullRequests.length}</Badge>
                </div>
                <div className="space-y-2">
                  {pullRequests.map((pullRequest) => (
                    <RequirementPullRequestCard
                      key={pullRequest.id}
                      pullRequest={pullRequest}
                      activeReview={reviewRequests.find((review) => review.pullRequestId === pullRequest.id && review.status === 'running')}
                      busy={busyPullRequestId === pullRequest.id}
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
                  <h3 id="requirement-conversation" className="text-xs font-semibold">Activity and conversation</h3>
                  <p className="mt-0.5 text-[9px] text-muted-foreground">{messages.length} messages · Continue with the same RD Session</p>
                </div>
              </div>

            {messageLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading messages</div>
            ) : null}
            {!messageLoading && messages.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
                <Bot className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-2 text-xs font-medium">No Agent output yet</p>
                <p className="mt-1 text-[10px] text-muted-foreground">RD Agent messages will appear here in real time after the requirement starts.</p>
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
                        <span className="text-[10px] font-semibold">System event</span>
                        <span className="shrink-0 text-[9px] text-muted-foreground">{formatTime(item.createdAt)}</span>
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
                      <span className="text-[10px] font-semibold">{authorLabel[item.author]}</span>
                      <span className="text-[9px] text-muted-foreground">{formatTime(item.createdAt)}</span>
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
                <span className="flex min-w-0 flex-1 items-center gap-2"><LoaderCircle className="size-3.5 shrink-0 animate-spin" />RD Agent is working; new messages are queued by default.</span>
                <Button type="button" variant="ghost" size="xs" className="shrink-0 text-amber-700 dark:text-amber-300" disabled={busy} onClick={() => void onInterrupt().catch(() => undefined)}>
                  <Square data-icon="inline-start" />Interrupt
                </Button>
              </div>
            ) : null}
            {requirement.session.pendingMessageCount > 0 ? (
              <div className="mt-3 rounded-lg bg-amber-500/8 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300">
                {requirement.session.pendingMessageCount} external messages will be processed by the RD Agent {requirement.session.state === 'running' ? 'after the current Run' : 'during the next Run'}.
              </div>
            ) : null}
              <div ref={conversationEndRef} aria-hidden="true" />
            </section>
          </div>
        </ScrollArea>

        <div className="border-t border-border bg-card px-4 py-3 sm:px-6">
          {requirement.status === 'waiting_confirmation' ? (
            <div className="mb-2.5 flex items-center justify-between gap-3 rounded-xl border border-violet-500/15 bg-violet-500/7 px-3 py-2 text-[10px] text-violet-700 dark:text-violet-300">
              <span>The Agent reported completion. You can still ask follow-up questions.</span>
              <Button size="xs" className="shrink-0" disabled={busy} onClick={() => void onConfirm().catch(() => undefined)}><Check data-icon="inline-start" />Confirm completion</Button>
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
                      aria-label={`Remove ${attachment.file.name}`}
                      onClick={() => removeAttachment(attachment.id)}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <Textarea
              aria-label="Reply to RD Agent"
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
              className="max-h-36 min-h-14 resize-none border-0 bg-transparent px-2 py-1.5 text-xs shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent"
              placeholder={requirement.status === 'todo' ? 'Add instructions and start; paste or drop attachments…' : requirement.session.state === 'running' ? 'Send a message or attachment; it will wait for the next Run by default…' : canWrite ? 'Reply to the RD Agent; paste or drop attachments…' : 'Replies are unavailable in the current state'}
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
                  aria-label="Add attachment"
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  <Paperclip />
                </Button>
                <span className="truncate text-[9px] text-muted-foreground">Enter to send · Up to 6 attachments</span>
              </div>
              <Button type="submit" size="icon-sm" className="rounded-xl" disabled={!canWrite || busy || (!message.trim() && draftAttachments.length === 0)} aria-label="Send reply">
                {busy ? <LoaderCircle className="animate-spin" /> : <Send />}
              </Button>
            </div>
          </form>
          {attachmentError ? <p className="mt-1.5 px-1 text-[10px] text-destructive">{attachmentError}</p> : null}
          {requirement.status === 'todo' ? (
            <Button className="mt-2 w-full" variant="ghost" size="xs" disabled={busy} onClick={() => void onStart()}>
              <Play data-icon="inline-start" />Start without additional instructions
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function Home() {
  const [view, setView] = useState<'requirements' | 'pull_requests' | 'sessions'>('requirements');
  const [apiUrl, setApiUrl] = useState(DEFAULT_AGENT_MANAGER_URL);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [workspace, setWorkspace] = useState<WorkspaceDto | null>(null);
  const [requirements, setRequirements] = useState<RequirementDto[]>([]);
  const [runs, setRuns] = useState<AgentRunDto[]>([]);
  const [pullRequests, setPullRequests] = useState<PullRequestDto[]>([]);
  const [reviewRequests, setReviewRequests] = useState<ReviewRequestDto[]>([]);
  const [messages, setMessages] = useState<RequirementMessageDto[]>([]);
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageRevision, setMessageRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<'all' | AgentProvider>('all');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyPullRequestId, setBusyPullRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  const client = useMemo(() => new AgentManagerClient(apiUrl), [apiUrl]);

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [nextWorkspace, nextRequirements, nextRuns, nextPullRequests, nextReviewRequests] = await Promise.all([
        client.getWorkspace(),
        client.listRequirements(),
        client.listRuns(),
        client.listPullRequests(),
        client.listReviewRequests(),
      ]);
      setWorkspace(nextWorkspace);
      setRequirements(nextRequirements);
      setRuns(nextRuns);
      setPullRequests(nextPullRequests);
      setReviewRequests(nextReviewRequests);
      setConnection('online');
      setError(null);
      setLastSynced(new Date());
    } catch (caught) {
      setConnection('offline');
      setError(caught instanceof Error ? caught.message : 'Unable to connect to Agent Manager');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [client]);

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
        .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Failed to load messages'); })
        .finally(() => { if (!cancelled) setMessageLoading(false); });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, messageRevision, selectedId]);

  const selectedRequirement = requirements.find((item) => item.id === selectedId) ?? null;
  const selectedRuns = runs.filter((run) => run.requirementId === selectedId);
  const selectedPullRequests = pullRequests.filter((pullRequest) => pullRequest.requirementId === selectedId);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requirements.filter((requirement) => {
      const matchesQuery = !needle || [requirement.id, requirement.title, requirement.description, requirement.session.id]
        .some((value) => value.toLowerCase().includes(needle));
      return matchesQuery && (provider === 'all' || requirement.provider === provider);
    });
  }, [provider, query, requirements]);

  const filteredPullRequests = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return pullRequests.filter((pullRequest) => !needle || [
      pullRequest.repository,
      String(pullRequest.number),
      pullRequest.title,
      pullRequest.headBranch,
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [pullRequests, query]);

  async function runAction(requirementId: string, action: () => Promise<unknown>): Promise<void> {
    setBusyId(requirementId);
    setError(null);
    try {
      await action();
      await reload(false);
      setMessageRevision((value) => value + 1);
    } catch (caught) {
      const prefix = caught instanceof AgentManagerApiError && caught.status === 409 ? 'This action conflicts with the current state. Refresh and try again.' : '';
      setError(prefix || (caught instanceof Error ? caught.message : 'Operation failed'));
      throw caught;
    } finally {
      setBusyId(null);
    }
  }

  async function requestReview(pullRequestId: string, reviewer: AgentProvider): Promise<void> {
    setBusyPullRequestId(pullRequestId);
    setError(null);
    try {
      await client.requestReview(pullRequestId, reviewer);
      await reload(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to request a review');
      throw caught;
    } finally {
      setBusyPullRequestId(null);
    }
  }

  async function uploadMessageAttachments(requirementId: string, files: File[]): Promise<string[]> {
    const attachments = await Promise.all(files.map((file) => client.uploadMessageAttachment(requirementId, file)));
    return attachments.map((attachment) => attachment.id);
  }

  async function createRequirement(input: { title: string; description: string; provider: AgentProvider }) {
    setError(null);
    try {
      const created = await client.createRequirement(input);
      await reload(false);
      setSelectedId(created.id);
      setView('requirements');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create requirement');
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
  const workspaceLabel = workspace?.root ?? 'Workspace not connected';

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/92 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground"><Zap className="size-4" fill="currentColor" /></span>
            <div className="hidden sm:block">
              <p className="text-sm leading-4 font-semibold tracking-[-0.02em]">Code Factory</p>
              <p className="text-[9px] font-medium tracking-[0.14em] text-muted-foreground uppercase">Agent Manager</p>
            </div>
          </div>

          <nav className="ml-1 flex h-full items-center gap-1 sm:ml-5" aria-label="Main navigation">
            <Button variant="ghost" size="sm" className={view === 'requirements' ? 'bg-muted' : 'text-muted-foreground'} onClick={() => setView('requirements')}><LayoutDashboard data-icon="inline-start" />Requirements</Button>
            <Button variant="ghost" size="sm" className={view === 'pull_requests' ? 'bg-muted' : 'text-muted-foreground'} onClick={() => setView('pull_requests')}><GitPullRequest data-icon="inline-start" />PR</Button>
            <Button variant="ghost" size="sm" className={view === 'sessions' ? 'bg-muted' : 'text-muted-foreground'} onClick={() => setView('sessions')}><Activity data-icon="inline-start" />Sessions</Button>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <div className="hidden max-w-80 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[10px] lg:flex">
              <CircleDot className={`size-3 shrink-0 ${connection === 'online' ? 'text-emerald-500' : connection === 'reconnecting' ? 'text-amber-500' : 'text-rose-500'}`} />
              <span className="truncate font-mono">{workspaceLabel}</span>
            </div>
            <Button variant="outline" size="icon" aria-label="Refresh" disabled={loading} onClick={() => void reload(true)}><RefreshCw className={loading ? 'animate-spin' : ''} /></Button>
            <ConnectionDialog apiUrl={apiUrl} onConnect={connect} />
            <NewRequirementDialog disabled={connection !== 'online'} onCreate={createRequirement} />
          </div>
        </div>
      </header>

      <section className="border-b border-border/70 px-4 py-4 lg:px-6" aria-labelledby="overview-title">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 id="overview-title" className="text-xl font-semibold tracking-[-0.03em]">
                {view === 'requirements' ? 'Requirement workflow' : view === 'pull_requests' ? 'Pull Requests' : 'RD Agent Sessions'}
              </h1>
              <Badge variant="secondary" className="font-mono text-[9px]">{connection === 'online' ? 'LIVE' : 'OFFLINE'}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {view === 'requirements'
                ? 'The requirement conversation is the RD Agent message stream; messages remain available while it runs'
                : view === 'pull_requests'
                  ? 'A human can select Codex or Claude to run a one-off review on an Open PR'
                  : 'Sessions inherit the Agent Manager working directory and native Skills'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-5 text-xs">
            <div><span className="mr-1.5 text-lg font-semibold tabular-nums">{activeSessions}</span><span className="text-muted-foreground">Running</span></div>
            <div><span className="mr-1.5 text-lg font-semibold tabular-nums text-violet-600">{waitingHumans}</span><span className="text-muted-foreground">Waiting for human</span></div>
            <div><span className="mr-1.5 text-lg font-semibold tabular-nums text-rose-600">{failures}</span><span className="text-muted-foreground">Failed</span></div>
            <div className="hidden h-7 w-px bg-border sm:block" />
            <div className="relative hidden sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search requirements or Sessions" value={query} onChange={(event) => setQuery(event.target.value)} className="w-56 pr-3 pl-8 text-xs" placeholder="Search requirements or Sessions" />
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <div className="px-4 pt-4 lg:px-6">
          <Alert variant="destructive">
            <WifiOff />
            <AlertTitle>{connection === 'offline' ? 'Agent Manager not connected' : 'Operation incomplete'}</AlertTitle>
            <AlertDescription>{error} {connection === 'offline' ? 'Confirm that Agent Manager is running and allows access from http://localhost:3000.' : ''}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5 lg:px-6">
        <Button variant="secondary" size="xs" title={workspace?.root}><FolderGit2 data-icon="inline-start" />{workspaceLabel}</Button>
        <Button variant={provider === 'all' ? 'ghost' : 'secondary'} size="xs" className={provider === 'all' ? 'text-muted-foreground' : ''} onClick={cycleProvider}>{provider === 'all' ? 'All Agents' : providerLabel(provider)}</Button>
        <span className="ml-auto text-[10px] text-muted-foreground">{lastSynced ? `Last synced ${lastSynced.toLocaleTimeString('en-US')}` : apiUrl}</span>
      </div>

      <section className="kanban-scroll overflow-x-auto" aria-label={view === 'requirements' ? 'Requirement board' : view === 'pull_requests' ? 'Pull Request board' : 'Agent Session board'}>
        {view === 'requirements' ? (
          <div className="grid min-h-[calc(100vh-176px)] min-w-max grid-cols-4 gap-4 p-4 lg:p-5">
            {requirementColumns.map((column) => {
              const items = filtered.filter((item) => item.status === column.status);
              return (
                <section key={column.status} className="w-[300px]" aria-labelledby={`requirement-${column.status}`}>
                  <header className="mb-3 h-11 px-1">
                    <div className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${column.tone}`} /><h2 id={`requirement-${column.status}`} className="text-xs font-semibold">{column.title}</h2><span className="font-mono text-[10px] text-muted-foreground">{items.length}</span></div>
                    <p className="mt-1 pl-3.5 text-[10px] text-muted-foreground">{column.description}</p>
                  </header>
                  <div className="space-y-2.5">
                    {items.map((item) => (
                      <RequirementCard
                        key={item.id}
                        requirement={item}
                        run={latestRun(item.id, runs)}
                        busy={busyId === item.id}
                        onOpen={() => setSelectedId(item.id)}
                        onStart={() => void runAction(item.id, () => client.startRequirement(item.id)).catch(() => undefined)}
                        onConfirm={() => void runAction(item.id, () => client.confirmRequirement(item.id)).catch(() => undefined)}
                      />
                    ))}
                    {items.length === 0 ? <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-border text-[10px] text-muted-foreground">{loading ? 'Loading…' : 'No requirements'}</div> : null}
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
                      <h2 id={`pull-request-${column.status}`} className="text-xs font-semibold">{column.title}</h2>
                      <span className="font-mono text-[10px] text-muted-foreground">{items.length}</span>
                    </div>
                    <p className="mt-1 pl-3.5 text-[10px] text-muted-foreground">{column.description}</p>
                  </header>
                  <div className="space-y-2.5">
                    {items.map((pullRequest) => (
                      <PullRequestCard
                        key={pullRequest.id}
                        pullRequest={pullRequest}
                        requirement={requirements.find((requirement) => requirement.id === pullRequest.requirementId)}
                        activeReview={reviewRequests.find((review) => review.pullRequestId === pullRequest.id && review.status === 'running')}
                        busy={busyPullRequestId === pullRequest.id}
                        onReview={(reviewer) => requestReview(pullRequest.id, reviewer)}
                      />
                    ))}
                    {items.length === 0 ? (
                      <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-border text-[10px] text-muted-foreground">
                        {loading ? 'Loading…' : 'No Pull Requests'}
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
              const items = filtered.filter((item) => item.session.state === column.state);
              return (
                <section key={column.state} className="w-[266px]" aria-labelledby={`session-${column.state}`}>
                  <header className="mb-3 h-11 px-1">
                    <div className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${column.tone}`} /><h2 id={`session-${column.state}`} className="text-xs font-semibold">{column.title}</h2><span className="font-mono text-[10px] text-muted-foreground">{items.length}</span></div>
                    <p className="mt-1 pl-3.5 text-[10px] text-muted-foreground">{column.description}</p>
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
                    {items.length === 0 ? <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-border text-[10px] text-muted-foreground">No Sessions</div> : null}
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
        pullRequests={selectedPullRequests}
        reviewRequests={reviewRequests}
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
      />

      <div className="fixed right-4 bottom-4 hidden items-center gap-2 rounded-lg border border-border bg-card/95 px-3 py-2 text-[10px] text-muted-foreground shadow-lg backdrop-blur sm:flex">
        <Terminal className="size-3.5" />
        <span>{connection === 'online' ? 'Agent Manager online' : connection === 'reconnecting' ? 'Reconnecting' : 'Agent Manager offline'}</span>
        <span className={`size-1.5 rounded-full ${connection === 'online' ? 'bg-emerald-500' : connection === 'reconnecting' ? 'bg-amber-500' : 'bg-rose-500'}`} />
      </div>
    </main>
  );
}
