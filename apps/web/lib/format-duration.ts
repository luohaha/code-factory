import type { TranslationKey } from '@/locales/zh-CN';

type Translate = (key: TranslationKey, values?: Record<string, number | string>) => string;

const units = [
  { seconds: 86_400, singular: '1 day', plural: '{count} days' },
  { seconds: 3_600, singular: '1 hour', plural: '{count} hours' },
  { seconds: 60, singular: '1 minute', plural: '{count} minutes' },
  { seconds: 1, singular: '1 second', plural: '{count} seconds' },
] as const satisfies ReadonlyArray<{
  seconds: number;
  singular: TranslationKey;
  plural: TranslationKey;
}>;

export function formatDuration(seconds: number, t: Translate): string {
  let remaining = Math.max(0, Math.floor(seconds));
  const parts: string[] = [];

  for (const unit of units) {
    const count = Math.floor(remaining / unit.seconds);
    if (count === 0) continue;
    parts.push(count === 1 ? t(unit.singular) : t(unit.plural, { count }));
    remaining %= unit.seconds;
  }

  return parts.length > 0 ? parts.join(' ') : t('{count} seconds', { count: 0 });
}
