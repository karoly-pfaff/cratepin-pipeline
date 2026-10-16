import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { checkedProjectIn, sha256Of } from '../catalog/source-fixtures.test-support.ts';
import { PipelineError } from '../errors.ts';
import { FinalizedLock } from '../lock/lock-finalization.ts';
import { objectKeyFor, serializeLock } from '../lock/source-lock.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { writeFinalizedLock } from './lock-writer.ts';

const NAMESPACE = { objectPrefix: 'cratepin/v1', projectId: 'demo' };

function lockWith(...ids: string[]): SourceLock {
  const assets = ids.map((id) => {
    const sha256 = sha256Of(id);
    const objectKey = objectKeyFor(NAMESPACE, sha256);
    return {
      id,
      source: `${id}.png`,
      sha256,
      bytes: 1,
      mediaType: 'image/png',
      category: 'image' as const,
      objectKey,
    };
  });
  return { schemaVersion: 1, projectId: 'demo', assets };
}

/** Finalized with its own records as evidence; the evidence rules are tested elsewhere. */
function finalized(lock: SourceLock): FinalizedLock {
  return FinalizedLock.fromVerifiedObjects(lock, lock.assets);
}

function isConflict(error: unknown): boolean {
  return error instanceof PipelineError && error.code === 'OUTPUT_CONFLICT';
}

async function temporaryFilesIn(workspace: string): Promise<string[]> {
  return (await readdir(workspace)).filter((name) => name.endsWith('.tmp'));
}

async function withProject(
  useProject: (project: CheckedProject, workspace: string) => Promise<void>,
): Promise<void> {
  await withWorkspace(async (workspace) => {
    await useProject(await checkedProjectIn(workspace), workspace);
  });
}

test('a new lock is written in one step and the content matches', async () => {
  await withProject(async (project, workspace) => {
    assert.equal(await writeFinalizedLock(project, finalized(lockWith('a')), undefined), true);
    assert.equal(await readFile(project.paths.lockFilePath, 'utf8'), serializeLock(lockWith('a')));
    assert.deepEqual(await temporaryFilesIn(workspace), []);
  });
});

test('an identical lock is not rewritten', async () => {
  await withProject(async (project) => {
    await writeFile(project.paths.lockFilePath, serializeLock(lockWith('a')));
    const before = (await stat(project.paths.lockFilePath)).mtimeMs;
    assert.equal(await writeFinalizedLock(project, finalized(lockWith('a')), lockWith('a')), false);
    assert.equal((await stat(project.paths.lockFilePath)).mtimeMs, before);
  });
});

test('a lock changed since the push started is not overwritten', async () => {
  await withProject(async (project) => {
    await writeFile(project.paths.lockFilePath, serializeLock(lockWith('a', 'pulled')));
    await assert.rejects(
      writeFinalizedLock(project, finalized(lockWith('a', 'b')), lockWith('a')),
      isConflict,
    );
    await assert.rejects(
      writeFinalizedLock(project, finalized(lockWith('b')), undefined),
      isConflict,
    );
    assert.equal(
      await readFile(project.paths.lockFilePath, 'utf8'),
      serializeLock(lockWith('a', 'pulled')),
    );
  });
});

test('a layout that changed since the preflight stops the write before any file is created', async () => {
  await withProject(async (project, workspace) => {
    await mkdir(project.paths.lockFilePath);
    await assert.rejects(
      writeFinalizedLock(project, finalized(lockWith('a')), undefined),
      isConflict,
    );
    assert.deepEqual(await temporaryFilesIn(workspace), []);
    await rm(project.paths.lockFilePath, { recursive: true });
  });
});

test('temporary files an interrupted write left are removed; other files stay', async () => {
  await withProject(async (project, workspace) => {
    const stale = `${project.paths.lockFilePath}.0123abcd-0123-4abc-8def-0123456789ab.tmp`;
    const unrelated = join(workspace, 'notes.tmp');
    const lookalike = `${project.paths.lockFilePath}.notes.tmp`;
    await writeFile(stale, 'half written');
    await writeFile(unrelated, 'not ours');
    await writeFile(lookalike, 'not ours either');
    await writeFinalizedLock(project, finalized(lockWith('a')), undefined);
    assert.deepEqual(await temporaryFilesIn(workspace), [
      'cratepin-lock.json.notes.tmp',
      'notes.tmp',
    ]);
  });
});
