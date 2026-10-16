import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import type { BlobReader } from '../blob-store.ts';
import {
  failsWith,
  lockedObjectOf,
  storedContentsOf,
  withPreparedCache,
} from '../cache/cache-fixtures.test-support.ts';
import { originalPathOf } from '../cache/cache-layout.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import { PipelineError } from '../errors.ts';
import { canDenyAccess, withWriteDenied } from '../catalog/source-fixtures.test-support.ts';
import { checkCachedOriginal } from '../cache/cached-originals.ts';
import { createMemoryStore } from '../memory-store.ts';
import type { MemoryStoreOptions } from '../memory-store.ts';
import { inspectCachedOriginals, retrieveLockedOriginals } from './locked-originals.ts';
import type { CacheInspection, OriginalOutcome } from './locked-originals.ts';

const CAT = lockedObjectOf('cat', ['cat']);
const DOG = lockedObjectOf('dog', ['dog']);
const SUN = lockedObjectOf('sun', ['sun']);

/** A reader factory that counts how often the transport was created. */
function countingReader(options: MemoryStoreOptions = {}): {
  readonly openReader: () => BlobReader;
  readonly creations: () => number;
} {
  let creations = 0;
  const store = createMemoryStore(options);
  return {
    openReader: () => {
      creations += 1;
      return store;
    },
    creations: () => creations,
  };
}

function quarantineFlagsOf(outcomes: readonly OriginalOutcome[]): boolean[] {
  return outcomes.map((outcome) => outcome.wasQuarantined);
}

function errorCodesOf(outcomes: readonly OriginalOutcome[]): (string | undefined)[] {
  return outcomes.map((outcome) => outcome.error?.code);
}

function abortAfter(controller: AbortController, milliseconds: number): void {
  setTimeout(() => {
    controller.abort();
  }, milliseconds);
}

function isTheError(expected: unknown): (error: unknown) => boolean {
  return (error) => error === expected;
}

function statusesOf(outcomes: readonly OriginalOutcome[]): string[] {
  return outcomes.map((outcome) => `${outcome.object.ids.join()} ${outcome.status}`);
}

function statesOf(inspections: readonly CacheInspection[]): string[] {
  return inspections.map((inspection) => inspection.state);
}

async function warm(layout: CacheLayout, ...contents: string[]): Promise<void> {
  for (const content of contents) {
    await writeFile(originalPathOf(layout, lockedObjectOf(content).sha256), content);
  }
}

test('a warm cache never creates the read transport, also online', async () => {
  await withPreparedCache(async (layout) => {
    await warm(layout, 'cat', 'dog');
    const transport = countingReader();
    const outcomes = await retrieveLockedOriginals({
      layout,
      objects: [CAT, DOG],
      isOffline: false,
      openReader: transport.openReader,
      concurrency: 2,
    });
    assert.deepEqual(statusesOf(outcomes), ['cat cached', 'dog cached']);
    assert.equal(transport.creations(), 0);
  });
});

test('misses are downloaded with one transport; hits and misses mix', async () => {
  await withPreparedCache(async (layout) => {
    await warm(layout, 'dog');
    const transport = countingReader({ initialContents: storedContentsOf('cat', 'sun') });
    const outcomes = await retrieveLockedOriginals({
      layout,
      objects: [CAT, DOG, SUN],
      isOffline: false,
      openReader: transport.openReader,
      concurrency: 3,
    });
    assert.deepEqual(statusesOf(outcomes), ['cat downloaded', 'dog cached', 'sun downloaded']);
    assert.equal(transport.creations(), 1);
  });
});

test('offline, misses are reported and no transport is ever created', async () => {
  await withPreparedCache(async (layout) => {
    await warm(layout, 'dog');
    await writeFile(originalPathOf(layout, SUN.sha256), 'moon');
    const transport = countingReader();
    const outcomes = await retrieveLockedOriginals({
      layout,
      objects: [CAT, DOG, SUN],
      isOffline: true,
      openReader: transport.openReader,
      concurrency: 1,
    });
    assert.deepEqual(statusesOf(outcomes), ['cat missing', 'dog cached', 'sun missing']);
    assert.deepEqual(quarantineFlagsOf(outcomes), [false, false, true]);
    assert.equal(transport.creations(), 0);
  });
});

test('one failing object is recorded and the others still arrive', async () => {
  await withPreparedCache(async (layout) => {
    const transport = countingReader({
      initialContents: { ...storedContentsOf('cat'), [SUN.objectKey]: Buffer.from('moon') },
    });
    const outcomes = await retrieveLockedOriginals({
      layout,
      objects: [CAT, DOG, SUN],
      isOffline: false,
      openReader: transport.openReader,
      concurrency: 1,
    });
    assert.deepEqual(statusesOf(outcomes), ['cat downloaded', 'dog failed', 'sun failed']);
    assert.deepEqual(errorCodesOf(outcomes), [undefined, 'NOT_FOUND', 'INTEGRITY_MISMATCH']);
  });
});

test('a transport that cannot be created stops the retrieval and is tried only once', async () => {
  await withPreparedCache(async (layout) => {
    const missingVariables = new PipelineError('CONFIG_INVALID', 'Required variables are not set.');
    let attempts = 0;
    const retrieval = retrieveLockedOriginals({
      layout,
      objects: [CAT, DOG, SUN],
      isOffline: false,
      openReader: () => {
        attempts += 1;
        throw missingVariables;
      },
      concurrency: 3,
    });
    await assert.rejects(retrieval, isTheError(missingVariables));
    assert.equal(attempts, 1);
  });
});

test('cancelling while downloads run ends as CANCELLED and leaves no part file', async () => {
  await withPreparedCache(async (layout) => {
    const large = 'x'.repeat(200_000);
    const transport = countingReader({ initialContents: storedContentsOf(large), chunkBytes: 1 });
    const controller = new AbortController();
    const retrieval = retrieveLockedOriginals({
      layout,
      objects: [lockedObjectOf(large, ['large'])],
      isOffline: false,
      openReader: transport.openReader,
      concurrency: 1,
      signal: controller.signal,
    });
    abortAfter(controller, 20);
    await assert.rejects(retrieval, failsWith('CANCELLED'));
    assert.deepEqual(await readdir(layout.incoming), []);
    assert.deepEqual(await readdir(layout.originals), []);
  });
});

test('cancellation stops the retrieval as CANCELLED', async () => {
  await withPreparedCache(async (layout) => {
    const transport = countingReader({ initialContents: storedContentsOf('cat', 'dog') });
    const retrieval = retrieveLockedOriginals({
      layout,
      objects: [CAT, DOG],
      isOffline: false,
      openReader: transport.openReader,
      concurrency: 1,
      signal: AbortSignal.abort(),
    });
    await assert.rejects(retrieval, failsWith('CANCELLED'));
  });
});

test('inspection hashes entries but changes nothing, also without a cache', async () => {
  await withPreparedCache(async (layout) => {
    await warm(layout, 'cat');
    await writeFile(originalPathOf(layout, DOG.sha256), 'god');
    const inspections = await inspectCachedOriginals(layout, [CAT, DOG, SUN], 2);
    assert.deepEqual(statesOf(inspections), ['verified', 'corrupt', 'absent']);
    assert.equal(await readFile(originalPathOf(layout, DOG.sha256), 'utf8'), 'god');
    assert.deepEqual(await readdir(layout.quarantine), []);
    const withoutCache = await inspectCachedOriginals(undefined, [CAT], 1);
    assert.equal(withoutCache[0]?.state, 'absent');
  });
});

test(
  'a corrupt entry that cannot be quarantined stops the retrieval and is still not served',
  {
    skip: !canDenyAccess(),
  },
  async () => {
    await withPreparedCache(async (layout) => {
      await writeFile(originalPathOf(layout, CAT.sha256), 'tac');
      const transport = countingReader({ initialContents: storedContentsOf('cat') });
      const retrieval = {
        layout,
        objects: [CAT],
        isOffline: false,
        openReader: transport.openReader,
        concurrency: 1,
      };
      const retrieve = retrieveLockedOriginals.bind(undefined, retrieval);
      await assert.rejects(withWriteDenied([layout.quarantine], retrieve), failsWith('IO_FAILED'));
      assert.equal(await checkCachedOriginal(layout, CAT), 'corrupt');
      assert.equal(transport.creations(), 0, 'nothing was downloaded');
    });
  },
);
