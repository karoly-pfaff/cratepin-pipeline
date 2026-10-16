import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { linkDirectory, withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { generationLayoutOf } from './generation-layout.ts';
import type { GenerationLayout } from './generation-layout.ts';
import { recoverGenerationRoot } from './generation-recovery.ts';
import { OUTPUT_MARKER_NAME, outputMarkerTextOf } from '../ownership/output-marker.ts';
import type { OutputOwner } from '../ownership/output-marker.ts';
import { NODE_PUBLICATION_FILE_SYSTEM } from '../publication/publication-files.ts';
import {
  noticeCodesOf,
  writeListedTree,
} from '../publication/publication-fixtures.test-support.ts';

const OWNER: OutputOwner = { projectId: 'demo', outputMode: 'generation' };

/** A generation-mode root marked for `marker`'s project and mode, and the workspace around it. */
async function withRoot(
  marker: OutputOwner,
  useRoot: (layout: GenerationLayout, workspace: string) => Promise<void>,
): Promise<void> {
  await withWorkspace(async (workspace) => {
    const layout = generationLayoutOf(join(workspace, 'assets'));
    await mkdir(layout.root);
    await writeFile(join(layout.root, OUTPUT_MARKER_NAME), outputMarkerTextOf(marker));
    await useRoot(layout, workspace);
  });
}

function recover(layout: GenerationLayout) {
  return recoverGenerationRoot(NODE_PUBLICATION_FILE_SYSTEM, layout, OWNER);
}

/** A half-written staging file and a listed old generation in the trash, below `generations`. */
async function writeLeftovers(generations: string): Promise<void> {
  await mkdir(join(generations, '.staging', 'app'), { recursive: true });
  await writeFile(join(generations, '.staging', 'app', 'half.png'), 'half');
  await writeListedTree(join(generations, '.trash', 'old'), { 'a.txt': 'a' });
}

test('without a root there is nothing to recover', async () => {
  await withWorkspace(async (workspace) => {
    const layout = generationLayoutOf(join(workspace, 'assets'));
    assert.deepEqual(await recover(layout), { outcome: 'none', notices: [], removedFileCount: 0 });
  });
});

test('a staging, an unswitched manifest and old trash are removed; generations are not', async () => {
  await withRoot(OWNER, async (layout) => {
    await writeLeftovers(layout.generations);
    await writeFile(layout.manifestInProgress, '{"half":');
    await writeListedTree(join(layout.generations, '0123456789abcdef'), { 'b.txt': 'b' });
    const result = await recover(layout);
    assert.deepEqual([result.outcome, result.notices], ['none', []]);
    assert.equal(result.removedFileCount, 1 + 1 + 2, 'staging file, manifest, file and listing');
    assert.deepEqual(await readdir(layout.generations), ['0123456789abcdef']);
    assert.ok(!(await readdir(layout.root)).includes('.cratepin-manifest.json.tmp'));
  });
});

test('a directory where the temporary manifest belongs is kept and reported', async () => {
  await withRoot(OWNER, async (layout) => {
    await mkdir(layout.manifestInProgress);
    const result = await recover(layout);
    assert.deepEqual(noticeCodesOf(result), ['OUTPUT_TRASH_KEPT']);
    assert.ok((await readdir(layout.root)).includes('.cratepin-manifest.json.tmp'));
  });
});

test('a root of another project or mode is left as it is', async () => {
  for (const marker of [
    { projectId: 'other', outputMode: 'generation' },
    { projectId: 'demo', outputMode: 'path-preserving' },
  ] as const) {
    await withRoot(marker, async (layout) => {
      await writeLeftovers(layout.generations);
      assert.equal((await recover(layout)).removedFileCount, 0);
      assert.deepEqual(await readdir(join(layout.staging, 'app')), ['half.png']);
    });
  }
});

test('nothing is removed through a link where generations belongs', async () => {
  await withRoot(OWNER, async (layout, workspace) => {
    const elsewhere = join(workspace, 'elsewhere');
    await writeLeftovers(elsewhere);
    await linkDirectory(elsewhere, layout.generations);
    assert.equal((await recover(layout)).removedFileCount, 0);
    assert.deepEqual(await readdir(join(elsewhere, '.staging', 'app')), ['half.png']);
    assert.deepEqual(await readdir(join(elsewhere, '.trash', 'old')), [
      '.cratepin-generation.json',
      'a.txt',
    ]);
  });
});

test('in a trashed generation only its listing counts as a tool file', async () => {
  await withRoot(OWNER, async (layout) => {
    const trashed = await writeListedTree(join(layout.trash, 'old'), { 'a.txt': 'a' });
    await writeFile(join(trashed, 'cratepin-manifest.json'), 'not written by the tool');
    await writeFile(join(trashed, OUTPUT_MARKER_NAME), 'nor this');
    const result = await recover(layout);
    assert.equal(result.removedFileCount, 2, 'a.txt and the listing');
    assert.deepEqual((await readdir(trashed)).toSorted(compareCodeUnits), [
      '.cratepin-output.json',
      'cratepin-manifest.json',
    ]);
  });
});
