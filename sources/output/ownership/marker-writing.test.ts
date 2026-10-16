import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { generationLayoutOf } from '../generation/generation-layout.ts';
import { ownGenerationRoot, unknownNameNotices } from '../generation/generation-root.ts';
import { classifyOutputRoot, OUTPUT_MARKER_NAME, outputMarkerTextOf } from './output-marker.ts';
import type { OutputOwner } from './output-marker.ts';
import { NODE_PUBLICATION_FILE_SYSTEM } from '../publication/publication-files.ts';

const OWNER: OutputOwner = { projectId: 'demo', outputMode: 'generation' };
const HALF_WRITTEN = `${OUTPUT_MARKER_NAME}.0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.tmp`;
const LOOK_ALIKE = `${OUTPUT_MARKER_NAME}.tmp`;

async function namesIn(directory: string): Promise<string[]> {
  return (await readdir(directory)).toSorted(compareCodeUnits);
}

test('a root holding only a half-written marker is empty: it is adopted and the leftover removed', async () => {
  await withWorkspace(async (workspace) => {
    const layout = generationLayoutOf(join(workspace, 'assets'));
    await mkdir(layout.root);
    await writeFile(join(layout.root, HALF_WRITTEN), '{"schem');
    assert.equal((await classifyOutputRoot(layout.root, OWNER)).state, 'empty');
    await ownGenerationRoot(NODE_PUBLICATION_FILE_SYSTEM, layout, OWNER);
    assert.deepEqual(await namesIn(layout.root), [OUTPUT_MARKER_NAME, 'generations']);
    const marker = await readFile(join(layout.root, OUTPUT_MARKER_NAME), 'utf8');
    assert.equal(marker, outputMarkerTextOf(OWNER));
  });
});

test('an owned root loses half-written markers; a look-alike name stays and is reported', async () => {
  await withWorkspace(async (workspace) => {
    const layout = generationLayoutOf(join(workspace, 'assets'));
    await mkdir(layout.root);
    await writeFile(join(layout.root, OUTPUT_MARKER_NAME), outputMarkerTextOf(OWNER));
    await writeFile(join(layout.root, HALF_WRITTEN), '{"schem');
    await writeFile(join(layout.root, LOOK_ALIKE), 'mine');
    await ownGenerationRoot(NODE_PUBLICATION_FILE_SYSTEM, layout, OWNER);
    assert.deepEqual(await namesIn(layout.root), [OUTPUT_MARKER_NAME, LOOK_ALIKE, 'generations']);
    const [notice, ...others] = await unknownNameNotices(layout);
    assert.equal(notice?.path, join(layout.root, LOOK_ALIKE));
    assert.deepEqual(others, []);
  });
});
