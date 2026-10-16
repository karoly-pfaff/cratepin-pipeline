import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { trashPathOf, workDirectoryOf } from './work-directory.ts';

test('the work directory is a hidden sibling of the output root, on the same volume', () => {
  const root = join('game', 'public', 'assets');
  const work = workDirectoryOf(root);
  assert.equal(work.root, root);
  assert.equal(work.directory, join('game', 'public', '.assets.cratepin'));
  assert.equal(dirname(work.directory), dirname(root));
  assert.deepEqual(
    [work.staging, work.backup, work.trash].map((path) => dirname(path)),
    [work.directory, work.directory, work.directory],
  );
});

test('every old tree gets its own place in the trash', () => {
  const work = workDirectoryOf(join('public', 'assets'));
  const first = trashPathOf(work);
  assert.equal(dirname(first), work.trash);
  assert.notEqual(trashPathOf(work), first);
});
