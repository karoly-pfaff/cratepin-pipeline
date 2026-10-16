import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { generationLayoutOf } from '../generation/generation-layout.ts';
import type { GenerationLayout } from '../generation/generation-layout.ts';
import { readActiveGeneration, switchManifest } from './manifest-switch.ts';
import { NODE_PUBLICATION_FILE_SYSTEM } from '../publication/publication-files.ts';
import {
  blockingFirst,
  blockingRenamesFrom,
  faultyFileSystem,
  refusedBecause,
} from '../publication/publication-fixtures.test-support.ts';

const DIGEST = 'a'.repeat(64);
const OWNER = { projectId: 'demo', outputMode: 'generation' } as const;
const HEADER = { schemaVersion: 1, projectId: 'demo', outputMode: 'generation' };

async function withRoot(useLayout: (layout: GenerationLayout) => Promise<void>): Promise<void> {
  await withWorkspace(async (workspace) => {
    const layout = generationLayoutOf(join(workspace, 'assets'));
    await mkdir(layout.root);
    await useLayout(layout);
  });
}

test('the active generation is the one the manifest names; a damaged manifest names none', async () => {
  await withRoot(async (layout) => {
    assert.deepEqual(await readActiveGeneration(layout, OWNER), { state: 'absent' });
    const text = `${JSON.stringify({ ...HEADER, generation: DIGEST, assets: {} })}\n`;
    await writeFile(layout.manifest, text);
    assert.deepEqual(await readActiveGeneration(layout, OWNER), {
      state: 'present',
      generation: DIGEST,
      text,
    });
    const withoutAssets = JSON.stringify({ ...HEADER, generation: DIGEST });
    const otherProject = JSON.stringify({
      ...HEADER,
      projectId: 'other',
      generation: DIGEST,
      assets: {},
    });
    for (const damaged of [
      '{',
      JSON.stringify({ ...HEADER, generation: 'short', assets: {} }),
      '[]',
      withoutAssets,
      otherProject,
    ]) {
      await writeFile(layout.manifest, damaged);
      assert.deepEqual(await readActiveGeneration(layout, OWNER), { state: 'unreadable' }, damaged);
    }
  });
});

test('a switch replaces the manifest in one step, retrying while a reader holds it', async () => {
  await withRoot(async (layout) => {
    await writeFile(layout.manifest, 'old');
    const { fileSystem, operations } = faultyFileSystem(blockingFirst(2));
    await switchManifest(fileSystem, layout, 'new');
    assert.equal(await readFile(layout.manifest, 'utf8'), 'new');
    assert.equal(operations.length, 3, 'two blocked tries, then the rename');
    assert.deepEqual(await readdir(layout.root), ['cratepin-manifest.json']);
  });
});

test('a manifest held open for good stays as it was, and the temporary file goes', async () => {
  await withRoot(async (layout) => {
    await writeFile(layout.manifest, 'old');
    const { fileSystem } = faultyFileSystem(blockingRenamesFrom('.tmp'));
    await assert.rejects(
      switchManifest(fileSystem, layout, 'new'),
      refusedBecause('OUTPUT_IN_USE', { details: { path: layout.manifest } }),
    );
    assert.equal(await readFile(layout.manifest, 'utf8'), 'old');
    assert.deepEqual(await readdir(layout.root), ['cratepin-manifest.json']);
  });
});

test('the first switch creates the manifest', async () => {
  await withRoot(async (layout) => {
    await switchManifest(NODE_PUBLICATION_FILE_SYSTEM, layout, 'first');
    assert.equal(await readFile(layout.manifest, 'utf8'), 'first');
  });
});
