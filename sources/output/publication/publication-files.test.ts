import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import {
  blockingAll,
  blockingFirst,
  failingNone,
  faultyFileSystem,
} from './publication-fixtures.test-support.ts';
import { renameWithRetry } from './publication-files.ts';

test('a rename blocked for a moment by an open file is tried again and succeeds', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'from'));
    const { fileSystem, operations } = faultyFileSystem(blockingFirst(3));
    await renameWithRetry(fileSystem, join(workspace, 'from'), join(workspace, 'to'));
    assert.equal(operations.length, 4);
    assert.deepEqual(await readdir(workspace), ['to']);
  });
});

test('a rename that stays blocked gives up after its retries with the last error', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'from'));
    const { fileSystem, operations } = faultyFileSystem(blockingAll());
    await assert.rejects(
      renameWithRetry(fileSystem, join(workspace, 'from'), join(workspace, 'to')),
      { code: 'EPERM' },
    );
    assert.equal(operations.length, 7, 'the first try, six retries');
    assert.deepEqual(await readdir(workspace), ['from']);
  });
});

test('a rename is never retried once its target exists, nor for other errors', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'from'));
    await writeFile(join(workspace, 'to'), 'someone else');
    const blocked = faultyFileSystem(blockingAll());
    await assert.rejects(
      renameWithRetry(blocked.fileSystem, join(workspace, 'from'), join(workspace, 'to')),
    );
    assert.equal(blocked.operations.length, 1);
    const missing = faultyFileSystem(failingNone());
    await assert.rejects(
      renameWithRetry(missing.fileSystem, join(workspace, 'missing'), join(workspace, 'x')),
      { code: 'ENOENT' },
    );
    assert.equal(missing.operations.length, 1);
  });
});
