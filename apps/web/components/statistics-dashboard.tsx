'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Bot,
  ChartNoAxesCombined,
  CircleGauge,
  Cpu,
  LoaderCircle,
  MessagesSquare,
  UsersRound,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import type {
  AgentManagerClient,
  AgentProvider,
  StatisticsSnapshotDto,
} from '@/lib/agent-manager-client';
import { useI18n } from '@/lib/i18n';

export type StatisticsTimeRange = '1d' | '7d' | '30d' | '90d' | 'all';

const timeRangeMilliseconds: Record<Exclude<StatisticsTimeRange, 'all'>, number> = {
  '1d': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
  '90d': 90 * 24 * 60 * 60 * 1_000,
};

function compactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function percentage(value: number | null, locale: string): string {
  return value === null
    ? '—'
    : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

function ratio(value: number | null, locale: string): string {
  return value === null
    ? '—'
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

function StatisticsMetric({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof CircleGauge;
  label: string;
  value: string;
  detail: string;
  tone: string;
}) {
  return (
    <Card size="sm" className="relative min-h-32">
      <CardContent className="flex h-full flex-col justify-between gap-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <span className={`grid size-8 place-items-center rounded-lg ${tone}`}><Icon className="size-4" /></span>
        </div>
        <div>
          <p className="text-3xl font-semibold tracking-[-0.05em] tabular-nums">{value}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyChart({ children }: { children: string }) {
  return (
    <div className="grid h-64 place-items-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function StatisticsDashboard({
  client,
  timeRange,
  provider,
  refreshKey,
}: {
  client: AgentManagerClient;
  timeRange: StatisticsTimeRange;
  provider: 'all' | AgentProvider;
  refreshKey: number;
}) {
  const { locale, t } = useI18n();
  const [statistics, setStatistics] = useState<StatisticsSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const numberLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US';

  useEffect(() => {
    let current = true;
    const to = new Date();
    const from = timeRange === 'all'
      ? undefined
      : new Date(to.getTime() - timeRangeMilliseconds[timeRange]).toISOString();
    void client.getStatistics({
      ...(from ? { from } : {}),
      to: to.toISOString(),
      ...(provider === 'all' ? {} : { provider }),
    }).then((snapshot) => {
      if (!current) return;
      setStatistics(snapshot);
      setError(null);
    }).catch((caught: unknown) => {
      if (!current) return;
      setError(caught instanceof Error ? caught.message : t('Failed to load statistics'));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [client, provider, refreshKey, t, timeRange]);

  const activityConfig = useMemo(() => ({
    rdRuns: { label: t('RD Runs'), color: 'var(--chart-1)' },
    humanMessages: { label: t('Human inputs'), color: 'var(--chart-2)' },
    maxConcurrentRuns: { label: t('Parallel peak'), color: 'var(--chart-3)' },
  }) satisfies ChartConfig, [t]);
  const requirementConfig = useMemo(() => ({
    humanCreatedRequirements: { label: t('Human-created'), color: 'var(--chart-2)' },
    agentCreatedRequirements: { label: t('Agent-created'), color: 'var(--chart-1)' },
  }) satisfies ChartConfig, [t]);
  const tokenConfig = useMemo(() => ({
    uncachedInputTokens: { label: t('Uncached input'), color: 'var(--chart-2)' },
    cachedInputTokens: { label: t('Cache-hit input'), color: 'var(--chart-1)' },
    cacheCreationInputTokens: { label: t('Cache-write input'), color: 'var(--chart-3)' },
    outputTokens: { label: t('Output'), color: 'var(--chart-4)' },
  }) satisfies ChartConfig, [t]);

  if (loading && !statistics) {
    return <div className="grid min-h-[420px] place-items-center"><LoaderCircle className="size-6 animate-spin text-muted-foreground" /></div>;
  }
  if (error && !statistics) {
    return (
      <div className="p-4 lg:p-6">
        <Alert variant="destructive">
          <ChartNoAxesCombined />
          <AlertTitle>{t('Failed to load statistics')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!statistics) return null;

  const { summary, tokens } = statistics;
  const unsuccessfulRuns = summary.failedRuns + summary.timedOutRuns;
  const agentCreatedRate = summary.requirementsCreated > 0
    ? summary.agentCreatedRequirements / summary.requirementsCreated
    : null;
  const tokenChartData = statistics.byAgent.map((agent) => ({
    name: `${agent.provider === 'codex' ? 'Codex' : 'Claude'} · ${agent.model ?? t('CLI default')}`,
    uncachedInputTokens: Math.max(0, agent.inputTokens - agent.cachedInputTokens - agent.cacheCreationInputTokens),
    cachedInputTokens: agent.cachedInputTokens,
    cacheCreationInputTokens: agent.cacheCreationInputTokens,
    outputTokens: agent.outputTokens,
  }));
  const totalKnownTokens = tokens.inputTokens + tokens.outputTokens;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      {error ? (
        <Alert variant="destructive">
          <ChartNoAxesCombined />
          <AlertTitle>{t('Statistics may be stale')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatisticsMetric
          icon={UsersRound}
          label={t('Maximum parallel RD Sessions')}
          value={String(summary.maxConcurrentRuns)}
          detail={t('{count} running now', { count: summary.activeRuns })}
          tone="bg-sky-500/10 text-sky-600"
        />
        <StatisticsMetric
          icon={MessagesSquare}
          label={t('Runs per human input')}
          value={ratio(summary.runsPerHumanMessage, numberLocale)}
          detail={t('{runs} Runs / {messages} human inputs', { runs: summary.rdRuns, messages: summary.humanMessages })}
          tone="bg-violet-500/10 text-violet-600"
        />
        <StatisticsMetric
          icon={CircleGauge}
          label={t('RD Run success rate')}
          value={percentage(summary.successRate, numberLocale)}
          detail={t('{success} succeeded / {failed} failed', { success: summary.succeededRuns, failed: unsuccessfulRuns })}
          tone="bg-emerald-500/10 text-emerald-600"
        />
        <StatisticsMetric
          icon={Bot}
          label={t('Agent-created requirements')}
          value={percentage(agentCreatedRate, numberLocale)}
          detail={t('{agent} Agent / {human} human', { agent: summary.agentCreatedRequirements, human: summary.humanCreatedRequirements })}
          tone="bg-amber-500/10 text-amber-600"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t('Autonomy trend')}</CardTitle>
            <CardDescription>{t('Compare agent work with the amount of human steering required')}</CardDescription>
          </CardHeader>
          <CardContent>
            {statistics.activity.length === 0 ? <EmptyChart>{t('No activity in this period')}</EmptyChart> : (
              <ChartContainer config={activityConfig} className="h-72 w-full aspect-auto">
                <ComposedChart accessibilityLayer data={statistics.activity} margin={{ left: -18, right: 10 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={28} tickFormatter={(value: string) => value.slice(5)} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="rdRuns" fill="var(--color-rdRuns)" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="humanMessages" fill="var(--color-humanMessages)" radius={[3, 3, 0, 0]} />
                  <Line dataKey="maxConcurrentRuns" type="monotone" stroke="var(--color-maxConcurrentRuns)" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Run outcomes')}</CardTitle>
            <CardDescription>{t('RD execution reliability for the selected period')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-end justify-between">
              <div><span className="text-3xl font-semibold tabular-nums">{summary.rdRuns}</span><span className="ml-2 text-xs text-muted-foreground">{t('RD Runs')}</span></div>
              <Badge variant="secondary">{t('{count} reviews', { count: summary.reviewerRuns })}</Badge>
            </div>
            <div className="flex h-3 overflow-hidden rounded-full bg-muted">
              {summary.rdRuns > 0 ? (
                <>
                  <span className="bg-emerald-500" style={{ width: `${summary.succeededRuns / summary.rdRuns * 100}%` }} />
                  <span className="bg-rose-500" style={{ width: `${summary.failedRuns / summary.rdRuns * 100}%` }} />
                  <span className="bg-amber-500" style={{ width: `${summary.timedOutRuns / summary.rdRuns * 100}%` }} />
                  <span className="bg-slate-400" style={{ width: `${summary.cancelledRuns / summary.rdRuns * 100}%` }} />
                </>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><span className="mr-2 inline-block size-2 rounded-full bg-emerald-500" />{t('Succeeded')} <strong className="float-right tabular-nums">{summary.succeededRuns}</strong></div>
              <div><span className="mr-2 inline-block size-2 rounded-full bg-rose-500" />{t('Failed')} <strong className="float-right tabular-nums">{summary.failedRuns}</strong></div>
              <div><span className="mr-2 inline-block size-2 rounded-full bg-amber-500" />{t('Timed out')} <strong className="float-right tabular-nums">{summary.timedOutRuns}</strong></div>
              <div><span className="mr-2 inline-block size-2 rounded-full bg-slate-400" />{t('Cancelled')} <strong className="float-right tabular-nums">{summary.cancelledRuns}</strong></div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('Token usage by Agent')}</CardTitle>
            <CardDescription>
              {t('{tokens} known tokens across {runs} Runs', { tokens: compactNumber(totalKnownTokens, numberLocale), runs: tokens.runsWithUsage })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tokenChartData.length === 0 || tokens.runsWithUsage === 0 ? <EmptyChart>{t('Token usage will appear after a Provider reports it')}</EmptyChart> : (
              <ChartContainer config={tokenConfig} className="h-72 w-full aspect-auto">
                <BarChart accessibilityLayer data={tokenChartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid horizontal={false} />
                  <YAxis dataKey="name" type="category" tickLine={false} axisLine={false} width={118} tick={{ fontSize: 10 }} />
                  <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(value: number) => compactNumber(value, numberLocale)} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="uncachedInputTokens" stackId="tokens" fill="var(--color-uncachedInputTokens)" />
                  <Bar dataKey="cachedInputTokens" stackId="tokens" fill="var(--color-cachedInputTokens)" />
                  <Bar dataKey="cacheCreationInputTokens" stackId="tokens" fill="var(--color-cacheCreationInputTokens)" />
                  <Bar dataKey="outputTokens" stackId="tokens" fill="var(--color-outputTokens)" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ChartContainer>
            )}
            <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-4 text-center">
              <div><p className="text-lg font-semibold tabular-nums">{compactNumber(tokens.inputTokens, numberLocale)}</p><p className="text-[10px] text-muted-foreground">{t('Input tokens')}</p></div>
              <div><p className="text-lg font-semibold tabular-nums">{percentage(tokens.cacheHitRate, numberLocale)}</p><p className="text-[10px] text-muted-foreground">{t('Cache hit rate')}</p></div>
              <div><p className="text-lg font-semibold tabular-nums">{compactNumber(tokens.outputTokens, numberLocale)}</p><p className="text-[10px] text-muted-foreground">{t('Output tokens')}</p></div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Requirement creation')}</CardTitle>
            <CardDescription>{t('Track how much follow-up work Agents create autonomously')}</CardDescription>
          </CardHeader>
          <CardContent>
            {statistics.activity.length === 0 ? <EmptyChart>{t('No requirements created in this period')}</EmptyChart> : (
              <ChartContainer config={requirementConfig} className="h-72 w-full aspect-auto">
                <BarChart accessibilityLayer data={statistics.activity} margin={{ left: -18, right: 10 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={28} tickFormatter={(value: string) => value.slice(5)} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="humanCreatedRequirements" stackId="requirements" fill="var(--color-humanCreatedRequirements)" />
                  <Bar dataKey="agentCreatedRequirements" stackId="requirements" fill="var(--color-agentCreatedRequirements)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('Agent detail')}</CardTitle>
          <CardDescription>{t('Provider and model totals include RD and Reviewer Runs')}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {statistics.byAgent.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">{t('No Runs in this period')}</p> : (
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="pb-3 font-medium">{t('Agent')}</th>
                  <th className="pb-3 text-right font-medium">{t('RD Runs')}</th>
                  <th className="pb-3 text-right font-medium">{t('Reviews')}</th>
                  <th className="pb-3 text-right font-medium">{t('Success rate')}</th>
                  <th className="pb-3 text-right font-medium">{t('Input tokens')}</th>
                  <th className="pb-3 text-right font-medium">{t('Cache-hit input')}</th>
                  <th className="pb-3 text-right font-medium">{t('Output tokens')}</th>
                </tr>
              </thead>
              <tbody>
                {statistics.byAgent.map((agent) => {
                  const terminal = agent.succeededRuns + agent.failedRuns + agent.timedOutRuns;
                  return (
                    <tr key={`${agent.provider}:${agent.model ?? ''}`} className="border-b border-border/60 last:border-0">
                      <td className="py-3">
                        <div className="flex items-center gap-2"><Cpu className="size-3.5 text-muted-foreground" /><span className="font-medium">{agent.provider === 'codex' ? 'Codex' : 'Claude Code'}</span><span className="text-muted-foreground">{agent.model ?? t('CLI default')}</span></div>
                      </td>
                      <td className="py-3 text-right tabular-nums">{agent.rdRuns}</td>
                      <td className="py-3 text-right tabular-nums">{agent.reviewerRuns}</td>
                      <td className="py-3 text-right tabular-nums">{percentage(terminal > 0 ? agent.succeededRuns / terminal : null, numberLocale)}</td>
                      <td className="py-3 text-right tabular-nums">{compactNumber(agent.inputTokens, numberLocale)}</td>
                      <td className="py-3 text-right tabular-nums">{compactNumber(agent.cachedInputTokens, numberLocale)}</td>
                      <td className="py-3 text-right tabular-nums">{compactNumber(agent.outputTokens, numberLocale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
