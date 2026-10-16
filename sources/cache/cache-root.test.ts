import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { compareCodeUnits } from '../catalog/ordering.ts';
import { checkedProjectIn } from '../catalog/source-fixtures.test-support.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { failsWith } from './cache-fixtures.test-support.ts';
import { existingCache, prepareCache } from './cache-root.ts';

test('a missing cache is created with its marker and directories', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace, { cacheDir: 'build/cache' });
    assert.equal(await existingCache(project), undefined);
    const layout = await prepareCache(project);
    assert.equal(layout.root, join(workspace, 'build', 'cache'));
    assert.deepEqual(JSON.parse(await readFile(layout.markerFile, 'utf8')), {
      schemaVersion: 1,
      projectId: 'demo',
    });
    assert.deepEqual((await readdir(layout.root)).toSorted(compareCodeUnits), [
      'claims',
      'cratepin-cache.json',
      'derivatives',
      'incoming',
      'originals',
      'quarantine',
    ]);
    assert.deepEqual(await existingCache(project), layout);
    assert.deepEqual(await prepareCache(project), layout);
  });
});

test('an empty directory is adopted; a non-empty unmarked one is never touched', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    await mkdir(project.paths.cacheRoot);
    assert.equal(await existingCache(project), undefined);
    await prepareCache(project);
    const foreign = await checkedProjectIn(workspace, { cacheDir: 'notes' });
    await mkdir(foreign.paths.cacheRoot);
    await writeFile(join(foreign.paths.cacheRoot, 'todo.txt'), 'mine');
    await assert.rejects(prepareCache(foreign), failsWith('OUTPUT_CONFLICT'));
    await assert.rejects(existingCache(foreign), failsWith('OUTPUT_CONFLICT'));
    assert.deepEqual(await readdir(foreign.paths.cacheRoot), ['todo.txt']);
  });
});

test("another project's cache, an unreadable marker or a file as root is refused", async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    await mkdir(project.paths.cacheRoot);
    const marker = join(project.paths.cacheRoot, 'cratepin-cache.json');
    for (const text of ['{"schemaVersion":1,"projectId":"other"}', '{"schemaVersion":2}', 'oops']) {
      await writeFile(marker, text);
      await assert.rejects(prepareCache(project), failsWith('OUTPUT_CONFLICT'), text);
      await assert.rejects(existingCache(project), failsWith('OUTPUT_CONFLICT'), text);
    }
    const fileRoot = await checkedProjectIn(workspace, { cacheDir: 'cache-file' });
    await writeFile(fileRoot.paths.cacheRoot, 'not a directory');
    await assert.rejects(prepareCache(fileRoot), failsWith('OUTPUT_CONFLICT'));
  });
});

test('two runs preparing a new cache at once agree on one marker', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    const [first, second] = await Promise.all([prepareCache(project), prepareCache(project)]);
    assert.deepEqual(first, second);
  });
});

test('a file where a cache directory belongs is a conflict, not followed', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    const layout = await prepareCache(project);
    await rm(layout.incoming, { recursive: true });
    await writeFile(layout.incoming, 'in the way');
    await assert.rejects(prepareCache(project), failsWith('OUTPUT_CONFLICT'));
  });
});

test('a cache another run is just creating counts as empty and is adopted', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    const inProgress = 'cratepin-cache.json.0b5a4c1e-2f8d-4e3a-9c7b-1d2e3f405162.tmp';
    await mkdir(project.paths.cacheRoot);
    await writeFile(join(project.paths.cacheRoot, inProgress), '');
    assert.equal(await existingCache(project), undefined);
    const layout = await prepareCache(project);
    assert.match(await readFile(layout.markerFile, 'utf8'), /"projectId":"demo"/u);
    const names = await readdir(layout.root);
    assert.ok(names.includes(inProgress), 'only the other run removes its own file');
  });
});

test('an unmarked directory holding cache-like names with content is not adopted', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    await mkdir(join(project.paths.cacheRoot, 'originals'), { recursive: true });
    await writeFile(join(project.paths.cacheRoot, 'originals', 'my-notes.txt'), 'mine');
    await assert.rejects(existingCache(project), failsWith('OUTPUT_CONFLICT'));
    await assert.rejects(prepareCache(project), failsWith('OUTPUT_CONFLICT'));
    assert.deepEqual(await readdir(project.paths.cacheRoot), ['originals']);
  });
});

test('a marker larger than 4 KiB is never read, so the cache is refused', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    await mkdir(project.paths.cacheRoot);
    const padded = `{"schemaVersion":1,"projectId":"demo"${' '.repeat(4096)}}`;
    await writeFile(join(project.paths.cacheRoot, 'cratepin-cache.json'), padded);
    await assert.rejects(existingCache(project), failsWith('OUTPUT_CONFLICT'));
  });
});
