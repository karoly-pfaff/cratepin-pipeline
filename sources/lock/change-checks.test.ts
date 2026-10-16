import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Of } from '../catalog/source-fixtures.test-support.ts';
import { sourcesMissingIssues } from './change-checks.ts';
import { objectKeyFor } from './source-lock.ts';
import type { SourceLock } from './source-lock.ts';

const NAMESPACE = { objectPrefix: 'cratepin/v1', projectId: 'demo' };

function lockWith(count: number): SourceLock {
  const assets = Array.from({ length: count }, (_, index) => {
    const sha256 = sha256Of(String(index));
    return {
      id: `a${String(index)}`,
      source: `a${String(index)}.png`,
      sha256,
      bytes: 1,
      mediaType: 'image/png',
      category: 'image' as const,
      objectKey: objectKeyFor(NAMESPACE, sha256),
    };
  });
  return { schemaVersion: 1, projectId: 'demo', assets };
}

test('only an empty catalog next to a non-empty lock counts as missing sources', () => {
  assert.deepEqual(
    sourcesMissingIssues(lockWith(2), 0).map((issue) => `${issue.code} ${issue.path}`),
    ['SOURCES_MISSING .'],
  );
  assert.match(sourcesMissingIssues(lockWith(2), 0)[0]?.message ?? '', /lists 2 originals/);
  assert.deepEqual(sourcesMissingIssues(lockWith(2), 1), []);
  assert.deepEqual(sourcesMissingIssues(lockWith(0), 0), []);
  assert.deepEqual(sourcesMissingIssues(undefined, 0), []);
});
