import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';

import type { BlobUpload } from './blob-store.ts';
import { streamChunksUntilCancelled } from './byte-streams.ts';
import { createMemoryStore } from './memory-store.ts';
import type { InjectedFault } from './memory-store.ts';

const ORIGINAL_CONTENT = Buffer.from('original master bytes '.repeat(10));
const NEVER_SETTLES = new Promise<never>(function waitForever() {
  // Simulates a network body that stalls indefinitely.
});

function sha256Of(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function uploadOf(
  key: string,
  content: Uint8Array,
  openBody: () => AsyncIterable<Uint8Array> = () =>
    streamChunksUntilCancelled([content], undefined),
): BlobUpload {
  return { key, bytes: content.length, sha256: sha256Of(content), openBody };
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function nextChunkLength(iterator: AsyncIterator<Uint8Array>): Promise<number> {
  const step = await iterator.next();
  if (step.done === true) throw new Error('stream ended early');
  return step.value.length;
}

test('creates only absent keys, verifies content and never opens an unneeded body', async () => {
  const store = createMemoryStore();
  assert.equal(await store.createBlobIfAbsent(uploadOf('a', ORIGINAL_CONTENT)), 'created');
  let openedBodies = 0;
  const otherContent = Buffer.from('other');
  const countingUpload = uploadOf('a', otherContent, () => {
    openedBodies += 1;
    return streamChunksUntilCancelled([otherContent], undefined);
  });
  assert.equal(await store.createBlobIfAbsent(countingUpload), 'already-exists');
  assert.equal(openedBodies, 0);
  assert.deepEqual(await readAll(store.readBlob('a')), ORIGINAL_CONTENT);
  const tampered = {
    ...uploadOf('b', Buffer.from('tampered')),
    sha256: sha256Of(ORIGINAL_CONTENT),
  };
  await assert.rejects(store.createBlobIfAbsent(tampered), { code: 'INTEGRITY_MISMATCH' });
  assert.equal(await store.statBlob('b'), undefined);
});

test('never overwrites when two writers race for one key', async () => {
  const store = createMemoryStore();
  const secondContent = Buffer.from('second writer');
  const second = Promise.withResolvers<undefined>();
  // The first writer's body ends only after the second writer has stored its bytes.
  const slowFirst = uploadOf('race', ORIGINAL_CONTENT, async function* slowBody() {
    await second.promise;
    yield ORIGINAL_CONTENT;
  });
  const firstOutcome = store.createBlobIfAbsent(slowFirst);
  const secondOutcome = await store.createBlobIfAbsent(uploadOf('race', secondContent));
  second.resolve(undefined);
  const outcomes = [await firstOutcome, secondOutcome];
  assert.deepEqual(outcomes, ['already-exists', 'created']);
  assert.deepEqual(await readAll(store.readBlob('race')), secondContent);
});

test('streams copies in chunks and replays scripted faults deterministically', async () => {
  const seed = Buffer.from(ORIGINAL_CONTENT);
  const store = createMemoryStore({
    initialContents: { a: seed },
    chunkBytes: 16,
    faults: [
      { operation: 'stat', key: 'a', code: 'TRANSIENT_TRANSFER', times: 2 },
      { operation: 'read', key: 'a', code: 'TRANSIENT_TRANSFER', afterBytes: 40 },
    ],
  });
  seed.fill(0);
  await assert.rejects(store.statBlob('a'), { code: 'TRANSIENT_TRANSFER' });
  await assert.rejects(store.statBlob('a'), { code: 'TRANSIENT_TRANSFER' });
  assert.deepEqual(await store.statBlob('a'), { key: 'a', bytes: ORIGINAL_CONTENT.length });
  const received: Uint8Array[] = [];
  const collectTruncated = async (): Promise<void> => {
    for await (const chunk of store.readBlob('a')) received.push(chunk);
  };
  await assert.rejects(collectTruncated(), { code: 'TRANSIENT_TRANSFER' });
  assert.equal(Buffer.concat(received).length, 40);
  received[0]?.fill(0);
  assert.deepEqual(await readAll(store.readBlob('a')), ORIGINAL_CONTENT);
  assert.equal(store.calls.length, 5);
  await assert.rejects(readAll(store.readBlob('missing')), { code: 'NOT_FOUND' });
});

test('rejects a truncation fault on an operation that cannot be truncated', () => {
  const misplacedTruncation = {
    operation: 'stat',
    key: 'a',
    code: 'NOT_FOUND',
    afterBytes: 1,
  } as unknown as InjectedFault;
  assert.throws(() => createMemoryStore({ faults: [misplacedTruncation] }), {
    code: 'INVALID_DATA',
  });
});

test('uploads sharing one run-level signal leave no abort listeners behind', async () => {
  const store = createMemoryStore();
  const runController = new AbortController();
  for (let index = 0; index < 5; index += 1) {
    const upload = uploadOf(`key-${String(index)}`, Buffer.from(`content ${String(index)}`));
    await store.createBlobIfAbsent(upload, { signal: runController.signal });
  }
  assert.equal(getEventListeners(runController.signal, 'abort').length, 0);
});

test('honours cancellation before and during a read', async () => {
  const store = createMemoryStore({ initialContents: { a: ORIGINAL_CONTENT }, chunkBytes: 8 });
  await assert.rejects(store.statBlob('a', { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  const readController = new AbortController();
  const transfer = store.readBlob('a', { signal: readController.signal })[Symbol.asyncIterator]();
  assert.equal(await nextChunkLength(transfer), 8);
  readController.abort();
  await assert.rejects(transfer.next(), { code: 'CANCELLED' });
});

test('cancels an upload whose body is stalled and stores nothing', async () => {
  const store = createMemoryStore();
  const stalledController = new AbortController();
  const stalledUpload = uploadOf('stalled', ORIGINAL_CONTENT, async function* stalledBody() {
    await NEVER_SETTLES;
    yield ORIGINAL_CONTENT;
  });
  const startedAt = Date.now();
  const stalledCreate = store.createBlobIfAbsent(stalledUpload, {
    signal: stalledController.signal,
  });
  setTimeout(() => {
    stalledController.abort();
  }, 10);
  await assert.rejects(stalledCreate, { code: 'CANCELLED' });
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(await store.statBlob('stalled'), undefined);
});

test('an abort right after the last chunk still cancels and stores nothing', async () => {
  const store = createMemoryStore();
  const lateController = new AbortController();
  const abortAfterLastChunk = uploadOf('late', ORIGINAL_CONTENT, async function* lateAbortBody() {
    await nextEventLoopTurn();
    yield ORIGINAL_CONTENT;
    lateController.abort();
  });
  await assert.rejects(
    store.createBlobIfAbsent(abortAfterLastChunk, { signal: lateController.signal }),
    {
      code: 'CANCELLED',
    },
  );
  assert.equal(await store.statBlob('late'), undefined);
});
