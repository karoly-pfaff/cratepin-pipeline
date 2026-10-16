import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { canDenyAccess, withWriteDenied } from '../catalog/source-fixtures.test-support.ts';
import { createMemoryStore } from '../memory-store.ts';
import { linkDirectory } from '../paths/layout/layout-fixtures.test-support.ts';
import { downloadIntoCache } from './cache-download.ts';
import {
  failsWith,
  lockedObjectOf,
  storedContentsOf,
  withPreparedCache,
} from './cache-fixtures.test-support.ts';
import { originalPathOf } from './cache-layout.ts';
import type { CacheLayout } from './cache-layout.ts';
import { checkCachedOriginal, quarantineOriginal } from './cached-originals.ts';

const CAT = lockedObjectOf('cat pixels');

async function leftoversOf(layout: CacheLayout): Promise<string[]> {
  return readdir(layout.incoming);
}

/** What `originalPathOf` throws for `sha256`, or `undefined` when it accepts it. */
function entryNameFailure(layout: CacheLayout, sha256: string): unknown {
  try {
    originalPathOf(layout, sha256);
  } catch (error) {
    return error;
  }
  return undefined;
}

function abortOnNextTurn(controller: AbortController): void {
  setImmediate(() => {
    controller.abort();
  });
}

test('only an entry with exactly the locked bytes is a hit', async () => {
  await withPreparedCache(async (layout) => {
    const entry = originalPathOf(layout, CAT.sha256);
    assert.equal(await checkCachedOriginal(layout, CAT), 'absent');
    await writeFile(entry, 'cat pixels');
    assert.equal(await checkCachedOriginal(layout, CAT), 'verified');
    await writeFile(entry, 'dog pixels');
    assert.equal(await checkCachedOriginal(layout, CAT), 'corrupt', 'same size, other bytes');
    await writeFile(entry, 'cat pixels!');
    assert.equal(await checkCachedOriginal(layout, CAT), 'corrupt', 'longer');
    await writeFile(entry, '');
    assert.equal(await checkCachedOriginal(layout, CAT), 'corrupt', 'empty');
  });
});

test('a directory or link at an entry name is corrupt, never followed', async () => {
  await withPreparedCache(async (layout, _project, workspace) => {
    await mkdir(originalPathOf(layout, CAT.sha256));
    assert.equal(await checkCachedOriginal(layout, CAT), 'corrupt');
    await quarantineOriginal(layout, CAT);
    const target = join(workspace, 'elsewhere');
    await mkdir(target);
    await linkDirectory(target, originalPathOf(layout, CAT.sha256));
    assert.equal(await checkCachedOriginal(layout, CAT), 'corrupt');
  });
});

test('quarantine moves an entry out of the way under a unique name; twice is fine', async () => {
  await withPreparedCache(async (layout) => {
    await writeFile(originalPathOf(layout, CAT.sha256), 'broken');
    await quarantineOriginal(layout, CAT);
    await quarantineOriginal(layout, CAT);
    assert.equal(await checkCachedOriginal(layout, CAT), 'absent');
    const quarantined = await readdir(layout.quarantine);
    assert.equal(quarantined.length, 1);
    assert.match(quarantined[0] ?? '', new RegExp(`^${CAT.sha256}\\.[0-9a-f-]{36}$`, 'u'));
  });
});

test('an entry name is only ever a SHA-256 hex digest', async () => {
  await withPreparedCache((layout) => {
    const isInvalidName = failsWith('INVALID_DATA');
    assert.ok(isInvalidName(entryNameFailure(layout, '../../escape')));
    assert.ok(isInvalidName(entryNameFailure(layout, CAT.sha256.toUpperCase())));
    assert.equal(entryNameFailure(layout, CAT.sha256), undefined);
    return Promise.resolve();
  });
});

test('a download is verified, then published under its hash; no part file remains', async () => {
  await withPreparedCache(async (layout) => {
    const store = createMemoryStore({
      initialContents: storedContentsOf('cat pixels'),
      chunkBytes: 3,
    });
    await downloadIntoCache({ layout, object: CAT, reader: store, signal: undefined });
    assert.equal(await readFile(originalPathOf(layout, CAT.sha256), 'utf8'), 'cat pixels');
    assert.equal(await checkCachedOriginal(layout, CAT), 'verified');
    assert.deepEqual(await leftoversOf(layout), []);
  });
});

test('wrong, longer or truncated bytes never become an entry', async () => {
  await withPreparedCache(async (layout) => {
    const wrongStores = [
      createMemoryStore({ initialContents: { [CAT.objectKey]: Buffer.from('dog pixels') } }),
      createMemoryStore({
        initialContents: { [CAT.objectKey]: Buffer.from('cat pixels and more') },
      }),
      createMemoryStore({
        initialContents: storedContentsOf('cat pixels'),
        faults: [
          { operation: 'read', key: CAT.objectKey, code: 'TRANSIENT_TRANSFER', afterBytes: 4 },
        ],
        chunkBytes: 2,
      }),
    ];
    const expected = ['INTEGRITY_MISMATCH', 'INTEGRITY_MISMATCH', 'TRANSIENT_TRANSFER'] as const;
    for (const [index, reader] of wrongStores.entries()) {
      await assert.rejects(
        downloadIntoCache({ layout, object: CAT, reader, signal: undefined }),
        failsWith(expected[index] ?? 'IO_FAILED'),
      );
      assert.equal(await checkCachedOriginal(layout, CAT), 'absent');
      assert.deepEqual(await leftoversOf(layout), []);
    }
  });
});

test('a cancelled download leaves neither an entry nor a part file', async () => {
  await withPreparedCache(async (layout) => {
    const store = createMemoryStore({
      initialContents: storedContentsOf('cat pixels'),
      chunkBytes: 1,
    });
    const controller = new AbortController();
    const downloading = downloadIntoCache({
      layout,
      object: CAT,
      reader: store,
      signal: controller.signal,
    });
    abortOnNextTurn(controller);
    await assert.rejects(downloading, failsWith('CANCELLED'));
    assert.equal(await checkCachedOriginal(layout, CAT), 'absent');
    assert.deepEqual(await leftoversOf(layout), []);
  });
});

test('an entry another process published meanwhile is kept once it verifies', async () => {
  await withPreparedCache(async (layout) => {
    await writeFile(originalPathOf(layout, CAT.sha256), 'cat pixels');
    const store = createMemoryStore({ initialContents: storedContentsOf('cat pixels') });
    await downloadIntoCache({ layout, object: CAT, reader: store, signal: undefined });
    assert.equal(await checkCachedOriginal(layout, CAT), 'verified');
    assert.deepEqual(await readdir(layout.quarantine), []);
  });
});

test('a corrupt entry in the way is quarantined and replaced by the verified download', async () => {
  await withPreparedCache(async (layout) => {
    await writeFile(originalPathOf(layout, CAT.sha256), 'tampered!!');
    const store = createMemoryStore({ initialContents: storedContentsOf('cat pixels') });
    await downloadIntoCache({ layout, object: CAT, reader: store, signal: undefined });
    assert.equal(await checkCachedOriginal(layout, CAT), 'verified');
    const [quarantined = ''] = await readdir(layout.quarantine);
    assert.equal(await readFile(join(layout.quarantine, quarantined), 'utf8'), 'tampered!!');
  });
});

test(
  'a link that fails publishes nothing and leaves no part file; a later run succeeds',
  {
    skip: !canDenyAccess(),
  },
  async () => {
    await withPreparedCache(async (layout) => {
      const store = createMemoryStore({ initialContents: storedContentsOf('cat pixels') });
      const download = { layout, object: CAT, reader: store, signal: undefined };
      const denied = withWriteDenied(
        [layout.originals],
        downloadIntoCache.bind(undefined, download),
      );
      await assert.rejects(denied, failsWith('IO_FAILED'));
      assert.equal(await checkCachedOriginal(layout, CAT), 'absent');
      assert.deepEqual(await leftoversOf(layout), []);
      await downloadIntoCache(download);
      assert.equal(await checkCachedOriginal(layout, CAT), 'verified');
    });
  },
);

test('a quarantine that finds a verified entry puts it back under its name', async () => {
  await withPreparedCache(async (layout) => {
    await writeFile(originalPathOf(layout, CAT.sha256), 'cat pixels');
    assert.equal(await quarantineOriginal(layout, CAT), true);
    assert.equal(await checkCachedOriginal(layout, CAT), 'verified');
    assert.deepEqual(await readdir(layout.quarantine), []);
  });
});
