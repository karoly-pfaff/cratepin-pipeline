import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { linkDirectory, withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { NODE_PUBLICATION_FILE_SYSTEM } from './publication-files.ts';
import {
  blockingRenamesFrom,
  faultyFileSystem,
  noticeCodesOf,
  refusedBecause,
  TEST_OWNER,
  writeOwnedTree,
} from './publication-fixtures.test-support.ts';
import { recoverWorkDirectory } from './swap-recovery.ts';
import { workDirectoryOf } from '../layout/work-directory.ts';
import type { WorkDirectory } from '../layout/work-directory.ts';

async function withWork(useWork: (work: WorkDirectory) => Promise<void>): Promise<void> {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'public'));
    await useWork(workDirectoryOf(join(workspace, 'public', 'assets')));
  });
}

function recover(work: WorkDirectory, fileSystem = NODE_PUBLICATION_FILE_SYSTEM) {
  return recoverWorkDirectory({ fileSystem, work, owner: TEST_OWNER });
}

test('without a work directory there is nothing to recover', async () => {
  await withWork(async (work) => {
    assert.deepEqual(await recover(work), { outcome: 'none', notices: [], removedFileCount: 0 });
  });
});

test('a swap stopped after moving the root aside is rolled back', async () => {
  await withWork(async (work) => {
    await writeOwnedTree(work.backup, { 'old.txt': 'old' });
    const result = await recover(work);
    assert.equal(result.outcome, 'rolled-back');
    assert.deepEqual(noticeCodesOf(result), ['SWAP_ROLLED_BACK']);
    assert.equal(await readFile(join(work.root, 'old.txt'), 'utf8'), 'old');
    await assert.rejects(readdir(work.directory), { code: 'ENOENT' }, 'the work directory is gone');
  });
});

test('a swap stopped after the new root moved in is completed and its backup removed through the trash', async () => {
  await withWork(async (work) => {
    await writeOwnedTree(work.root, { 'new.mp3': 'new' });
    await writeOwnedTree(work.backup, { 'old.txt': 'old' });
    const result = await recover(work);
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(noticeCodesOf(result), ['SWAP_COMPLETED']);
    assert.equal(result.removedFileCount, 4);
    assert.equal(await readFile(join(work.root, 'new.mp3'), 'utf8'), 'new');
    await assert.rejects(readdir(work.directory), { code: 'ENOENT' });
  });
});

test('a backup next to a root that is not a clean owned output is refused untouched', async () => {
  await withWork(async (work) => {
    await writeOwnedTree(work.root, { 'new.mp3': 'new' });
    await writeFile(join(work.root, 'notes.txt'), 'mine');
    await writeOwnedTree(work.backup, { 'old.txt': 'old' });
    await assert.rejects(recover(work), refusedBecause('INTERRUPTED_SWAP_UNCLEAR'));
    assert.equal(await readFile(join(work.backup, 'old.txt'), 'utf8'), 'old');
    assert.equal(await readFile(join(work.root, 'notes.txt'), 'utf8'), 'mine');
  });
});

test('a backup that is a file, or a work directory that is a file, is refused', async () => {
  await withWork(async (work) => {
    await writeFile(work.directory, 'not a directory');
    await assert.rejects(recover(work), { name: 'PipelineError' });
  });
  await withWork(async (work) => {
    await mkdir(work.directory);
    await writeFile(work.backup, 'not a directory');
    await assert.rejects(recover(work), { name: 'PipelineError' });
  });
});

test('a crashed build leaves staging and trash that recovery removes, keeping what it did not write', async () => {
  await withWork(async (work) => {
    await mkdir(join(work.staging, 'images'), { recursive: true });
    await writeFile(join(work.staging, 'images', 'partial.png'), 'half');
    const trashed = await writeOwnedTree(join(work.trash, 'one'), { 'old.txt': 'old' });
    await writeFile(join(trashed, 'notes.txt'), 'mine');
    const result = await recover(work);
    assert.equal(result.outcome, 'none');
    assert.equal(result.removedFileCount, 1 + 4);
    assert.deepEqual(noticeCodesOf(result), ['OUTPUT_TRASH_KEPT']);
    assert.deepEqual(result.notices[0]?.path, join(trashed, 'notes.txt'));
    assert.deepEqual(await readdir(work.directory), ['trash']);
  });
});

test('an empty root someone recreated next to the backup is not a committed swap: it is rolled back', async () => {
  await withWork(async (work) => {
    await writeOwnedTree(work.backup, { 'old.txt': 'old' });
    await mkdir(work.root);
    const result = await recover(work);
    assert.equal(result.outcome, 'rolled-back');
    assert.equal(await readFile(join(work.root, 'old.txt'), 'utf8'), 'old');
  });
});

test('a backup next to an owned root without a readable listing is refused untouched', async () => {
  await withWork(async (work) => {
    await writeOwnedTree(work.root, { 'new.mp3': 'new' });
    await writeFile(join(work.root, '.cratepin-generation.json'), 'damaged');
    await writeOwnedTree(work.backup, { 'old.txt': 'old' });
    await assert.rejects(recover(work), refusedBecause('INTERRUPTED_SWAP_UNCLEAR'));
    assert.equal(await readFile(join(work.backup, 'old.txt'), 'utf8'), 'old');
  });
});

test('a backup held open is named as in use and stays where it is', async () => {
  await withWork(async (work) => {
    await writeOwnedTree(work.backup, { 'old.txt': 'old' });
    const { fileSystem } = faultyFileSystem(blockingRenamesFrom('backup'));
    await assert.rejects(
      recover(work, fileSystem),
      refusedBecause('OUTPUT_IN_USE', { details: { path: work.backup } }),
    );
    assert.equal(await readFile(join(work.backup, 'old.txt'), 'utf8'), 'old');
  });
});

test('a link in the trash is kept and nothing is removed through it', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'public'));
    const work = workDirectoryOf(join(workspace, 'public', 'assets'));
    const elsewhere = await writeOwnedTree(join(workspace, 'elsewhere'), { 'keep.txt': 'keep' });
    await mkdir(work.trash, { recursive: true });
    await linkDirectory(elsewhere, join(work.trash, 'linked'));
    const result = await recover(work);
    assert.deepEqual(noticeCodesOf(result), ['OUTPUT_TRASH_KEPT']);
    assert.equal(result.removedFileCount, 0);
    assert.equal(await readFile(join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
  });
});

test('a backup next to an owned root whose listed bytes are damaged is refused untouched', async () => {
  await withWork(async (work) => {
    await writeOwnedTree(work.root, { 'new.mp3': 'new', 'other.mp3': 'other' });
    await writeFile(join(work.root, 'new.mp3'), 'ne');
    await writeOwnedTree(work.backup, { 'old.txt': 'old' });
    await assert.rejects(recover(work), refusedBecause('INTERRUPTED_SWAP_UNCLEAR'));
    assert.equal(await readFile(join(work.backup, 'old.txt'), 'utf8'), 'old');
  });
});
