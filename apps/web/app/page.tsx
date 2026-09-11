'use client';

import { type SyntheticEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  Check,
  CircleDot,
  Clock3,
  FolderGit2,
  ExternalLink,
  GitPullRequest,
  LayoutDashboard,
  LoaderCircle,
  MessageSquareReply,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Send,
  Settings2,
  Terminal,
  TriangleAlert,
  UserRound,
  WifiOff,
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
  { status: 'todo', title: 'TODO', description: 'Session 已绑定，尚未开始', tone: 'bg-sky-500' },
  { status: 'doing', title: 'DOING', description: '执行任务或等待 PR 事件', tone: 'bg-amber-500' },
  { status: 'waiting_confirmation', title: '待确认', description: '可回复继续，或确认完成', tone: 'bg-violet-500' },
  { status: 'done', title: 'DONE', description: '已由人类确认完成', tone: 'bg-emerald-600' },
];

const pullRequestColumns: Array<{ status: PullRequestStatus; title: string; description: string; tone: string }> = [
  { status: 'draft', title: 'DRAFT', description: '仍在准备，暂不发起 Review', tone: 'bg-slate-400' },
  { status: 'open', title: 'OPEN', description: '可由人类选择 Agent 发起 Review', tone: 'bg-emerald-500' },
  { status: 'closed', title: 'CLOSED', description: '已关闭且未合并', tone: 'bg-rose-500' },
  { status: 'merged', title: 'MERGED', description: '已合并到目标分支', tone: 'bg-violet-500' },
];

const sessionColumns: Array<{
  state: SessionState;
  title: string;
  description: string;
  tone: string;
}> = [
  { state: 'idle', title: '未运行', description: 'Session 已绑定，尚无 Run', tone: 'bg-slate-400' },
  { state: 'running', title: '执行中', description: 'Headless CLI 正在运行', tone: 'bg-emerald-500' },
  { state: 'waiting_human', title: '等待人类', description: '等待回复或完成确认', tone: 'bg-violet-500' },
  { state: 'failed', title: '异常', description: '可在原 Session 中继续', tone: 'bg-rose-500' },
  { state: 'completed', title: '已结束', description: '需求完成，Session 已归档', tone: 'bg-teal-600' },
];

const stateLabel: Record<SessionState, string> = {
  idle: '未运行',
  running: '执行中',
  waiting_human: '等待人类',
  failed: '异常',
  completed: '已结束',
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
  waiting_confirmation: '待确认',
  done: 'DONE',
  cancelled: '已取消',
};

const authorLabel: Record<RequirementMessageDto['author'], string> = {
  human: '人类',
  rd_agent: 'RD Agent',
  reviewer: 'Reviewer',
  system: '系统',
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
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '刚刚';
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

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
          <p className="mt-2 text-[10px] font-medium text-amber-600">{requirement.session.pendingMessageCount} 条消息待处理</p>
        ) : null}
      </div>

      {requirement.status === 'todo' ? (
        <Button size="xs" className="mt-3 w-full" disabled={busy} onClick={onStart}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Play data-icon="inline-start" />}开始执行
        </Button>
      ) : null}
      {requirement.status === 'waiting_confirmation' ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={onOpen}><MessageSquareReply data-icon="inline-start" />回复</Button>
          <Button size="xs" disabled={busy} onClick={onConfirm}><Check data-icon="inline-start" />确认完成</Button>
        </div>
      ) : null}
      {requirement.status === 'doing' && requirement.session.state !== 'running' ? (
        <Button size="xs" variant="outline" className="mt-3 w-full" onClick={onOpen}><MessageSquareReply data-icon="inline-start" />打开对话</Button>
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
        <p className="mt-2 text-[10px] font-medium text-amber-600">{requirement.session.pendingMessageCount} 条外部消息待处理</p>
      ) : null}
      {requirement.session.lastError ? (
        <Button size="xs" variant="destructive" className="mt-3 w-full" disabled={busy} onClick={onRetry}>
          {busy ? <LoaderCircle className="animate-spin" /> : <RotateCcw data-icon="inline-start" />}重试原 Session
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
            {activeReview ? 'Review 中' : 'Request review'}
          </Button>
        </div>
      ) : null}
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
      <DialogTrigger render={<Button size="sm" disabled={disabled} />}><Plus data-icon="inline-start" />新建需求</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>创建需求与 RD Session</DialogTitle>
            <DialogDescription>创建时立即绑定唯一 Session，不经过调度或 Agent 分配。</DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-5 gap-4">
            <Field>
              <FieldLabel htmlFor="requirement-title">需求标题</FieldLabel>
              <Input id="requirement-title" name="title" required placeholder="例如：优化主键表批量导入吞吐" />
            </Field>
            <Field>
              <FieldLabel htmlFor="requirement-description">任务内容与完成条件</FieldLabel>
              <Textarea id="requirement-description" name="description" required placeholder="功能开发、测试验证或性能优化目标" />
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
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={submitting}>{submitting ? <LoaderCircle className="animate-spin" /> : null}创建</Button>
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
      setError(caught instanceof Error ? caught.message : '地址无效');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setValue(apiUrl); }}>
      <DialogTrigger render={<Button variant="outline" size="icon" aria-label="Agent Manager 连接设置" />}><Settings2 /></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>连接 Agent Manager</DialogTitle>
            <DialogDescription>地址保存在当前浏览器，不会写入项目或上传到站点。</DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-5">
            <Field>
              <FieldLabel htmlFor="manager-url">HTTP 地址</FieldLabel>
              <Input id="manager-url" value={value} onChange={(event) => setValue(event.target.value)} placeholder={DEFAULT_AGENT_MANAGER_URL} />
            </Field>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit">连接</Button>
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
  onConfirm,
  onReview,
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
  onStart: (message?: string) => Promise<void>;
  onReply: (message: string) => Promise<void>;
  onConfirm: () => Promise<void>;
  onReview: (pullRequestId: string, provider: AgentProvider) => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const open = requirement !== null;

  if (!requirement) return <Sheet open={false} onOpenChange={onOpenChange} />;
  const canWrite = requirement.status !== 'done' && requirement.status !== 'cancelled';

  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const body = message.trim();
    if (!body || !canWrite) return;
    try {
      if (requirement!.status === 'todo') await onStart(body);
      else await onReply(body);
      setMessage('');
    } catch {
      // Keep the reply in the editor so it can be retried.
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-[720px]" side="right">
        <SheetHeader className="border-b border-border px-5 py-4 pr-12">
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-[10px]">REQ-{shortId(requirement.id)}</Badge>
            <Badge variant="secondary" className="text-[10px]">{statusLabel[requirement.status]}</Badge>
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className={`size-2 rounded-full ${stateDot[requirement.session.state]}`} />
              {stateLabel[requirement.session.state]}
            </span>
          </div>
          <SheetTitle className="text-lg font-semibold tracking-[-0.02em]">{requirement.title}</SheetTitle>
          <SheetDescription className="mt-1 text-xs">
            {providerLabel(requirement.provider)} · ses-{shortId(requirement.session.id)}
          </SheetDescription>
        </SheetHeader>

        <div className="grid grid-cols-1 border-b border-border bg-muted/25 sm:grid-cols-[1fr_180px]">
          <div className="border-b border-border px-5 py-3 sm:border-r sm:border-b-0">
            <p className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">需求描述</p>
            <p className="mt-1.5 text-xs leading-5 whitespace-pre-wrap">{requirement.description}</p>
          </div>
          <div className="px-5 py-3 text-[10px] text-muted-foreground">
            <p>创建于 {formatTime(requirement.createdAt)}</p>
            <p className="mt-1">共 {runs.length} 个 Run</p>
            <p className="mt-1 truncate" title={requirement.session.nativeSessionId ?? undefined}>
              Native: {requirement.session.nativeSessionId ? shortId(requirement.session.nativeSessionId) : '尚未建立'}
            </p>
          </div>
        </div>

        {pullRequests.length > 0 ? (
          <div className="border-b border-border px-5 py-4">
            <div className="mb-2 flex items-center gap-2">
              <GitPullRequest className="size-3.5" />
              <p className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Pull Requests</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {pullRequests.map((pullRequest) => (
                <PullRequestCard
                  key={pullRequest.id}
                  pullRequest={pullRequest}
                  activeReview={reviewRequests.find((review) => review.pullRequestId === pullRequest.id && review.status === 'running')}
                  busy={busyPullRequestId === pullRequest.id}
                  onReview={(provider) => onReview(pullRequest.id, provider)}
                />
              ))}
            </div>
          </div>
        ) : null}

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 px-5 py-5">
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-medium text-muted-foreground">活动与对话</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            {messageLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />加载消息</div>
            ) : null}
            {!messageLoading && messages.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
                <Bot className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-2 text-xs font-medium">还没有 Agent 输出</p>
                <p className="mt-1 text-[10px] text-muted-foreground">开始需求后，RD Agent 的消息会实时出现在这里。</p>
              </div>
            ) : null}

            {messages.map((item) => {
              const human = item.author === 'human';
              const system = item.author === 'system';
              return (
                <article key={item.id} className={`flex gap-3 ${human ? 'flex-row-reverse' : ''}`}>
                  <span className={`grid size-7 shrink-0 place-items-center rounded-lg ${system ? 'bg-rose-500/10 text-rose-600' : human ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
                    {human ? <UserRound className="size-3.5" /> : system ? <TriangleAlert className="size-3.5" /> : <Bot className="size-3.5" />}
                  </span>
                  <div className={`min-w-0 max-w-[84%] ${human ? 'text-right' : ''}`}>
                    <div className={`flex items-center gap-2 ${human ? 'justify-end' : ''}`}>
                      <span className="text-[10px] font-semibold">{authorLabel[item.author]}</span>
                      <span className="text-[9px] text-muted-foreground">{formatTime(item.createdAt)}</span>
                    </div>
                    <div className={`mt-1.5 rounded-xl px-3 py-2.5 text-left text-xs leading-5 whitespace-pre-wrap ${system ? 'bg-rose-500/8 text-rose-700 dark:text-rose-300' : human ? 'bg-primary text-primary-foreground' : 'bg-muted/75'}`}>
                      {item.body}
                    </div>
                  </div>
                </article>
              );
            })}

            {requirement.session.state === 'running' ? (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="grid size-7 place-items-center rounded-lg bg-emerald-500/10 text-emerald-600"><Bot className="size-3.5" /></span>
                <span className="flex items-center gap-2"><LoaderCircle className="size-3.5 animate-spin" />RD Agent 正在工作，输出会自动更新…</span>
              </div>
            ) : null}
            {requirement.session.pendingMessageCount > 0 ? (
              <div className="rounded-lg bg-amber-500/8 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300">
                {requirement.session.pendingMessageCount} 条外部消息将在当前 Run 结束后由 RD Agent 处理。
              </div>
            ) : null}
          </div>
        </ScrollArea>

        <div className="border-t border-border bg-card p-4">
          {requirement.status === 'waiting_confirmation' ? (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-violet-500/8 px-3 py-2 text-[11px] text-violet-700 dark:text-violet-300">
              <span>Agent 已汇报完成。可以继续回复，也可以确认需求完成。</span>
              <Button size="xs" disabled={busy} onClick={() => void onConfirm().catch(() => undefined)}><Check data-icon="inline-start" />确认完成</Button>
            </div>
          ) : null}
          <form className="flex items-end gap-2" onSubmit={submit}>
            <Textarea
              aria-label="回复 RD Agent"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              disabled={!canWrite || busy}
              className="min-h-18 resize-none text-xs"
              placeholder={requirement.status === 'todo' ? '补充要求并开始执行…' : requirement.session.state === 'running' ? '发送消息；当前 Run 结束后自动处理…' : canWrite ? '回复 RD Agent，继续同一个 Session…' : '当前状态暂不可回复'}
            />
            <Button type="submit" size="icon" disabled={!canWrite || busy || !message.trim()} aria-label="发送回复">
              {busy ? <LoaderCircle className="animate-spin" /> : <Send />}
            </Button>
          </form>
          {requirement.status === 'todo' ? (
            <Button className="mt-2 w-full" variant="outline" size="sm" disabled={busy} onClick={() => void onStart()}>
              <Play data-icon="inline-start" />不补充，直接开始
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
      setError(caught instanceof Error ? caught.message : '无法连接 Agent Manager');
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
        .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : '消息加载失败'); })
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
      const prefix = caught instanceof AgentManagerApiError && caught.status === 409 ? '当前操作与已有状态冲突，请刷新后重试。' : '';
      setError(prefix || (caught instanceof Error ? caught.message : '操作失败'));
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
      setError(caught instanceof Error ? caught.message : 'Review Request 发起失败');
      throw caught;
    } finally {
      setBusyPullRequestId(null);
    }
  }

  async function createRequirement(input: { title: string; description: string; provider: AgentProvider }) {
    setError(null);
    try {
      const created = await client.createRequirement(input);
      await reload(false);
      setSelectedId(created.id);
      setView('requirements');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建需求失败');
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
  const workspaceLabel = workspace?.root ?? '未连接 workspace';

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

          <nav className="ml-1 flex h-full items-center gap-1 sm:ml-5" aria-label="主导航">
            <Button variant="ghost" size="sm" className={view === 'requirements' ? 'bg-muted' : 'text-muted-foreground'} onClick={() => setView('requirements')}><LayoutDashboard data-icon="inline-start" />需求</Button>
            <Button variant="ghost" size="sm" className={view === 'pull_requests' ? 'bg-muted' : 'text-muted-foreground'} onClick={() => setView('pull_requests')}><GitPullRequest data-icon="inline-start" />PR</Button>
            <Button variant="ghost" size="sm" className={view === 'sessions' ? 'bg-muted' : 'text-muted-foreground'} onClick={() => setView('sessions')}><Activity data-icon="inline-start" />Sessions</Button>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <div className="hidden max-w-80 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[10px] lg:flex">
              <CircleDot className={`size-3 shrink-0 ${connection === 'online' ? 'text-emerald-500' : connection === 'reconnecting' ? 'text-amber-500' : 'text-rose-500'}`} />
              <span className="truncate font-mono">{workspaceLabel}</span>
            </div>
            <Button variant="outline" size="icon" aria-label="刷新" disabled={loading} onClick={() => void reload(true)}><RefreshCw className={loading ? 'animate-spin' : ''} /></Button>
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
                {view === 'requirements' ? '需求工作流' : view === 'pull_requests' ? 'Pull Requests' : 'RD Agent Sessions'}
              </h1>
              <Badge variant="secondary" className="font-mono text-[9px]">{connection === 'online' ? 'LIVE' : 'OFFLINE'}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {view === 'requirements'
                ? '需求对话是 RD Agent 的消息流，运行中也可以继续发送'
                : view === 'pull_requests'
                  ? 'Open PR 可由人类选择 Codex 或 Claude 发起一次性 Review'
                  : 'Session 继承 Agent Manager 的工作目录与原生 Skills'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-5 text-xs">
            <div><span className="mr-1.5 text-lg font-semibold tabular-nums">{activeSessions}</span><span className="text-muted-foreground">执行中</span></div>
            <div><span className="mr-1.5 text-lg font-semibold tabular-nums text-violet-600">{waitingHumans}</span><span className="text-muted-foreground">等人类</span></div>
            <div><span className="mr-1.5 text-lg font-semibold tabular-nums text-rose-600">{failures}</span><span className="text-muted-foreground">异常</span></div>
            <div className="hidden h-7 w-px bg-border sm:block" />
            <div className="relative hidden sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="搜索需求或 Session" value={query} onChange={(event) => setQuery(event.target.value)} className="w-56 pr-3 pl-8 text-xs" placeholder="搜索需求或 Session" />
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <div className="px-4 pt-4 lg:px-6">
          <Alert variant="destructive">
            <WifiOff />
            <AlertTitle>{connection === 'offline' ? 'Agent Manager 未连接' : '操作未完成'}</AlertTitle>
            <AlertDescription>{error} {connection === 'offline' ? '请确认 Agent Manager 已启动，并允许 http://localhost:3000 访问。' : ''}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5 lg:px-6">
        <Button variant="secondary" size="xs" title={workspace?.root}><FolderGit2 data-icon="inline-start" />{workspaceLabel}</Button>
        <Button variant={provider === 'all' ? 'ghost' : 'secondary'} size="xs" className={provider === 'all' ? 'text-muted-foreground' : ''} onClick={cycleProvider}>{provider === 'all' ? '全部 Agent' : providerLabel(provider)}</Button>
        <span className="ml-auto text-[10px] text-muted-foreground">{lastSynced ? `最后同步 ${lastSynced.toLocaleTimeString('zh-CN')}` : apiUrl}</span>
      </div>

      <section className="kanban-scroll overflow-x-auto" aria-label={view === 'requirements' ? '需求看板' : view === 'pull_requests' ? 'Pull Request 看板' : 'Agent Session 看板'}>
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
                    {items.length === 0 ? <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-border text-[10px] text-muted-foreground">{loading ? '正在加载…' : '当前无需求'}</div> : null}
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
                        {loading ? '正在加载…' : '当前无 PR'}
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
                    {items.length === 0 ? <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-border text-[10px] text-muted-foreground">当前无 Session</div> : null}
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
        onOpenChange={(open) => { if (!open) setSelectedId(null); }}
        onStart={(message) => selectedRequirement ? runAction(selectedRequirement.id, () => client.startRequirement(selectedRequirement.id, message)) : Promise.resolve()}
        onReply={(message) => selectedRequirement ? runAction(selectedRequirement.id, () => client.replyToRequirement(selectedRequirement.id, message)) : Promise.resolve()}
        onConfirm={() => selectedRequirement ? runAction(selectedRequirement.id, () => client.confirmRequirement(selectedRequirement.id)) : Promise.resolve()}
        onReview={requestReview}
      />

      <div className="fixed right-4 bottom-4 hidden items-center gap-2 rounded-lg border border-border bg-card/95 px-3 py-2 text-[10px] text-muted-foreground shadow-lg backdrop-blur sm:flex">
        <Terminal className="size-3.5" />
        <span>{connection === 'online' ? 'Agent Manager 在线' : connection === 'reconnecting' ? '正在重连' : 'Agent Manager 离线'}</span>
        <span className={`size-1.5 rounded-full ${connection === 'online' ? 'bg-emerald-500' : connection === 'reconnecting' ? 'bg-amber-500' : 'bg-rose-500'}`} />
      </div>
    </main>
  );
}
