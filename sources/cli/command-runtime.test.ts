import assert from 'node:assert/strict';
import test from 'node:test';

import { processRuntime } from './command-runtime.ts';

test('Ctrl+C is taken over only once a command asks for the cancellation signal', () => {
  const listenersBefore = process.listenerCount('SIGINT');
  const runtime = processRuntime();
  assert.equal(process.listenerCount('SIGINT'), listenersBefore);
  const signal = runtime.cancellationSignal();
  assert.equal(runtime.cancellationSignal(), signal);
  assert.equal(process.listenerCount('SIGINT'), listenersBefore + 1);
  process.emit('SIGINT');
  assert.ok(signal.aborted);
  assert.equal(process.listenerCount('SIGINT'), listenersBefore);
});

test('a termination request cancels like Ctrl+C, and the next signal of any kind is not taken over', () => {
  const sigintBefore = process.listenerCount('SIGINT');
  const sigtermBefore = process.listenerCount('SIGTERM');
  const signal = processRuntime().cancellationSignal();
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore + 1);
  process.emit('SIGTERM');
  assert.ok(signal.aborted);
  assert.equal(process.listenerCount('SIGINT'), sigintBefore);
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);
});
