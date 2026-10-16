import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

/** Startup and matching have distinct budgets, so a slow child start cannot hide a matcher hang. */
function nextMessage(child, timeoutMs) {
  const pending = Promise.withResolvers();
  const timer = setTimeout(() => {
    pending.reject(new Error('Glob child exceeded its deadline'));
  }, timeoutMs);
  const onMessage = (body) => {
    pending.resolve(body);
  };
  const onExit = (code) => {
    pending.reject(new Error(`Glob child exited before its answer: ${String(code)}`));
  };
  child.once('message', onMessage);
  child.once('exit', onExit);
  child.once('error', pending.reject);
  return pending.promise.finally(() => {
    clearTimeout(timer);
    child.off('message', onMessage);
    child.off('exit', onExit);
    child.off('error', pending.reject);
  });
}

test('separated-star near misses are bounded for include, category and profile selection', async () => {
  const child = fork(new URL('./glob-probe.test-support.mjs', import.meta.url), [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    assert.equal(await nextMessage(child, 120_000), 'ready');
    const answer = nextMessage(child, 5000);
    child.send('match');
    assert.deepEqual(await answer, {
      hasNearMiss: false,
      hasMatch: true,
      includedCount: 1,
      inclusionIssues: [],
      categories: ['image', 'other'],
      classificationIssues: [],
      profiles: ['screen', 'copy'],
    });
    assert.deepEqual(await exited, [0, null], stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
  }
});
