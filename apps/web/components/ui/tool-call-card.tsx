'use client';

// Adapted from affectUI Tool Call Card (Clean), MIT © 2026 Florian Höller (adfects).
// https://www.affectui.com/components/tool-call-card — see THIRD_PARTY_NOTICES.md.
import { memo, useEffect, useId, useState, type ReactNode } from 'react';
import { Check, ChevronDown, CircleHelp, Copy, LoaderCircle, TriangleAlert, Wrench } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ToolCallStatus = 'running' | 'success' | 'error' | 'incomplete';

export function ToolCallCard({ name, summary, status, args, result, startedAt, duration, className }: {
  name: string;
  summary: string;
  status: ToolCallStatus;
  args?: string;
  result?: string;
  startedAt?: number;
  duration?: number;
  className?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  // A user's explicit toggle takes precedence over automatically opening an error.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? status === 'error';
  const elapsed = useElapsedTime(status === 'running', startedAt);
  const statusLabel = t(status === 'running' ? 'Running'
    : status === 'success' ? 'Completed'
    : status === 'error' ? 'Failed' : 'No result captured');
  const milliseconds = status === 'running' ? elapsed : duration;
  const timeLabel = milliseconds === undefined ? null : milliseconds < 1000
    ? t('{count} ms', { count: Math.round(milliseconds) })
    : t('{count} s', { count: (milliseconds / 1000).toFixed(1) });

  return (
    <div className={cn('cf-tool-call', className)} data-status={status} data-open={open || undefined}>
      <style href="cf-tool-call" precedence="default">{css}</style>
      <output className="sr-only" aria-live="polite">{t('{name}: {status}', { name, status: statusLabel })}</output>
      <button
        type="button"
        className="cf-tool-call__head"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => setUserOpen(!open)}
      >
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="cf-tool-call__main">
          <code className="cf-tool-call__name" title={name}>{name}</code>
          <span className="cf-tool-call__summary" title={summary}>{summary}</span>
        </span>
        <span className="cf-tool-call__status">
          {status === 'running' ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
            : status === 'success' ? <Check className="size-3.5" aria-hidden="true" />
            : status === 'error' ? <TriangleAlert className="size-3.5" aria-hidden="true" />
            : <CircleHelp className="size-3.5" aria-hidden="true" />}
          <span>{statusLabel}</span>
          {timeLabel ? <span className="cf-tool-call__time">{timeLabel}</span> : null}
        </span>
        <ChevronDown className="cf-tool-call__chevron size-3.5 shrink-0" aria-hidden="true" />
      </button>
      <div className="cf-tool-call__body" id={`${id}-body`} inert={!open}>
        <div className="cf-tool-call__clip">
          <div className="cf-tool-call__sections">
            {/* Mount payloads on demand: closed cards do no JSON highlighting or layout work. */}
            {open ? <>
              {args !== undefined ? <CodeSection label={t('Arguments')} copyLabel={t('Copy arguments')} value={args} /> : null}
              {result !== undefined ? <CodeSection label={t('Result')} copyLabel={t('Copy result')} value={result} /> : null}
              {result === undefined ? (
                <p className="text-[11px] text-muted-foreground">{t(status === 'running' ? 'Waiting for result…'
                  : status === 'error' ? 'The tool call failed.' : 'No result captured')}</p>
              ) : null}
            </> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

const CodeSection = memo(function CodeSection({ label, copyLabel, value }: { label: string; copyLabel: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const formatted = formatPayload(value);

  function formatPayload(value: string) {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const text = JSON.stringify(JSON.parse(trimmed), null, 2);
        return { text, content: highlight(text) };
      } catch { /* Provider output may be plain text or incomplete JSON. */ }
    }
    return { text: value, content: value };
  }

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatted.text);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <section className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-medium text-muted-foreground">{label}</h4>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={copied ? t('Copied') : copyLabel} title={copied ? t('Copied') : copyLabel} onClick={() => void copy()}>
          {copied ? <Check className="text-primary" /> : <Copy />}
        </Button>
      </div>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Scrollable output must be keyboard accessible. */}
      <pre className="cf-tool-call__code" tabIndex={0} aria-label={label}><code>{formatted.content}</code></pre>
      <output className={copyFailed ? 'mt-1 block text-[10px] text-destructive' : 'sr-only'} aria-live="polite">{copyFailed ? t('Copy failed. Select and copy the text manually.') : copied ? t('Copied') : ''}</output>
    </section>
  );
});

function useElapsedTime(running: boolean, startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    if (!running || startedAt === undefined) return;
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [running, startedAt]);
  return running && startedAt !== undefined && now !== undefined ? Math.max(0, now - startedAt) : undefined;
}

const token = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = new RegExp(token.source, 'g');
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const kind = match[1] && match[2] ? 'key' : match[1] ? 'str' : /^[tfn]/.test(match[0]) ? 'lit' : 'num';
    out.push(<span key={match.index} className={`cf-tool-call__t-${kind}`}>{match[1] && match[2] ? match[1] : match[0]}</span>);
    if (match[1] && match[2]) out.push(match[2]);
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const css = `
.cf-tool-call { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); color: var(--card-foreground); font-family: inherit; }
.cf-tool-call__head { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 10px 12px; text-align: left; cursor: pointer; transition: background-color 160ms ease; }
.cf-tool-call__head:hover { background: color-mix(in oklch, var(--muted) 45%, transparent); }
.cf-tool-call__head:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.cf-tool-call__main { display: flex; align-items: baseline; gap: 8px; flex: 1; min-width: 0; }
.cf-tool-call__name { max-width: 55%; overflow: hidden; font-family: var(--font-geist-mono), monospace; font-size: 11px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.cf-tool-call__summary { flex: 1; min-width: 0; overflow: hidden; color: var(--muted-foreground); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.cf-tool-call__status { display: inline-flex; align-items: center; gap: 5px; flex: none; color: var(--primary); font-size: 10px; line-height: 16px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cf-tool-call__time { color: var(--muted-foreground); }
.cf-tool-call[data-status="error"] .cf-tool-call__status { color: var(--destructive); }
.cf-tool-call[data-status="incomplete"] .cf-tool-call__status { color: var(--muted-foreground); }
.cf-tool-call__chevron { color: var(--muted-foreground); transition: transform 360ms cubic-bezier(.22,1,.36,1); }
.cf-tool-call[data-open] .cf-tool-call__chevron { transform: rotate(180deg); }
.cf-tool-call__body { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 380ms cubic-bezier(.22,1,.36,1), opacity 240ms ease; }
.cf-tool-call[data-open] .cf-tool-call__body { grid-template-rows: 1fr; opacity: 1; }
.cf-tool-call__clip { min-height: 0; overflow: hidden; }
.cf-tool-call__sections { display: grid; gap: 12px; padding: 0 12px; }
.cf-tool-call[data-open] .cf-tool-call__sections { padding: 10px 12px 12px; border-top: 1px solid var(--border); }
.cf-tool-call__code { max-height: 256px; overflow: auto; padding: 10px; border-radius: var(--radius-md); background: var(--muted); color: var(--foreground); font-family: var(--font-geist-mono), monospace; font-size: 10px; line-height: 17px; white-space: pre-wrap; overflow-wrap: anywhere; }
.cf-tool-call__code:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.cf-tool-call__t-key { color: var(--foreground); }
.cf-tool-call__t-str { color: var(--primary); }
.cf-tool-call__t-num { color: color-mix(in oklch, var(--foreground) 65%, var(--chart-3)); }
.cf-tool-call__t-lit { color: color-mix(in oklch, var(--foreground) 65%, var(--chart-4)); }
@media (max-width: 480px) {
  .cf-tool-call__head { flex-wrap: wrap; gap: 6px; padding: 10px; }
  .cf-tool-call__main { display: block; flex-basis: calc(100% - 44px); }
  .cf-tool-call__name { max-width: 100%; }
  .cf-tool-call__summary { display: block; max-width: 100%; }
  .cf-tool-call__status { order: 1; width: 100%; padding-left: 20px; white-space: normal; }
}
@media (prefers-reduced-motion: reduce) { .cf-tool-call *, .cf-tool-call *::after { animation: none !important; transition: none !important; } }
`;
