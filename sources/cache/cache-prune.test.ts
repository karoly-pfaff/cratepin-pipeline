import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { compareCodeUnits } from '../catalog/ordering.ts';
import { checkedProjectIn, sha256Of } from '../catalog/source-fixtures.test-support.ts';
import { linkDirectory, withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { claimCacheUse } from './cache-claims.ts';
import { derivativePathsOf } from './cache-file-names.ts';
import { failsWith, lockOf, withPreparedCache } from './cache-fixtures.test-support.ts';
import { inventoryCache } from './cache-inventory.ts';
import type { CacheFile } from './cache-inventory.ts';
import { originalPathOf } from './cache-layout.ts';
import type { CacheLayout } from './cache-layout.ts';
import { planPrune, removePlannedFiles } from './cache-prune.ts';
import { pruneCache } from './cache-prune-run.ts';
import { installProcessLivenessProbe } from './claim-processes.test-support.ts';

const claimProcess = installProcessLivenessProbe(process.ppid);
after(claimProcess.restore);

const LOCK = lockOf({ 'cat.png': 'cat', 'dog.png': 'dog' });
const UUID = '0b5a4c1e-2f8d-4e3a-9c7b-1d2e3f405162';
const UNKNOWN_NAMES = ['README', 'incoming/folder', 'originals/sha256/notes.txt'];

/** Orders `<kind> <name>` lines by name, as the inventory does. */
function byName(left: string, right: string): number {
  return compareCodeUnits(left.split(' ')[1] ?? '', right.split(' ')[1] ?? '');
}

function namesOf(files: readonly CacheFile[]): string[] {
  return files.map((file) => `${file.kind} ${file.name}`);
}

/** A cache holding what crashed and finished runs leave: referenced, unreferenced, leftovers. */
async function fillCache(layout: CacheLayout): Promise<void> {
  await writeFile(originalPathOf(layout, sha256Of('cat')), 'cat');
  await writeFile(originalPathOf(layout, sha256Of('dog')), 'god');
  await writeFile(originalPathOf(layout, sha256Of('old')), 'old');
  await writeFile(join(layout.incoming, `${sha256Of('sun')}.${UUID}.part`), 'su');
  await writeFile(join(layout.quarantine, `${sha256Of('dog')}.${UUID}`), 'gdo');
  await writeFile(join(layout.claims, `.${UUID}.tmp`), '');
  await writeFile(join(layout.root, `cratepin-cache.json.${UUID}.tmp`), '');
  await writeFile(join(layout.originals, 'notes.txt'), 'mine');
  await mkdir(join(layout.incoming, 'folder'));
  await writeFile(join(layout.root, 'README'), 'mine too');
}

/** The inventory lines of a derivative's output and record. */
function derivativeNamesOf(source: string, key: string): string[] {
  return [
    `derivative derivatives/${sha256Of(source)}.${key}`,
    `derivativeRecord derivatives/${sha256Of(source)}.${key}.json`,
  ];
}

async function treeOf(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true })).toSorted(compareCodeUnits);
}

async function writeDeadClaim(layout: CacheLayout): Promise<void> {
  const owner = { pid: claimProcess.pid, host: hostname(), command: 'pull' };
  await writeFile(join(layout.claims, `use-${randomUUID()}.json`), JSON.stringify(owner));
}

/** A signal that reports itself aborted from its `checks`+1-th look on: a cancel between files. */
function abortingAfterChecks(checks: number): AbortSignal {
  let looks = 0;
  return {
    get aborted() {
      looks += 1;
      return looks > checks;
    },
  } as AbortSignal;
}

/** Adds and removes part files until stopped, as a running pull does. */
function churnPartFiles(layout: CacheLayout): { readonly stop: () => Promise<void> } {
  const state = { isChurning: true };
  const churning = (async () => {
    while (state.isChurning) {
      const part = join(layout.incoming, `${sha256Of('sun')}.${randomUUID()}.part`);
      await writeFile(part, 's');
      await rm(part);
    }
  })();
  return {
    stop: async () => {
      state.isChurning = false;
      await churning;
    },
  };
}

test('the inventory knows only the layout names; everything else is unknown', async () => {
  await withPreparedCache(async (layout) => {
    await fillCache(layout);
    const { files, unknownNames } = await inventoryCache(layout);
    assert.deepEqual(
      namesOf(files),
      [
        `temporary cratepin-cache.json.${UUID}.tmp`,
        `temporary claims/.${UUID}.tmp`,
        `part incoming/${sha256Of('sun')}.${UUID}.part`,
        `entry originals/sha256/${sha256Of('cat')}`,
        `entry originals/sha256/${sha256Of('dog')}`,
        `entry originals/sha256/${sha256Of('old')}`,
        `quarantined quarantine/${sha256Of('dog')}.${UUID}`,
      ].toSorted(byName),
    );
    assert.deepEqual(unknownNames, UNKNOWN_NAMES);
  });
});

test('a plan keeps and checks referenced entries and removes only what the layout names', async () => {
  await withPreparedCache(async (layout) => {
    await fillCache(layout);
    const lock = lockOf({ 'cat.png': 'cat', 'dog.png': 'dog', 'sun.png': 'sun' });
    const plan = await planPrune(layout, lock, { concurrency: 2 });
    assert.deepEqual(namesOf(plan.referenced), [
      `entry originals/sha256/${sha256Of('cat')}`,
      `entry originals/sha256/${sha256Of('dog')}`,
    ]);
    const corrupt = plan.corruptReferenced ?? [];
    assert.deepEqual(namesOf(corrupt), [`entry originals/sha256/${sha256Of('dog')}`]);
    assert.equal(plan.missingReferencedCount, 1);
    assert.ok(namesOf(plan.removable).includes(`entry originals/sha256/${sha256Of('old')}`));
    assert.equal(plan.removable.length, 5);
    const unchecked = await planPrune(layout, lock);
    assert.equal(unchecked.corruptReferenced, undefined, 'only inspections hash');
  });
});

test('derivatives of referenced originals stay, whatever made them; the others go', async () => {
  await withPreparedCache(async (layout) => {
    const [profileKey, encoderKey] = [sha256Of('webp profile'), sha256Of('older encoder')];
    const derivatives = [
      derivativePathsOf(layout, sha256Of('cat'), profileKey),
      derivativePathsOf(layout, sha256Of('cat'), encoderKey),
      derivativePathsOf(layout, sha256Of('old'), profileKey),
    ];
    for (const { output, record } of derivatives) {
      await writeFile(output, 'pixels');
      await writeFile(record, '{}');
    }
    await writeFile(join(layout.derivatives, 'notes.txt'), 'mine');
    const plan = await planPrune(layout, LOCK);
    assert.deepEqual(
      namesOf(plan.referencedDerivatives),
      [...derivativeNamesOf('cat', profileKey), ...derivativeNamesOf('cat', encoderKey)].toSorted(
        byName,
      ),
    );
    assert.deepEqual(namesOf(plan.removable), derivativeNamesOf('old', profileKey));
    assert.deepEqual(plan.unknownNames, ['derivatives/notes.txt']);
    assert.equal(plan.referenced.length, 0, 'derivatives never count as locked originals');
  });
});

test('removal stops between files on cancellation and says exactly what is gone', async () => {
  await withPreparedCache(async (layout) => {
    await fillCache(layout);
    const plan = await planPrune(layout, LOCK);
    // One look before the loop, then one before each file: the third file is not removed.
    const cancelled = await removePlannedFiles(plan, abortingAfterChecks(3));
    assert.ok(failsWith('CANCELLED')(cancelled.error));
    assert.deepEqual(cancelled.removed, plan.removable.slice(0, 2));
    const left = await inventoryCache(layout);
    assert.equal(left.files.length, plan.referenced.length + plan.removable.length - 2);
    const removal = await removePlannedFiles(plan, undefined);
    assert.equal(removal.removed.length, plan.removable.length - 2, 'gone ones are not counted');
    const after = await inventoryCache(layout);
    assert.deepEqual(namesOf(after.files), namesOf(plan.referenced));
    assert.deepEqual(after.unknownNames, UNKNOWN_NAMES);
  });
});

test('a removal that fails midway reports what it removed before the failure', async () => {
  await withPreparedCache(async (layout) => {
    await fillCache(layout);
    const plan = await planPrune(layout, LOCK);
    const [first, second] = plan.removable;
    if (first === undefined || second === undefined) throw new Error('two removable files');
    await rm(second.path);
    await mkdir(second.path);
    const removal = await removePlannedFiles(plan, undefined);
    assert.ok(removal.error !== undefined, 'a directory in the way is never removed');
    assert.deepEqual(removal.removed, [first]);
  });
});

test('a dry run changes nothing, not even dead claims; a missing cache is never created', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    const nothing = await pruneCache({ project, lock: LOCK, isDryRun: false, concurrency: 1 });
    assert.equal(nothing.cacheExists, false);
    assert.equal((await readdir(workspace)).includes('.cratepin-cache'), false);
  });
  await withPreparedCache(async (layout, project) => {
    await fillCache(layout);
    await writeDeadClaim(layout);
    const before = await treeOf(layout.root);
    const preview = await pruneCache({ project, lock: LOCK, isDryRun: true, concurrency: 1 });
    assert.equal(preview.plan?.removable.length, 5);
    assert.equal(preview.deadClaimFiles.length, 1);
    assert.deepEqual(await treeOf(layout.root), before);
  });
});

test('a real prune refuses while a pull holds the cache and removes dead claims otherwise', async () => {
  await withPreparedCache(async (layout, project) => {
    await fillCache(layout);
    const pull = await claimCacheUse(layout, 'pull');
    const refused = pruneCache({ project, lock: LOCK, isDryRun: false, concurrency: 1 });
    await assert.rejects(refused, failsWith('OUTPUT_CONFLICT'));
    assert.ok((await readdir(layout.originals)).includes(sha256Of('old')), 'nothing was removed');
    await pull.release();
    await writeDeadClaim(layout);
    const result = await pruneCache({ project, lock: LOCK, isDryRun: false, concurrency: 1 });
    assert.equal(result.deadClaimFiles.length, 1);
    assert.deepEqual(await readdir(layout.claims), []);
    assert.equal(result.removal?.removed.length, 5);
  });
});

test('a cache made before claims existed can still be inspected and pruned', async () => {
  await withPreparedCache(async (layout, project) => {
    await rm(layout.claims, { recursive: true });
    await writeFile(originalPathOf(layout, sha256Of('old')), 'old');
    const preview = await pruneCache({ project, lock: LOCK, isDryRun: true, concurrency: 1 });
    assert.deepEqual(preview.liveClaims, []);
    const result = await pruneCache({ project, lock: LOCK, isDryRun: false, concurrency: 1 });
    assert.equal(result.removal?.removed.length, 1);
    assert.equal(result.removal.error, undefined);
  });
});

test('a link or junction in place of a cache directory stops a prune before anything goes', async () => {
  await withPreparedCache(async (layout, project, workspace) => {
    const elsewhere = join(workspace, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, sha256Of('not cache')), 'precious');
    await rm(layout.originals, { recursive: true });
    await linkDirectory(elsewhere, layout.originals);
    const inspection = pruneCache({ project, lock: LOCK, isDryRun: true, concurrency: 1 });
    await assert.rejects(inspection, failsWith('OUTPUT_CONFLICT'));
    const prune = pruneCache({ project, lock: LOCK, isDryRun: false, concurrency: 1 });
    await assert.rejects(prune, failsWith('OUTPUT_CONFLICT'));
    assert.deepEqual(await readdir(layout.claims), [], 'refused before any claim was taken');
    assert.deepEqual(await readdir(elsewhere), [sha256Of('not cache')]);
  });
});

test('an inspection while a pull adds and removes part files never fails on a vanished file', async () => {
  await withPreparedCache(async (layout, project) => {
    const churn = churnPartFiles(layout);
    try {
      for (let round = 0; round < 50; round += 1) {
        const preview = await pruneCache({ project, lock: LOCK, isDryRun: true, concurrency: 1 });
        assert.equal(preview.cacheExists, true);
      }
    } finally {
      await churn.stop();
    }
  });
});

test('a prune keeps what the lock committed while it waited for the cache needs', async () => {
  await withPreparedCache(async (layout, project) => {
    await fillCache(layout);
    const committedMeanwhile = lockOf({ 'cat.png': 'cat', 'dog.png': 'dog', 'old.png': 'old' });
    const result = await pruneCache({
      project,
      lock: LOCK,
      lockOnceHeld: () => Promise.resolve(committedMeanwhile),
      isDryRun: false,
      concurrency: 1,
    });
    assert.equal(result.removal?.error, undefined);
    assert.ok(
      (await readdir(layout.originals)).includes(sha256Of('old')),
      'the newly locked entry stays',
    );
  });
});
