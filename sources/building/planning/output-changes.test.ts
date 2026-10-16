import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizedPolicyOf } from '../../media/policies/transform-policy.ts';
import { lockOfOriginals } from '../build-fixtures.test-support.ts';
import { certainOutputsOf, extensionChangesOf, outputChangesOf } from './output-changes.ts';

const LOCK = lockOfOriginals([
  { source: 'app/cat.png', bytes: Buffer.from('cat') },
  { source: 'app/dog.png', bytes: Buffer.from('dog') },
]);
const [CAT, DOG] = LOCK.assets;

function plannedOf(paths: readonly (readonly string[])[]) {
  const records = [CAT, DOG].flatMap((record) => (record === undefined ? [] : [record]));
  return records.map((record, index) => ({
    record,
    profile: {
      name: 'copy',
      from: 'default' as const,
      policy: normalizedPolicyOf({ kind: 'copy' }),
    },
    possiblePaths: paths[index] ?? [],
  }));
}

test('only a single possible path is certain before conversion; a flexible one is pending', () => {
  const planned = plannedOf([['app/cat.webp'], ['app/dog.png', 'app/dog.webp']]);
  assert.deepEqual(
    certainOutputsOf(planned, []).map(({ outputPath }) => outputPath),
    ['app/cat.webp'],
  );
  assert.deepEqual(
    extensionChangesOf(certainOutputsOf(planned, [])).map(({ id, fromExtension, toExtension }) => [
      id,
      fromExtension,
      toExtension,
    ]),
    [['app/cat', 'png', 'webp']],
  );
});

test('without a readable published manifest every ID counts as added and none as changed', () => {
  const lockIds = LOCK.assets.map(({ id }) => id);
  for (const published of [{ state: 'absent' as const }, { state: 'unreadable' as const }]) {
    assert.deepEqual(outputChangesOf(lockIds, [], { published }), {
      addedIds: ['app/cat', 'app/dog'],
      removedIds: [],
      changedIds: [],
    });
  }
});
