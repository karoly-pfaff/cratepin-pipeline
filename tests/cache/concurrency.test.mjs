import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { FakeS3 } from '../../sources/storage/testing/fake-s3.test-support.ts';
import {
  commitCurrentLock,
  DEFAULT_CONFIG_FILE,
  objectKeyOf,
  runCliAsync,
  runCliWith,
  withTempDirectory,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

/** Three originals the project locks and storage holds. */
const SOURCES = {
  'images/cat.png': 'c'.repeat(2048),
  'images/dog.png': 'd'.repeat(2048),
  'voice/hi.mp3': 'h'.repeat(2048),
};
const CLAIM_PROCESS_URL = new URL('../support/claim-process.test-support.mjs', import.meta.url)
  .href;

function pullWithLiveness(directory, isLive) {
  return runCliWith(
    {
      directory,
      variables: { CLAIM_FIXTURE_PID: String(process.pid), CLAIM_FIXTURE_IS_LIVE: String(isLive) },
      nodeOptions: ['--import', CLAIM_PROCESS_URL],
    },
    'pull',
    '--json',
  );
}

function assertProbeUsed(run, status) {
  assert.equal(run.status, status, run.stderr);
  assert.match(run.stderr, /CLAIM_PROBE_COUNT=[1-9]\d*/u);
}

async function withPushedProject(useProject) {
  const fake = await FakeS3.start();
  try {
    await withTempDirectory(async (directory) => {
      const read = { transport: 'public-http', publicBaseUrl: fake.publicBaseUrl.href };
      const config = { schemaVersion: 1, projectId: 'demo', r2: { read } };
      await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(config));
      await writeSourceTree(directory, SOURCES);
      await commitCurrentLock(directory);
      for (const content of Object.values(SOURCES)) {
        fake.objects.set(objectKeyOf(content), Buffer.from(content));
      }
      await useProject(fake, directory);
    });
  } finally {
    await fake.close();
  }
}

function cacheDirectory(directory, ...names) {
  return join(directory, '.cratepin-cache', ...names);
}

/** Writes the claim file a prune with process `pid` on this host would hold. */
async function writePruneClaim(directory, pid) {
  const owner = {
    pid,
    host: hostname(),
    command: 'cache prune',
    startedAt: new Date().toISOString(),
  };
  const file = cacheDirectory(directory, 'claims', `prune-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(owner));
  return file;
}

// Two pulls publishing one entry are interleaved at a named step in interleavings.test.mjs.

test('a pull refuses a real live prune and a reported reused PID, but accepts explicit ESRCH', async () => {
  await withPushedProject(async (_fake, directory) => {
    assert.equal((await runCliAsync(directory, {}, 'pull')).status, 0);
    const prune = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    let liveClaim;
    try {
      liveClaim = await writePruneClaim(directory, prune.pid);
      const refused = await runCliAsync(directory, {}, 'pull', '--json');
      assert.equal(refused.status, 9);
      assert.equal(JSON.parse(refused.stderr).error.details.claimFile, liveClaim);
      assert.deepEqual(await readdir(cacheDirectory(directory, 'claims')), [basename(liveClaim)]);
    } finally {
      // Wait until it has exited: a process still shutting down counts as live.
      const exited = once(prune, 'exit');
      prune.kill();
      await exited;
    }
    await rm(liveClaim);
    const deadClaim = await writePruneClaim(directory, process.pid);
    assertProbeUsed(await pullWithLiveness(directory, true), 9);
    const after = await pullWithLiveness(directory, false);
    assertProbeUsed(after, 0);
    assert.equal(JSON.parse(after.stdout).facts.cachedCount, 3);
    assert.deepEqual(await readdir(cacheDirectory(directory, 'claims')), [basename(deadClaim)]);
  });
});
