import assert from 'node:assert/strict';
import test from 'node:test';

import { searchExcerpt } from '../src/search.ts';

test('search excerpts anchor to the earliest matched term when the complete phrase is absent', () => {
  const body = `${'Unrelated introduction. '.repeat(16)}The database worker eventually reported a deadlock during retry.`;

  const excerpt = searchExcerpt(body, 'database deadlock', 100);

  assert.ok(excerpt.startsWith('…'));
  assert.match(excerpt, /database/);
  assert.match(excerpt, /deadlock/);
});
