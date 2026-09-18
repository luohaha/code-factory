import assert from 'node:assert/strict';
import test from 'node:test';

import type { TranslationKey } from '../locales/zh-CN.ts';
import { formatDuration } from './format-duration.ts';

function translate(key: TranslationKey, values?: Record<string, number | string>): string {
  return key.replace(/\{(\w+)\}/g, (match, name: string) => (
    values && Object.hasOwn(values, name) ? String(values[name]) : match
  ));
}

void test('formatDuration preserves second precision with composite units', () => {
  assert.equal(formatDuration(60, translate), '1 minute');
  assert.equal(formatDuration(61, translate), '1 minute 1 second');
  assert.equal(formatDuration(3_661, translate), '1 hour 1 minute 1 second');
  assert.equal(formatDuration(90_061, translate), '1 day 1 hour 1 minute 1 second');
});
