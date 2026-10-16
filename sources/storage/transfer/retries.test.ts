import assert from 'node:assert/strict';
import test from 'node:test';

import { PipelineError } from '../../errors.ts';
import { BoundedTasks } from './bounded-tasks.ts';
import { jitteredBackoff, withRetries } from './retries.ts';
import { transferSettingsFrom } from './transfer-settings.ts';
import { defaultConfig } from '../../config/pipeline-config.ts';

function failingTimes(times: number, code: 'TRANSIENT_TRANSFER' | 'AUTH_FAILED') {
  let calls = 0;
  const operation = (): Promise<string> => {
    calls += 1;
    if (calls <= times) return Promise.reject(new PipelineError(code, `failure ${String(calls)}`));
    return Promise.resolve(`succeeded on call ${String(calls)}`);
  };
  return { operation, callCount: () => calls };
}

const NO_WAIT = { attempts: 3, delayBeforeRetry: () => 0 };

function isCancelled(error: unknown): boolean {
  return error instanceof PipelineError && error.code === 'CANCELLED';
}

test('transient failures are retried until the attempt budget is spent', async () => {
  const twice = failingTimes(2, 'TRANSIENT_TRANSFER');
  assert.equal(await withRetries(twice.operation, NO_WAIT), 'succeeded on call 3');
  const thrice = failingTimes(3, 'TRANSIENT_TRANSFER');
  await assert.rejects(withRetries(thrice.operation, NO_WAIT), /failure 3/);
  assert.equal(thrice.callCount(), 3);
});

test('non-transient failures are never retried', async () => {
  const denied = failingTimes(1, 'AUTH_FAILED');
  await assert.rejects(withRetries(denied.operation, NO_WAIT), /failure 1/);
  assert.equal(denied.callCount(), 1);
});

test('cancelling while waiting to retry ends with CANCELLED at once', async () => {
  const controller = new AbortController();
  const failing = failingTimes(5, 'TRANSIENT_TRANSFER');
  const retrying = withRetries(failing.operation, {
    attempts: 5,
    delayBeforeRetry: () => 60_000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    retrying,
    (error) => error instanceof PipelineError && error.code === 'CANCELLED',
  );
  assert.equal(failing.callCount(), 1);
});

test('backoff grows exponentially with jitter and is capped', () => {
  for (let index = 0; index < 50; index += 1) {
    assert.ok(jitteredBackoff(1) <= 250);
    assert.ok(jitteredBackoff(3) <= 1000);
    assert.ok(jitteredBackoff(20) <= 4000);
  }
});

test('bounded tasks never run more than the limit and rethrow the first failure after settling', async () => {
  const tasks = new BoundedTasks(2);
  let running = 0;
  let mostRunning = 0;
  let finished = 0;
  const task = async (): Promise<void> => {
    running += 1;
    mostRunning = Math.max(mostRunning, running);
    await new Promise((resolve) => setImmediate(resolve));
    running -= 1;
    finished += 1;
  };
  for (let index = 0; index < 5; index += 1) await tasks.start(task);
  await tasks.finish();
  assert.deepEqual([mostRunning, finished], [2, 5]);
  const failing = new BoundedTasks(2);
  await failing.start(() => Promise.reject(new Error('first failure')));
  await failing.start(task).catch(() => undefined);
  await assert.rejects(failing.finish(), /first failure/);
  await assert.rejects(failing.start(task), /first failure/);
});

test('cancelling during the wait before a retry ends with CANCELLED without another try', async () => {
  const controller = new AbortController();
  const failing = failingTimes(5, 'TRANSIENT_TRANSFER');
  const startedAt = performance.now();
  const retrying = withRetries(failing.operation, {
    attempts: 5,
    delayBeforeRetry: () => 60_000,
    signal: controller.signal,
  });
  setTimeout(() => {
    controller.abort();
  }, 20);
  await assert.rejects(retrying, isCancelled);
  assert.equal(failing.callCount(), 1);
  assert.ok(performance.now() - startedAt < 5000);
});

test('the backoff ceiling doubles per retry', () => {
  const longestWaitOf = (retry: number): number =>
    Math.max(...Array.from({ length: 200 }, () => jitteredBackoff(retry)));
  assert.ok(longestWaitOf(1) <= 250);
  assert.ok(longestWaitOf(3) > 250, 'the third retry may wait longer than the first');
});

test('settings take seconds from the config and the concurrency override', () => {
  const settings = transferSettingsFrom({ ...defaultConfig().limits, requestTimeoutSeconds: 7 }, 3);
  assert.deepEqual([settings.requestTimeoutMs, settings.partConcurrency], [7000, 3]);
});
