'use client';

import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { ToolCallCard } from '@/components/ui/tool-call-card';
import type { AgentTraceEventDto } from '@/lib/agent-manager-client';
import { buildTraceTimeline } from '@/lib/agent-trace-presentation';
import { useI18n } from '@/lib/i18n';
import type { TranslationKey } from '@/locales/zh-CN';

const traceKindLabel: Record<AgentTraceEventDto['kind'], TranslationKey> = {
  lifecycle: 'Lifecycle', reasoning: 'Reasoning', assistant_message: 'Agent message',
  tool_call: 'Tool call', tool_result: 'Tool result', error: 'Error',
};

export function AgentTraceTimeline({ trace, runningRunIds }: {
  trace: readonly AgentTraceEventDto[];
  runningRunIds: ReadonlySet<string>;
}) {
  const { locale, t } = useI18n();
  const items = useMemo(() => buildTraceTimeline(trace, runningRunIds), [trace, runningRunIds]);

  return (
    <ol className="space-y-4">
      {items.map((item) => {
        const event = item.event;
        const failed = item.kind === 'tool' ? item.status === 'error' : event.kind === 'error' || event.status === 'failed';
        return (
          <li key={event.id} className="relative min-w-0 pl-5 before:absolute before:top-5 before:bottom-[-1rem] before:left-[5px] before:w-px before:bg-border last:before:hidden">
            <span className={`absolute top-1 left-0 size-2.5 rounded-full border-2 border-card ${failed ? 'bg-destructive' : item.kind === 'tool' ? 'bg-amber-500' : event.kind === 'reasoning' ? 'bg-violet-500' : 'bg-emerald-500'}`} />
            <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="h-5 text-[9px]">{t(item.kind === 'tool' ? 'Tool call' : traceKindLabel[event.kind])}</Badge>
              {item.kind === 'event' ? <span className="min-w-0 flex-1 truncate text-[10px] font-semibold" title={event.title}>{event.title}</span> : <span className="flex-1" />}
              <span className="shrink-0 font-mono text-[8px] text-muted-foreground">run-{event.runId.split('_').at(-1)?.slice(0, 8)}</span>
              <time className="shrink-0 text-[9px] text-muted-foreground" dateTime={event.createdAt}>
                {new Date(event.createdAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </time>
            </div>
            {item.kind === 'tool' ? (
              <ToolCallCard
                name={item.call?.toolName ?? item.result?.toolName ?? t('Tool call')}
                summary={item.call?.title ?? item.result?.title ?? event.title}
                status={item.status}
                args={item.call?.detail ?? undefined}
                result={item.result?.detail ?? undefined}
                startedAt={item.startedAt}
                duration={item.duration}
              />
            ) : event.detail ? (
              <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg bg-muted/55 px-3 py-2 font-mono text-[10px] leading-4 whitespace-pre-wrap break-words text-foreground/80">{event.detail}</pre>
            ) : null}
            {event.toolCallId || event.nativeType ? (
              <p className="mt-1 truncate font-mono text-[8px] text-muted-foreground" title={[event.toolCallId, event.nativeType].filter(Boolean).join(' · ')}>
                {[event.toolCallId, event.nativeType].filter(Boolean).join(' · ')}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
