import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';

import { checkedProjectIn } from '../catalog/source-fixtures.test-support.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { loadCommittedLock } from './lock-file.ts';

const OVERSIZED_ISSUE = {
  path: '/',
  code: 'LOCK_INVALID',
  message: 'Larger than 64 MiB; not a lock this tool wrote',
};

test('a lock larger than 64 MiB is invalid at its root and never parsed', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    const emptyLock = '{"schemaVersion":1,"projectId":"demo","assets":[]';
    await writeFile(project.paths.lockFilePath, `${emptyLock}${' '.repeat(64 * 1024 * 1024)}}`);
    const load = await loadCommittedLock(project);
    assert.deepEqual(load, { status: 'invalid', issues: [OVERSIZED_ISSUE] });
  });
});

test('a lock within the limit is read and validated as usual', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    await writeFile(
      project.paths.lockFilePath,
      '{"schemaVersion":1,"projectId":"demo","assets":[]}',
    );
    assert.equal((await loadCommittedLock(project)).status, 'valid');
  });
});
