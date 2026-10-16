import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { FakeS3 } from '../../sources/storage/testing/fake-s3.test-support.ts';

import { offlineBuild, reportOf, withProject } from './projects.test-support.mjs';
import {
  readerVariablesFor,
  runCliAsync,
  startCli,
  withTempDirectory,
  writerVariablesFor,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

// Each test ends a real CLI process abruptly at one file system step (see
// step-at.test-support.mjs), as a crash or power cut would, and proves the next run neither
// trusts what was left half done nor needs a person to clean up, except the claim a crashed run
// leaves (its process ID may be reused at once on Windows).

const STEP_AT_URL = new URL('../support/step-at.test-support.mjs', import.meta.url).href;

/** Runs the CLI in `directory` with `variables`, ended abruptly at the step `crashAt`. */
function runCrashingAt({ directory, variables, crashAt }, ...args) {
  const start = {
    directory,
    variables: { ...variables, STEP_AT: `crash:${crashAt}` },
    nodeOptions: ['--import', STEP_AT_URL],
  };
  return startCli(start, ...args).finished;
}

function isTemporaryLock(name) {
  return name.startsWith('cratepin-lock.json.') && name.endsWith('.tmp');
}

function isPart(name) {
  return name.endsWith('.part');
}

/** Removes every claim the crashed run left, as its error asks a person to. */
async function removeCrashedClaims(directory) {
  const claims = join(directory, '.cratepin-cache', 'claims');
  for (const name of await readdir(claims)) await rm(join(claims, name));
  const outputClaims = join(directory, 'public', '.assets.cratepin', 'claims');
  await rm(outputClaims, { recursive: true, force: true });
}

async function withPushProject(usePush) {
  const fake = await FakeS3.start();
  try {
    await withTempDirectory(async (directory) => {
      await writeSourceTree(directory, { 'images/a.png': 'a', 'voice/hi.mp3': 'hi' });
      await usePush(directory, fake);
    });
  } finally {
    await fake.close();
  }
}

async function writeConfig(directory) {
  await writeFile(
    join(directory, 'cratepin.config.json'),
    '{"schemaVersion":1,"projectId":"demo"}',
  );
}

test('push ended before its lock rename leaves the old lock; the rerun stores nothing twice', async () => {
  await withPushProject(async (directory, fake) => {
    await writeConfig(directory);
    const variables = writerVariablesFor(fake);
    assert.equal((await runCliAsync(directory, variables, 'push')).status, 0);
    const lockPath = join(directory, 'cratepin-lock.json');
    const committed = await readFile(lockPath);
    await writeSourceTree(directory, { 'voice/bye.mp3': 'bye' });
    const crashed = await runCrashingAt(
      {
        directory,
        variables,
        crashAt: String.raw`rename:cratepin-lock\.json\.[^/]*\.tmp -> :before`,
      },
      'push',
    );
    assert.notEqual(crashed.status, 0);
    assert.deepEqual(await readFile(lockPath), committed, 'the committed lock is unchanged');
    const rerun = await runCliAsync(directory, variables, 'push', '--json');
    assert.equal(rerun.status, 0, rerun.stderr);
    const { facts } = JSON.parse(rerun.stdout);
    assert.deepEqual(
      [facts.createdCount, facts.lockUpdated],
      [0, true],
      'stored objects confirmed',
    );
    assert.deepEqual(
      (await readdir(directory)).filter(isTemporaryLock),
      [],
      'the stray lock is gone',
    );
  });
});

test('push ended right after its lock rename has committed; the rerun changes nothing', async () => {
  await withPushProject(async (directory, fake) => {
    await writeConfig(directory);
    const variables = writerVariablesFor(fake);
    const crashed = await runCrashingAt(
      {
        directory,
        variables,
        crashAt: String.raw`rename:cratepin-lock\.json\.[^/]*\.tmp -> :after`,
      },
      'push',
    );
    assert.notEqual(crashed.status, 0);
    const rerun = await runCliAsync(directory, variables, 'push', '--json');
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(JSON.parse(rerun.stdout).facts.lockUpdated, false);
  });
});

test('pull ended before linking a download keeps no entry; the part is only ever pruned', async () => {
  await withProject({ isWarm: false }, async (directory, fake) => {
    const variables = readerVariablesFor(fake);
    const crashed = await runCrashingAt(
      { directory, variables, crashAt: String.raw`link:\.part -> :before` },
      'pull',
    );
    assert.notEqual(crashed.status, 0);
    await removeCrashedClaims(directory);
    assert.equal((await runCliAsync(directory, {}, 'pull', '--offline', '--json')).status, 10);
    assert.equal((await runCliAsync(directory, variables, 'pull', '--json')).status, 0);
    const incoming = join(directory, '.cratepin-cache', 'incoming');
    assert.ok((await readdir(incoming)).some(isPart), 'the crashed part is still there');
    assert.equal((await runCliAsync(directory, {}, 'cache', 'prune', '--json')).status, 0);
    assert.deepEqual((await readdir(incoming)).filter(isPart), []);
  });
});

test('pull ended right after linking a download keeps that verified entry for the next run', async () => {
  await withProject({ isWarm: false }, async (directory, fake) => {
    const variables = readerVariablesFor(fake);
    const crashed = await runCrashingAt(
      { directory, variables, crashAt: String.raw`link:\.part -> :after` },
      'pull',
    );
    assert.notEqual(crashed.status, 0);
    await removeCrashedClaims(directory);
    const rerun = await runCliAsync(directory, variables, 'pull', '--json');
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.ok(JSON.parse(rerun.stdout).facts.cachedCount >= 1, 'the linked entry was reused');
  });
});

function derivativeUseOf({ derivativeUse }) {
  return derivativeUse;
}

test('build ended before a derivative record is linked makes that derivative again', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    const crashed = await runCrashingAt(
      { directory, variables: {}, crashAt: String.raw`link:/derivatives/[^/]*\.json$:before` },
      'build',
      '--offline',
    );
    assert.notEqual(crashed.status, 0);
    await removeCrashedClaims(directory);
    const rebuilt = await offlineBuild(directory);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    const uses = reportOf(rebuilt).facts.assets.map(derivativeUseOf);
    assert.ok(
      uses.includes('remade'),
      `the output without its record was made again: ${uses.join(', ')}`,
    );
  });
});
