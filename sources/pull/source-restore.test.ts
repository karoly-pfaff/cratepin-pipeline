import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { failsWith, lockOf, withPreparedCache } from '../cache/cache-fixtures.test-support.ts';
import { originalPathOf } from '../cache/cache-layout.ts';
import { compareCodeUnits } from '../catalog/ordering.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import {
  canDenyAccess,
  sha256Of,
  withReadDenied,
  writeSources,
} from '../catalog/source-fixtures.test-support.ts';
import type { SourceRecord } from '../lock/source-lock.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { planAndRestoreSources, planSourceRestore, restoreSources } from './source-restore.ts';
import type { SourceRestoreResult } from './source-restore.ts';

const CONTENTS = {
  'images/cat.png': 'cat',
  'images/deep/dog.png': 'dog',
  'sun.png': 'sun',
};
const LOCK = lockOf(CONTENTS);

/** Puts every locked original into the cache, as a completed pull would. */
async function warmAll(layout: CacheLayout): Promise<void> {
  for (const content of Object.values(CONTENTS)) {
    await writeFile(originalPathOf(layout, sha256Of(content)), content);
  }
}

async function restoreAll(
  project: CheckedProject,
  layout: CacheLayout,
): Promise<SourceRestoreResult> {
  const plan = await planSourceRestore(project, LOCK);
  return restoreSources({ project, layout, plan });
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

function sourcesOf(records: readonly SourceRecord[]): string[] {
  return records.map((record) => record.source);
}

function sourcePath(project: CheckedProject, source: string): string {
  return join(project.paths.sourceRoot, ...source.split('/'));
}

test('missing sources are restored from the cache into a fresh checkout', async () => {
  await withPreparedCache(async (layout, project) => {
    await warmAll(layout);
    const result = await restoreAll(project, layout);
    assert.deepEqual(result, {
      restored: ['images/cat.png', 'images/deep/dog.png', 'sun.png'],
      unchanged: [],
      kept: [],
    });
    assert.equal(await readFile(sourcePath(project, 'images/deep/dog.png'), 'utf8'), 'dog');
    assert.deepEqual(await readdir(join(project.paths.sourceRoot, 'images')), ['cat.png', 'deep']);
  });
});

test("an author's edit is kept, an identical file left alone, only gaps are filled", async () => {
  await withPreparedCache(async (layout, project, workspace) => {
    await warmAll(layout);
    await writeSources(workspace, { 'images/cat.png': 'cat with a hat', 'sun.png': 'sun' });
    const plan = await planSourceRestore(project, LOCK);
    assert.deepEqual(sourcesOf(plan.missing), ['images/deep/dog.png']);
    const result = await restoreSources({ project, layout, plan });
    assert.deepEqual(result, {
      restored: ['images/deep/dog.png'],
      unchanged: ['sun.png'],
      kept: ['images/cat.png'],
    });
    assert.equal(await readFile(sourcePath(project, 'images/cat.png'), 'utf8'), 'cat with a hat');
  });
});

test('a directory where a source belongs is kept; a file where a directory belongs stops', async () => {
  await withPreparedCache(async (layout, project, workspace) => {
    await warmAll(layout);
    await writeSources(workspace, { 'images/deep': 'a file in the way' });
    await mkdir(sourcePath(project, 'sun.png'), { recursive: true });
    const plan = await planSourceRestore(project, LOCK);
    assert.deepEqual(plan.kept, ['sun.png']);
    const result = await restoreSources({ project, layout, plan });
    assert.ok(failsWith('OUTPUT_CONFLICT')(result.error));
    assert.deepEqual(result.restored, ['images/cat.png'], 'what was done before the stop');
    assert.equal(await readFile(sourcePath(project, 'images/deep'), 'utf8'), 'a file in the way');
  });
});

test('a cache entry that changed after verification is never restored', async () => {
  await withPreparedCache(async (layout, project) => {
    await warmAll(layout);
    const plan = await planSourceRestore(project, LOCK);
    await writeFile(originalPathOf(layout, sha256Of('cat')), 'tac');
    const result = await restoreSources({ project, layout, plan });
    assert.ok(failsWith('INTEGRITY_MISMATCH')(result.error));
    assert.deepEqual(result.restored, []);
    const names = await readdir(join(project.paths.sourceRoot, 'images'));
    assert.deepEqual(names, [], 'neither the source nor a temporary file');
  });
});

test('a cancelled restore stops before the next file', async () => {
  await withPreparedCache(async (layout, project) => {
    await warmAll(layout);
    const plan = await planSourceRestore(project, LOCK);
    const result = await restoreSources({ project, layout, plan, signal: AbortSignal.abort() });
    assert.ok(failsWith('CANCELLED')(result.error));
    assert.deepEqual(result.restored, []);
  });
});

test('a file created after planning is never replaced, only compared with the lock', async () => {
  await withPreparedCache(async (layout, project, workspace) => {
    await warmAll(layout);
    const plan = await planSourceRestore(project, LOCK);
    await writeSources(workspace, { 'images/cat.png': 'cat drawn meanwhile', 'sun.png': 'sun' });
    const result = await restoreSources({ project, layout, plan });
    assert.deepEqual(result, {
      restored: ['images/deep/dog.png'],
      unchanged: ['sun.png'],
      kept: ['images/cat.png'],
    });
    assert.equal(
      await readFile(sourcePath(project, 'images/cat.png'), 'utf8'),
      'cat drawn meanwhile',
    );
    const hidden = (await readdir(join(project.paths.sourceRoot, 'images'))).filter(isHidden);
    assert.deepEqual(hidden, [], 'no temporary file is left behind');
  });
});

test(
  'a source that cannot be read while planning ends the restore with an error, not a throw',
  {
    skip: !canDenyAccess(),
  },
  async () => {
    await withPreparedCache(async (layout, project, workspace) => {
      await warmAll(layout);
      await writeSources(workspace, { 'sun.png': 'sun' });
      const sun = sourcePath(project, 'sun.png');
      const restoreAll = planAndRestoreSources.bind(undefined, { project, layout, lock: LOCK });
      const result = await withReadDenied([sun], restoreAll);
      assert.ok(failsWith('IO_FAILED')(result.error));
      assert.deepEqual(result.restored, []);
      assert.deepEqual(result.unchanged, [], 'sun.png was not compared');
      assert.deepEqual(result.kept, []);
    });
  },
);

test('restore planning observes cancellation before comparing the next source', async () => {
  await withPreparedCache(async (layout, project) => {
    await warmAll(layout);
    const signal = AbortSignal.abort();
    const result = await planAndRestoreSources({ project, layout, lock: LOCK, signal });
    assert.ok(failsWith('CANCELLED')(result.error));
    assert.deepEqual(result.restored, []);
  });
});

test('an hour-old temporary file a crashed restore left is removed; a fresh one and look-alike names stay', async () => {
  await withPreparedCache(async (layout, project) => {
    await warmAll(layout);
    await mkdir(project.paths.sourceRoot, { recursive: true });
    const stale = '.sun.png.0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.restore';
    const fresh = '.sun.png.1b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.restore';
    const lookAlikes = ['.sun.png.restore', '.sun.png.0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.tmp'];
    for (const name of [stale, fresh, ...lookAlikes]) {
      await writeFile(join(project.paths.sourceRoot, name), 'left over');
    }
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(project.paths.sourceRoot, stale), twoHoursAgo, twoHoursAgo);
    await restoreAll(project, layout);
    const hidden = (await readdir(project.paths.sourceRoot)).filter(isHidden);
    const kept = [fresh, ...lookAlikes].toSorted(compareCodeUnits);
    assert.deepEqual(hidden.toSorted(compareCodeUnits), kept);
    assert.equal(await readFile(sourcePath(project, 'sun.png'), 'utf8'), 'sun');
  });
});
