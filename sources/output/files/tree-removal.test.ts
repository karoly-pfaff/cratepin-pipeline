import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { sha256Of } from '../../catalog/source-fixtures.test-support.ts';
import { linkDirectory, withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { GENERATION_LISTING_NAME, listingTextOf } from '../generation/generation-listing.ts';
import { OUTPUT_MARKER_NAME } from '../ownership/output-marker.ts';
import { NODE_PUBLICATION_FILE_SYSTEM } from '../publication/publication-files.ts';
import { faultyFileSystem } from '../publication/publication-fixtures.test-support.ts';
import type { FailurePlan } from '../publication/publication-fixtures.test-support.ts';
import { removeListedTree, removeOwnStaging } from './tree-removal.ts';

const CAT = Buffer.from('cat pixels');
const FILES = {
  'images/cat.png': CAT,
  'voice/hu/hello.mp3': Buffer.from('voice'),
};

/** A published tree: its files, the marker and a listing naming the files. */
async function publishedTree(workspace: string): Promise<string> {
  const tree = join(workspace, 'trash', 'old');
  for (const [path, bytes] of Object.entries(FILES)) {
    await mkdir(join(tree, ...path.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(tree, ...path.split('/')), bytes);
  }
  const listed = Object.entries(FILES).map(([path, bytes]) => ({
    path,
    sha256: sha256Of(bytes),
    bytes: bytes.length,
    mediaType: 'application/octet-stream',
  }));
  await writeFile(join(tree, GENERATION_LISTING_NAME), listingTextOf(listed));
  await writeFile(join(tree, OUTPUT_MARKER_NAME), '{}');
  return tree;
}

test('a published tree is removed file by file, its directories last', async () => {
  await withWorkspace(async (workspace) => {
    const tree = await publishedTree(workspace);
    const removal = await removeListedTree(NODE_PUBLICATION_FILE_SYSTEM, tree);
    assert.deepEqual(removal, { removedFileCount: 4, keptPaths: [] });
    assert.deepEqual(await readdir(join(workspace, 'trash')), []);
  });
});

test('a changed or unlisted file stays, and so do its directories and the listing that proves it', async () => {
  await withWorkspace(async (workspace) => {
    const tree = await publishedTree(workspace);
    await writeFile(join(tree, 'images', 'cat.png'), 'changed after publishing');
    await writeFile(join(tree, 'voice', 'notes.txt'), 'mine');
    const removal = await removeListedTree(NODE_PUBLICATION_FILE_SYSTEM, tree);
    assert.deepEqual(
      removal.keptPaths,
      [
        join(tree, GENERATION_LISTING_NAME),
        join(tree, OUTPUT_MARKER_NAME),
        join(tree, 'images'),
        join(tree, 'images', 'cat.png'),
        join(tree, 'voice'),
        join(tree, 'voice', 'notes.txt'),
      ].toSorted(compareCodeUnits),
    );
    assert.equal(await readFile(join(tree, 'voice', 'notes.txt'), 'utf8'), 'mine');
  });
});

test('a junction at a listed directory is neither followed nor removed', async () => {
  await withWorkspace(async (workspace) => {
    const tree = await publishedTree(workspace);
    const elsewhere = join(workspace, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'cat.png'), CAT);
    await rm(join(tree, 'images'), { recursive: true });
    await linkDirectory(elsewhere, join(tree, 'images'));
    const removal = await removeListedTree(NODE_PUBLICATION_FILE_SYSTEM, tree);
    assert.ok(removal.keptPaths.includes(join(tree, 'images')), 'the junction stays, reported');
    assert.equal(
      await readFile(join(elsewhere, 'cat.png'), 'utf8'),
      'cat pixels',
      'the target stays',
    );
  });
});

test('a tree without a readable listing is kept whole', async () => {
  await withWorkspace(async (workspace) => {
    const tree = await publishedTree(workspace);
    await writeFile(join(tree, GENERATION_LISTING_NAME), 'not a listing');
    const removal = await removeListedTree(NODE_PUBLICATION_FILE_SYSTEM, tree);
    assert.equal(removal.removedFileCount, 0);
    assert.ok(removal.keptPaths.includes(join(tree, 'images', 'cat.png')));
  });
});

test('staging is removed entirely, except a junction, which is neither followed nor removed', async () => {
  await withWorkspace(async (workspace) => {
    const staging = join(workspace, 'staging');
    await mkdir(join(staging, 'a', 'b'), { recursive: true });
    await writeFile(join(staging, 'a', 'b', 'partial.png'), 'half');
    const sentinel = join(workspace, 'sentinel');
    await mkdir(sentinel);
    await writeFile(join(sentinel, 'keep.txt'), 'keep');
    await linkDirectory(sentinel, join(staging, 'linked'));
    const removal = await removeOwnStaging(NODE_PUBLICATION_FILE_SYSTEM, staging);
    assert.equal(removal.removedFileCount, 1);
    assert.deepEqual(removal.keptPaths, [join(staging, 'linked')]);
    assert.equal(await readFile(join(sentinel, 'keep.txt'), 'utf8'), 'keep');
  });
});

test('a tree without a listing is removed only when it is an empty directory', async () => {
  await withWorkspace(async (workspace) => {
    const empty = join(workspace, 'trash', 'empty');
    await mkdir(empty, { recursive: true });
    assert.deepEqual(await removeListedTree(NODE_PUBLICATION_FILE_SYSTEM, empty), {
      removedFileCount: 0,
      keptPaths: [],
    });
    assert.deepEqual(await readdir(join(workspace, 'trash')), []);
  });
});

test('a tree that is itself a link is kept, and nothing is removed through it', async () => {
  await withWorkspace(async (workspace) => {
    const tree = await publishedTree(workspace);
    const link = join(workspace, 'linked');
    await linkDirectory(tree, link);
    const removal = await removeListedTree(NODE_PUBLICATION_FILE_SYSTEM, link);
    assert.deepEqual(removal, { removedFileCount: 0, keptPaths: [link] });
    assert.equal(await readFile(join(tree, 'images', 'cat.png'), 'utf8'), 'cat pixels');
  });
});

/** Denies this user reading `path` until the returned function restores its permissions. */
function denyReading(path: string): () => void {
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  execFileSync(icacls, [path, '/deny', `${process.env.USERNAME ?? ''}:(R)`]);
  return () => execFileSync(icacls, [path, '/reset']);
}

test(
  'a listed file that cannot even be opened is kept, and the removal still finishes',
  { skip: process.platform !== 'win32' && 'icacls is Windows only' },
  async () => {
    await withWorkspace(async (workspace) => {
      const tree = await publishedTree(workspace);
      const cat = join(tree, 'images', 'cat.png');
      const restore = denyReading(cat);
      try {
        const removal = await removeListedTree(NODE_PUBLICATION_FILE_SYSTEM, tree);
        assert.equal(removal.removedFileCount, 1, 'the voice file; the listing stays for a retry');
        assert.ok(removal.keptPaths.includes(cat));
      } finally {
        restore();
      }
    });
  },
);

/** Fails the first rmdir of a path ending with `suffix`, as a directory briefly held open. */
function blockingFirstRmdirOf(suffix: string): FailurePlan {
  let isBlocked = false;
  return ({ name, paths }) => {
    if (isBlocked || name !== 'rmdir' || !(paths[0] ?? '').endsWith(suffix)) return undefined;
    isBlocked = true;
    return Object.assign(new Error('busy'), { code: 'EBUSY' });
  };
}

test('a listed directory that cannot be removed keeps the listing, so a later run finishes', async () => {
  await withWorkspace(async (workspace) => {
    const tree = await publishedTree(workspace);
    const { fileSystem } = faultyFileSystem(blockingFirstRmdirOf('images'));
    const first = await removeListedTree(fileSystem, tree);
    assert.ok(first.keptPaths.includes(join(tree, GENERATION_LISTING_NAME)));
    const second = await removeListedTree(NODE_PUBLICATION_FILE_SYSTEM, tree);
    assert.deepEqual(second.keptPaths, []);
    assert.deepEqual(await readdir(join(workspace, 'trash')), []);
  });
});
