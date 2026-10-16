import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RebuildQueue } from '../../examples/watch-consumer/rebuildQueue.js';

test(
  'a synchronously initiated close waits for the callback that initiated it',
  { timeout: 10000 },
  async () => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let closing;
    let hasClosed = false;
    const queue = new RebuildQueue({
      debounceMs: 0,
      build: () => {
        closing = queue.close();
        started.resolve();
        return release.promise;
      },
    });
    try {
      queue.request();
      await started.promise;
      assert.ok(closing);
      const observedClose = closing.then(() => {
        hasClosed = true;
      });
      await Promise.resolve();
      assert.equal(hasClosed, false);
      assert.equal(queue.snapshot.isRunning, true);
      release.resolve();
      await observedClose;
      assert.equal(hasClosed, true);
      assert.equal(queue.snapshot.isRunning, false);
    } finally {
      release.resolve();
      await queue.close();
    }
  },
);

test(
  'an event storm during a held build coalesces to one trailing build with no overlap',
  { timeout: 10000 },
  async () => {
    const firstStarted = Promise.withResolvers();
    const releaseFirst = Promise.withResolvers();
    const secondStarted = Promise.withResolvers();
    const releaseSecond = Promise.withResolvers();
    let count = 0;
    let activeCount = 0;
    let maxActiveCount = 0;
    const queue = new RebuildQueue({
      debounceMs: 0,
      build: async () => {
        count += 1;
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        const started = count === 1 ? firstStarted : secondStarted;
        const release = count === 1 ? releaseFirst : releaseSecond;
        started.resolve();
        await release.promise;
        activeCount -= 1;
      },
    });
    try {
      queue.request();
      await firstStarted.promise;
      for (let event = 0; event < 1000; event += 1) queue.request();
      assert.equal(queue.snapshot.hasPending, true);
      releaseFirst.resolve();
      await secondStarted.promise;
      assert.equal(count, 2);
      assert.equal(maxActiveCount, 1);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await queue.close();
    }
    assert.equal(count, 2);
    assert.equal(queue.snapshot.isRunning, false);
  },
);

test(
  'close aborts active work, awaits settlement, discards pending work and is idempotent',
  { timeout: 10000 },
  async () => {
    const started = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    const release = Promise.withResolvers();
    let count = 0;
    const queue = new RebuildQueue({
      debounceMs: 0,
      build: async (signal) => {
        count += 1;
        signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        started.resolve();
        await release.promise;
      },
    });
    queue.request();
    await started.promise;
    queue.request();
    let hasClosed = false;
    const closing = queue.close().then(() => {
      hasClosed = true;
    });
    await aborted.promise;
    assert.equal(hasClosed, false);
    assert.equal(queue.request(), false);
    release.resolve();
    await closing;
    assert.equal(count, 1);
    assert.equal(queue.snapshot.hasPending, false);
    assert.deepEqual(await queue.close(), queue.snapshot);
  },
);

test(
  'close before debounce starts no work and build failures stay observable without unhandled rejections',
  { timeout: 10000 },
  async () => {
    let count = 0;
    const pending = new RebuildQueue({
      debounceMs: 50,
      build: () => {
        count += 1;
      },
    });
    pending.request();
    await pending.close();
    await delay(60);
    assert.equal(count, 0);
    const failed = Promise.withResolvers();
    const failure = new Error('fixture build failed');
    const queue = new RebuildQueue({
      debounceMs: 0,
      build: () => {
        failed.resolve();
        throw failure;
      },
    });
    queue.request();
    await failed.promise;
    const snapshot = await queue.close();
    assert.equal(snapshot.lastFailure, failure);
    assert.throws(() => new RebuildQueue({ build: null }), TypeError);
    for (const debounceMs of [-1, 0.5, 1001, NaN])
      assert.throws(() => new RebuildQueue({ build: () => undefined, debounceMs }), RangeError);
  },
);
