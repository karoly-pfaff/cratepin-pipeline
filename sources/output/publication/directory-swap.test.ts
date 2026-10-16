import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import test from 'node:test';

import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { swapInStaging } from './directory-swap.ts';
import {
  blockingRenamesFrom,
  faultyFileSystem,
  failingNone,
  noticeCodesOf,
  refusedBecause,
  TEST_OWNER,
  writeOwnedTree,
} from './publication-fixtures.test-support.ts';
import type { FailurePlan } from './publication-fixtures.test-support.ts';
import { workDirectoryOf } from '../layout/work-directory.ts';
import type { WorkDirectory } from '../layout/work-directory.ts';

/** An owned root holding `old.txt` and a staging holding `new.txt`, side by side. */
async function withSwapReady(useWork: (work: WorkDirectory) => Promise<void>): Promise<void> {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'public'));
    const work = workDirectoryOf(join(workspace, 'public', 'assets'));
    await writeOwnedTree(work.root, { 'old.txt': 'old' });
    await writeOwnedTree(work.staging, { 'new.txt': 'new' });
    await useWork(work);
  });
}

function swapWith(work: WorkDirectory, plan: FailurePlan) {
  const { fileSystem } = faultyFileSystem(plan);
  return swapInStaging({ fileSystem, work, owner: TEST_OWNER });
}

test('a swap puts the staging in place and removes the old root through the trash', async () => {
  await withSwapReady(async (work) => {
    const result = await swapWith(work, failingNone());
    assert.equal(await readFile(join(work.root, 'new.txt'), 'utf8'), 'new');
    assert.deepEqual(result.notices, []);
    assert.equal(result.cleanup.removedFileCount, 4, 'old.txt, marker, manifest, listing');
    assert.deepEqual(await readdir(work.trash), []);
  });
});

test('a root held open stays in place; nothing changes', async () => {
  await withSwapReady(async (work) => {
    await assert.rejects(
      swapWith(work, blockingRenamesFrom('assets')),
      refusedBecause('OUTPUT_IN_USE'),
    );
    assert.equal(await readFile(join(work.root, 'old.txt'), 'utf8'), 'old');
    assert.deepEqual(await readdir(work.directory), ['staging']);
  });
});

test('a staging that cannot move in puts the old root back', async () => {
  await withSwapReady(async (work) => {
    await assert.rejects(
      swapWith(work, blockingRenamesFrom('staging')),
      refusedBecause('OUTPUT_IN_USE', { messagePart: 'restored' }),
    );
    assert.equal(await readFile(join(work.root, 'old.txt'), 'utf8'), 'old');
  });
});

/** Fails the first rename with a local error that has nothing to do with an open file. */
const failingFirstRenameWithEio: FailurePlan = ({ name }, index) =>
  name === 'rename' && index === 0 ? Object.assign(new Error('disk'), { code: 'EIO' }) : undefined;

test('a rename failing for another reason is reported as that, not as an open file', async () => {
  await withSwapReady(async (work) => {
    await assert.rejects(swapWith(work, failingFirstRenameWithEio), {
      code: 'IO_FAILED',
      details: { systemCode: 'EIO', path: work.root },
    });
    assert.equal(await readFile(join(work.root, 'old.txt'), 'utf8'), 'old');
  });
});

test('when the old root cannot go back either, the error names the backup the next build restores', async () => {
  const blockingBothWays: FailurePlan = ({ name, paths }) =>
    name === 'rename' && !(paths[0] ?? '').endsWith('assets')
      ? Object.assign(new Error('blocked'), { code: 'EPERM' })
      : undefined;
  await withSwapReady(async (work) => {
    await assert.rejects(
      swapWith(work, blockingBothWays),
      refusedBecause('SWAP_INCOMPLETE', { details: { backupDir: work.backup } }),
    );
    assert.equal(await readFile(join(work.backup, 'old.txt'), 'utf8'), 'old');
  });
});

test('a backup that cannot go to the trash is kept with a notice; the new root is in place', async () => {
  await withSwapReady(async (work) => {
    const result = await swapWith(work, blockingRenamesFrom('backup'));
    assert.equal(await readFile(join(work.root, 'new.txt'), 'utf8'), 'new');
    assert.deepEqual(noticeCodesOf(result), ['BACKUP_KEPT']);
  });
});

test('a leftover backup from an earlier swap stops a new one before anything moves', async () => {
  await withSwapReady(async (work) => {
    await mkdir(work.backup);
    await assert.rejects(swapWith(work, failingNone()), refusedBecause('INTERRUPTED_SWAP_UNCLEAR'));
    assert.equal(await readFile(join(work.root, 'old.txt'), 'utf8'), 'old');
  });
});

function noticePathsOf(result: { readonly notices: readonly { path: string }[] }): string[] {
  return result.notices.map(({ path }) => path);
}

/** The trash directory the old root went to, from the first kept path in it. */
function trashedRootOf(
  work: WorkDirectory,
  result: { readonly notices: readonly { path: string }[] },
): string {
  const first = noticePathsOf(result)[0] ?? '';
  const name = first.slice(work.trash.length + 1).split(sep)[0] ?? '';
  return join(work.trash, name);
}

test('an old file changed after publishing stays in the trash, and the swap says so', async () => {
  await withSwapReady(async (work) => {
    await writeFile(join(work.root, 'old.txt'), 'edited by hand');
    const result = await swapWith(work, failingNone());
    assert.equal(await readFile(join(work.root, 'new.txt'), 'utf8'), 'new');
    assert.deepEqual(new Set(noticeCodesOf(result)), new Set(['OUTPUT_TRASH_KEPT']));
    assert.ok(noticePathsOf(result).includes(join(trashedRootOf(work, result), 'old.txt')));
  });
});
