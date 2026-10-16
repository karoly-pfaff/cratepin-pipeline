import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { assertReplaceableRoot, ownedRootError } from './owned-root.ts';
import {
  refusedBecause,
  TEST_OWNER,
  writeOwnedTree,
} from '../publication/publication-fixtures.test-support.ts';

test('an absent, empty or clean owned root may be replaced', async () => {
  await withWorkspace(async (workspace) => {
    const root = join(workspace, 'assets');
    assert.equal((await assertReplaceableRoot(root, TEST_OWNER)).state, 'absent');
    await mkdir(root);
    assert.equal((await assertReplaceableRoot(root, TEST_OWNER)).state, 'empty');
    await writeOwnedTree(root, { 'images/cat.png': 'cat' });
    assert.equal((await assertReplaceableRoot(root, TEST_OWNER)).state, 'owned');
    assert.equal(await ownedRootError(root), undefined);
  });
});

test('an owned root holding anything the tool did not write is refused and named', async () => {
  await withWorkspace(async (workspace) => {
    const root = await writeOwnedTree(join(workspace, 'assets'), { 'images/cat.png': 'cat' });
    await writeFile(join(root, 'images', 'Thumbs.db'), 'litter');
    await mkdir(join(root, 'empty'));
    await assert.rejects(
      assertReplaceableRoot(root, TEST_OWNER),
      refusedBecause('UNLISTED_OUTPUT_ENTRY', {
        messagePart: '(empty, images/Thumbs.db)',
        details: { entryCount: 2 },
      }),
    );
  });
});

test('a root of another project or with other files is refused before its entries are read', async () => {
  await withWorkspace(async (workspace) => {
    const root = await writeOwnedTree(join(workspace, 'assets'), { 'cat.png': 'cat' });
    const stranger = { projectId: 'other', outputMode: 'path-preserving' } as const;
    await assert.rejects(assertReplaceableRoot(root, stranger), { name: 'PipelineError' });
    const legacy = join(workspace, 'legacy');
    await mkdir(legacy);
    await writeFile(join(legacy, 'hand.png'), 'made');
    await assert.rejects(
      assertReplaceableRoot(legacy, TEST_OWNER),
      refusedBecause('OUTPUT_NOT_OWNED'),
    );
  });
});

test('an owned root whose listing is damaged is refused as such, not as foreign files', async () => {
  await withWorkspace(async (workspace) => {
    const root = await writeOwnedTree(join(workspace, 'assets'), { 'cat.png': 'cat' });
    await writeFile(join(root, '.cratepin-generation.json'), 'damaged');
    await assert.rejects(
      assertReplaceableRoot(root, TEST_OWNER),
      refusedBecause('OUTPUT_LISTING_INVALID'),
    );
  });
});
