import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from './pipeline-config.ts';

test('every default config is an independent copy', () => {
  const callerCopy = defaultConfig();
  (callerCopy.limits as { concurrency: number }).concurrency = 1;
  (callerCopy.sources.include as string[]).push('**/*.wav');
  assert.equal(defaultConfig().limits.concurrency, 4);
  assert.ok(!defaultConfig().sources.include.includes('**/*.wav'));
});
