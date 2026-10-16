import assert from 'node:assert/strict';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { catalogSources } from '../catalog/asset-catalog.ts';
import { compareCodeUnits } from '../catalog/ordering.ts';
import { inventorySources } from '../catalog/inventory.ts';
import { checkedProjectIn, writeSources } from '../catalog/source-fixtures.test-support.ts';
import { loadCommittedLock } from '../lock/lock-file.ts';
import { serializeLock, stageLock } from '../lock/source-lock.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { FakeS3 } from '../storage/testing/fake-s3.test-support.ts';
import type { FakeS3Request, RequestFault } from '../storage/testing/fake-s3.test-support.ts';
import type { BlobReader, BlobUpload, BlobWriter } from '../blob-store.ts';
import { createR2BlobReader, createR2BlobWriter } from '../storage/r2/r2-blob-store.ts';
import { DEFAULT_TRANSFER_SETTINGS } from '../storage/transfer/transfer-settings.ts';
import type { TransferSettings } from '../storage/transfer/transfer-settings.ts';
import { pushStagedLock } from './push-run.ts';
import type { PushResult } from './push-run.ts';

const FAST = { ...DEFAULT_TRANSFER_SETTINGS, delayBeforeRetry: () => 0 };
const SOURCES = {
  'images/cat.png': 'cat bytes',
  'images/dog.png': 'dog bytes',
  'voice/hi.mp3': 'hi',
};

interface Scene {
  readonly workspace: string;
  readonly project: CheckedProject;
  readonly fake: FakeS3;
}

async function withScene(useScene: (scene: Scene) => Promise<void>): Promise<void> {
  await withWorkspace(async (workspace) => {
    await writeSources(workspace, SOURCES);
    const fake = await FakeS3.start();
    try {
      await useScene({ workspace, project: await checkedProjectIn(workspace), fake });
    } finally {
      await fake.close();
    }
  });
}

async function stagedLockOf(project: CheckedProject): Promise<SourceLock> {
  const catalog = catalogSources(await inventorySources(project), project.config.assets);
  return stageLock(project.config, catalog);
}

async function committedLockOf(project: CheckedProject): Promise<SourceLock | undefined> {
  const load = await loadCommittedLock(project);
  return load.status === 'valid' ? load.lock : undefined;
}

async function push(
  { project, fake }: Scene,
  settings: TransferSettings = FAST,
): Promise<PushResult> {
  return pushStagedLock({
    project,
    committed: await committedLockOf(project),
    staged: await stagedLockOf(project),
    storage: {
      writer: createR2BlobWriter(fake.connection, settings),
      reader: createR2BlobReader(fake.connection, settings),
    },
    concurrency: 2,
  });
}

function stalledCompletion(request: FakeS3Request): RequestFault | undefined {
  const isCompletion = request.method === 'POST' && request.query.startsWith('uploadId=');
  return isCompletion ? { controlBody: { isStalled: true } } : undefined;
}

test('a stalled completion keeps the previous lock; a later push verifies the ambiguous stored object', async () => {
  await withScene(async (scene) => {
    assert.ok((await push(scene)).ok);
    const before = await readFile(lockFileOf(scene), 'utf8');
    await writeSources(scene.workspace, { 'music/new.mp3': Buffer.alloc(64, 7) });
    const settings = {
      ...FAST,
      multipartThresholdBytes: 16,
      multipartPartBytes: 16,
      requestTimeoutMs: 2000,
    };
    scene.fake.planRequests(stalledCompletion);
    const failed = await push(scene, settings);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'TRANSIENT_TRANSFER');
    assert.equal(await readFile(lockFileOf(scene), 'utf8'), before);
    assert.equal(
      scene.fake.objects.size,
      4,
      'the completion may have stored an unreferenced original',
    );
    assert.equal(scene.fake.uploads.size, 0, 'the owned upload was aborted');
    const completions = scene.fake.requests.filter(stalledCompletion);
    assert.equal(completions.length, 1, 'completion was never retried blindly');
    scene.fake.planRequests(undefined);
    const recovered = await push(scene, settings);
    assert.ok(recovered.ok);
    assert.equal(recovered.created.length, 0);
    assert.equal(
      recovered.alreadyStored.length,
      1,
      'readback proves the object that was ambiguous',
    );
    assert.notEqual(await readFile(lockFileOf(scene), 'utf8'), before);
  });
});

function lockFileOf({ project }: Scene): string {
  return project.paths.lockFilePath;
}

async function leftoverTemporaryFiles({ workspace }: Scene): Promise<string[]> {
  return (await readdir(workspace)).filter((name) => name.endsWith('.tmp'));
}

/** The object keys, sorted, for order-independent comparison. */
function keysOf(objects: readonly { readonly objectKey: string }[]): string[] {
  return objects.map((object) => object.objectKey).toSorted(compareCodeUnits);
}

test('a push uploads every original, verifies it and writes the lock; a repeat only confirms', async () => {
  await withScene(async (scene) => {
    const first = await push(scene);
    assert.ok(first.ok, first.ok ? '' : first.error.message);
    assert.equal(first.created.length, 3);
    const committed = await readFile(lockFileOf(scene), 'utf8');
    assert.equal(committed, serializeLock(await stagedLockOf(scene.project)));
    const second = await push(scene);
    assert.ok(second.ok);
    assert.deepEqual(
      [second.created.length, second.alreadyStored.length, second.confirmed.length],
      [0, 0, 3],
    );
    assert.equal(await readFile(lockFileOf(scene), 'utf8'), committed);
  });
});

test('a failed upload keeps the previous lock and reports the objects created so far', async () => {
  await withScene(async (scene) => {
    await writeFile(
      lockFileOf(scene),
      serializeLock({ schemaVersion: 1, projectId: 'demo', assets: [] }),
    );
    const previous = await readFile(lockFileOf(scene), 'utf8');
    const staged = await stagedLockOf(scene.project);
    const failingKey = staged.assets[1]?.objectKey ?? '';
    scene.fake.failNext({ method: 'PUT', key: failingKey, status: 403, s3Code: 'AccessDenied' });
    const result = await push(scene);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'AUTH_FAILED');
    assert.equal(await readFile(lockFileOf(scene), 'utf8'), previous);
    assert.ok(!keysOf(result.created).includes(failingKey));
    assert.deepEqual(
      keysOf(result.created),
      [...scene.fake.objects.keys()].toSorted(compareCodeUnits),
    );
    assert.deepEqual(await leftoverTemporaryFiles(scene), []);
  });
});

test('wrong bytes already stored under a key fail verification and write nothing', async () => {
  await withScene(async (scene) => {
    const staged = await stagedLockOf(scene.project);
    const tamperedKey = staged.assets[0]?.objectKey ?? '';
    scene.fake.objects.set(tamperedKey, Buffer.from('not the original'));
    const result = await push(scene);
    assert.ok(!result.ok && result.error.code === 'INTEGRITY_MISMATCH');
    assert.equal(scene.fake.objects.get(tamperedKey)?.toString(), 'not the original');
    assert.equal(await committedLockOf(scene.project), undefined);
  });
});

test('a locked original missing from storage stops the push', async () => {
  await withScene(async (scene) => {
    assert.ok((await push(scene)).ok);
    const lockedKey = [...scene.fake.objects.keys()][0] ?? '';
    scene.fake.objects.delete(lockedKey);
    const previous = await readFile(lockFileOf(scene), 'utf8');
    await writeSources(scene.workspace, { 'images/new.png': 'new bytes' });
    const result = await push(scene);
    assert.ok(!result.ok && result.error.code === 'NOT_FOUND');
    assert.equal(await readFile(lockFileOf(scene), 'utf8'), previous);
  });
});

test('a failed rename keeps the previous lock; the next push recovers without re-uploading', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('a read-only file blocks replacing it only on Windows');
    return;
  }
  await withScene(async (scene) => {
    await writeFile(
      lockFileOf(scene),
      serializeLock({ schemaVersion: 1, projectId: 'demo', assets: [] }),
    );
    const previous = await readFile(lockFileOf(scene), 'utf8');
    await chmod(lockFileOf(scene), 0o444);
    const blocked = await push(scene);
    assert.ok(!blocked.ok);
    assert.equal(await readFile(lockFileOf(scene), 'utf8'), previous);
    assert.deepEqual(await leftoverTemporaryFiles(scene), []);
    await chmod(lockFileOf(scene), 0o644);
    const rerun = await push(scene);
    assert.ok(rerun.ok);
    assert.deepEqual([rerun.created.length, rerun.alreadyStored.length], [0, 3]);
  });
});

test('an object created but failing its readback is still reported as created', async () => {
  await withScene(async (scene) => {
    const staged = await stagedLockOf(scene.project);
    const unreadableKey = staged.assets[0]?.objectKey ?? '';
    scene.fake.failNext({ method: 'GET', key: unreadableKey, status: 403, s3Code: 'AccessDenied' });
    const result = await push(scene);
    assert.ok(!result.ok && result.error.code === 'AUTH_FAILED');
    assert.ok(keysOf(result.created).includes(unreadableKey));
    assert.ok(scene.fake.objects.has(unreadableKey));
  });
});

test('a lock file whose directory does not exist stops the push before any transfer', async () => {
  await withWorkspace(async (workspace) => {
    await writeSources(workspace, SOURCES);
    const fake = await FakeS3.start();
    try {
      const project = await checkedProjectIn(workspace, { lockFile: 'locks/cratepin-lock.json' });
      const result = await push({ workspace, project, fake });
      assert.ok(!result.ok && result.error.code === 'NOT_FOUND');
      assert.deepEqual(fake.requests, []);
    } finally {
      await fake.close();
    }
  });
});

/** A reader that cancels the push once the last object's readback has finished. */
function cancellingAfterLastReadback(scene: Scene, controller: AbortController): BlobReader {
  const reader = createR2BlobReader(scene.fake.connection, FAST);
  let finished = 0;
  return {
    statBlob: (key, options) => reader.statBlob(key, options),
    readBlob: async function* readThenCancel(key, options) {
      yield* reader.readBlob(key, options);
      finished += 1;
      if (finished === Object.keys(SOURCES).length) controller.abort();
    },
  };
}

test('a cancellation after the last readback writes no lock; the objects stay stored', async () => {
  await withScene(async (scene) => {
    const controller = new AbortController();
    const result = await pushStagedLock({
      project: scene.project,
      committed: undefined,
      staged: await stagedLockOf(scene.project),
      storage: {
        writer: createR2BlobWriter(scene.fake.connection, FAST),
        reader: cancellingAfterLastReadback(scene, controller),
      },
      concurrency: 2,
      signal: controller.signal,
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CANCELLED');
    assert.equal(await committedLockOf(scene.project), undefined);
    assert.equal(scene.fake.objects.size, 3);
    assert.deepEqual(await leftoverTemporaryFiles(scene), []);
  });
});

const FIVE_MIB = 5 * 1024 * 1024;
const PARTED = { ...FAST, multipartThresholdBytes: FIVE_MIB, multipartPartBytes: FIVE_MIB };

/** A writer that cancels the push once a large body has handed over more than one part. */
function cancellingMidUpload(scene: Scene, controller: AbortController): BlobWriter {
  const writer = createR2BlobWriter(scene.fake.connection, PARTED);
  return {
    createBlobIfAbsent: (upload, options) =>
      writer.createBlobIfAbsent(
        { ...upload, openBody: () => cancelAfter(upload, controller) },
        options,
      ),
  };
}

async function* cancelAfter(
  upload: BlobUpload,
  controller: AbortController,
): AsyncGenerator<Uint8Array> {
  let handedOver = 0;
  for await (const chunk of upload.openBody()) {
    handedOver += chunk.length;
    if (handedOver > FIVE_MIB) controller.abort();
    yield chunk;
  }
}

function isAbort({ method }: { readonly method: string }): boolean {
  return method === 'DELETE';
}

test('a push cancelled during a multipart upload aborts it and writes no lock', async () => {
  await withScene(async (scene) => {
    await writeSources(scene.workspace, { 'music/long.mp3': Buffer.alloc(FIVE_MIB * 2 + 99, 7) });
    const controller = new AbortController();
    const result = await pushStagedLock({
      project: scene.project,
      committed: undefined,
      staged: await stagedLockOf(scene.project),
      storage: {
        writer: cancellingMidUpload(scene, controller),
        reader: createR2BlobReader(scene.fake.connection, PARTED),
      },
      concurrency: 2,
      signal: controller.signal,
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CANCELLED');
    assert.equal(await committedLockOf(scene.project), undefined);
    assert.ok(scene.fake.requests.some(isAbort), 'the upload was aborted');
    assert.equal(scene.fake.uploads.size, 0, 'no multipart upload is left open');
    assert.deepEqual(
      [...scene.fake.objects.keys()].toSorted(compareCodeUnits),
      keysOf(result.created),
    );
  });
});
