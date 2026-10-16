import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RebuildQueue } from '../../examples/watch-consumer/rebuildQueue.js';
import { watchProjectInputs } from '../../examples/watch-consumer/projectWatch.js';
import { offlineRebuilder } from '../../examples/watch-consumer/offlineRebuild.js';
import {
  withProject,
  snapshotOf,
  runWithoutNetwork,
  reportOf,
} from '../building/projects.test-support.mjs';

const CLI = fileURLToPath(new URL('../../sources/cli/main.ts', import.meta.url));
const NETWORK_BLOCK = new URL('../support/network-block.test-support.mjs', import.meta.url).href;

async function until(predicate) {
  const deadline = Date.now() + 30000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Condition timed out');
    await delay(10);
  }
}

async function assertWatchedOfflineBuilds(directory, fake) {
  const originals = await snapshotOf(join(directory, 'assets', 'source'));
  const remote = [...fake.objects].map(([key, bytes]) => [key, Buffer.from(bytes)]);
  const initialRequests = fake.requests.length;
  const configPath = join(directory, 'cratepin.config.json');
  const config = await readFile(configPath, 'utf8');
  const lock = await readFile(join(directory, 'cratepin-lock.json'), 'utf8');
  const releaseFirst = Promise.withResolvers();
  let completed = 0;
  let active = 0;
  let maximumActive = 0;
  const rebuild = offlineRebuilder({
    projectRoot: directory,
    cliFile: CLI,
    nodeOptions: ['--import', NETWORK_BLOCK],
  });
  const queue = new RebuildQueue({
    debounceMs: 0,
    build: async (signal) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await releaseFirst.promise;
      await rebuild(signal);
      active -= 1;
      completed += 1;
    },
  });
  const watch = watchProjectInputs({ projectRoot: directory, queue });
  try {
    await writeFile(join(directory, 'replacement.json'), config);
    await rename(join(directory, 'replacement.json'), configPath);
    await until(() => queue.snapshot.isRunning);
    for (let edit = 0; edit < 20; edit += 1) {
      await writeFile(join(directory, 'replacement.json'), config);
      await rename(join(directory, 'replacement.json'), configPath);
    }
    await until(() => queue.snapshot.hasPending);
    releaseFirst.resolve();
    await until(() => completed >= 2 && !queue.snapshot.isRunning);
    assert.equal(queue.snapshot.lastFailure, undefined);
    assert.equal(maximumActive, 1);
    const verify = await runWithoutNetwork(directory, 'verify', '--json');
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(reportOf(verify).status, 'succeeded');
  } finally {
    releaseFirst.resolve();
    await watch.close();
  }
  assert.deepEqual(await snapshotOf(join(directory, 'assets', 'source')), originals);
  assert.deepEqual([...fake.objects], remote);
  assert.equal(fake.requests.length, initialRequests, 'No remote read or write after warmup');
  assert.equal(await readFile(join(directory, 'cratepin-lock.json'), 'utf8'), lock);
  assert.equal(await readFile(join(directory, 'public', 'index.html'), 'utf8'), 'the host page');
  assert.equal(queue.request(), false);
}

async function assertColdMissAndCancellation(directory, fake) {
  const originals = await snapshotOf(join(directory, 'assets', 'source'));
  const rebuild = offlineRebuilder({
    projectRoot: directory,
    cliFile: CLI,
    nodeOptions: ['--import', NETWORK_BLOCK],
  });
  await assert.rejects(
    rebuild(new AbortController().signal),
    /Offline asset command failed \(10\)/u,
  );
  assert.equal(fake.requests.length, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(rebuild(controller.signal), { name: 'AbortError' });
  const missingRoot = offlineRebuilder({
    projectRoot: join(directory, 'absent-root'),
    cliFile: CLI,
  });
  await assert.rejects(missingRoot(new AbortController().signal), { code: 'ENOENT' });
  const sentinelCli = join(directory, 'cancellation-bin.mjs');
  const readyFile = join(directory, 'child-ready');
  await writeFile(
    sentinelCli,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(readyFile)},'ready');setInterval(()=>{},1000);`,
  );
  const activeController = new AbortController();
  const run = offlineRebuilder({ projectRoot: directory, cliFile: sentinelCli })(
    activeController.signal,
  );
  const settled = run.catch((failure) => failure);
  try {
    await until(() => existsSync(readyFile));
  } finally {
    activeController.abort();
    await settled;
  }
  assert.equal((await settled).name, 'AbortError');
  assert.deepEqual(await snapshotOf(join(directory, 'assets', 'source')), originals);
  assert.equal(fake.requests.length, 0);
}

async function assertUnsafeCacheRefused(directory) {
  const cacheRoot = join(directory, '.cratepin-cache');
  const before = await snapshotOf(cacheRoot);
  const configFile = join(directory, 'cratepin.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  await writeFile(configFile, JSON.stringify({ ...config, cacheDir: '../global-cache' }));
  const outside = await runWithoutNetwork(directory, 'build', '--offline', '--json');
  assert.notEqual(outside.status, 0);
  assert.equal(reportOf(outside).error.code, 'CONFIG_INVALID');
  await writeFile(configFile, JSON.stringify({ ...config, projectId: 'another-project' }));
  await writeFile(
    join(directory, 'cratepin-lock.json'),
    JSON.stringify({ schemaVersion: 1, projectId: 'another-project', assets: [] }),
  );
  const foreign = await runWithoutNetwork(directory, 'build', '--offline', '--json');
  assert.equal(foreign.status, 9, foreign.stderr);
  assert.equal(reportOf(foreign).error.code, 'OUTPUT_CONFLICT');
  assert.deepEqual(await snapshotOf(cacheRoot), before);
  assert.equal(await readFile(join(directory, 'public', 'index.html'), 'utf8'), 'the host page');
}

test(
  'directory watch survives atomic pinned-input replacement and serializes real offline CLI builds without a bundler',
  { timeout: 60000 },
  async () => {
    await withProject({ isWarm: true }, assertWatchedOfflineBuilds);
  },
);

test(
  'offline adapter has no auto-push path, rejects a cold cache and settles an aborted child',
  { timeout: 60000 },
  async () => {
    await withProject({ isWarm: false }, assertColdMissAndCancellation);
  },
);

test(
  'generic CLI refuses an external cache and another project cannot adopt a warm cache',
  { timeout: 60000 },
  async () => {
    await withProject({ isWarm: true }, assertUnsafeCacheRefused);
  },
);
