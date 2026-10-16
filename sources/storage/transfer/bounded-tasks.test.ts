import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { concurrencyGate } from './bounded-tasks.ts';

/** Counts the tasks running inside a gate and the most there ever were at once. */
function runningCounter(): { enter: () => void; leave: () => void; readonly peak: () => number } {
  let running = 0;
  let peak = 0;
  return {
    enter: () => {
      running += 1;
      peak = Math.max(peak, running);
    },
    leave: () => {
      running -= 1;
    },
    peak: () => peak,
  };
}

test('a gate never runs more tasks at once than its limit, also with tasks arriving later', async () => {
  const gate = concurrencyGate(2);
  const counter = runningCounter();
  const task = async (): Promise<void> => {
    counter.enter();
    await nextTurn();
    counter.leave();
  };
  const first = Array.from({ length: 6 }, () => gate(task));
  await nextTurn();
  const later = Array.from({ length: 6 }, () => gate(task));
  await Promise.all([...first, ...later]);
  assert.equal(counter.peak(), 2);
});

test('a failed task frees its place and its error reaches the caller', async () => {
  const gate = concurrencyGate(1);
  await assert.rejects(
    gate(() => Promise.reject(new Error('conversion failed'))),
    /conversion failed/,
  );
  assert.equal(await gate(() => Promise.resolve('next')), 'next');
});
