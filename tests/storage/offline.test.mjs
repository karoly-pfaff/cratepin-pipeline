import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { FakeS3 } from '../../sources/storage/testing/fake-s3.test-support.ts';
import {
  commitCurrentLock,
  DEFAULT_CONFIG_FILE,
  objectKeyOf,
  readerVariablesFor,
  runCliAsync,
  runCliWith,
  withTempDirectory,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

const NETWORK_BLOCK_URL = new URL('../support/network-block.test-support.mjs', import.meta.url)
  .href;
const SOURCES = { 'images/cat.png': 'cat', 'images/dog.png': 'dog', 'voice/hi.mp3': 'hi' };

/**
 * Runs the CLI under the network block and with no variable of its own (only PATH and
 * SystemRoot, which Node needs to start).
 */
function runWithoutNetwork(directory, ...args) {
  return runCliWith(
    { directory, variables: {}, nodeOptions: ['--import', NETWORK_BLOCK_URL] },
    ...args,
  );
}

/**
 * With `public-http` a run needs no credential, so any attempt to reach storage gets as far as
 * `fetch` and shows up as NETWORK_ATTEMPT. With `s3-readonly` and no variables, an attempt would
 * stop earlier, at the missing credential variables.
 */
function configFor(transport, fake) {
  const read = { transport: 'public-http', publicBaseUrl: fake.publicBaseUrl.href };
  return {
    schemaVersion: 1,
    projectId: 'demo',
    ...(transport === 'public-http' ? { r2: { read } } : {}),
  };
}

/**
 * A project whose lock pins SOURCES. Only `cachedSources` are in storage, and a normal pull
 * (with the read credentials s3-readonly needs) puts them into the cache before `useProject`.
 */
async function withProject({ transport, cachedSources }, useProject) {
  const fake = await FakeS3.start();
  try {
    await withTempDirectory(async (directory) => {
      await writeFile(
        join(directory, DEFAULT_CONFIG_FILE),
        JSON.stringify(configFor(transport, fake)),
      );
      await writeSourceTree(directory, SOURCES);
      await commitCurrentLock(directory);
      for (const source of cachedSources) {
        fake.objects.set(objectKeyOf(SOURCES[source]), Buffer.from(SOURCES[source]));
      }
      if (cachedSources.length > 0) {
        const warmUp = await runCliAsync(directory, readerVariablesFor(fake), 'pull', '--json');
        assert.equal(jsonReportOf(warmUp).facts.downloadedCount, cachedSources.length);
      }
      await useProject(directory);
    });
  } finally {
    await fake.close();
  }
}

function attemptsIn(run) {
  return run.stderr.split('\n').filter((line) => line.startsWith('NETWORK_ATTEMPT'));
}

/** The --json report: on stdout when it succeeded, otherwise on stderr after any attempt lines. */
function jsonReportOf(run) {
  if (run.status === 0) return JSON.parse(run.stdout);
  const reportLines = run.stderr.split('\n').filter((line) => !line.startsWith('NETWORK_ATTEMPT'));
  return JSON.parse(reportLines.join('\n'));
}

function issueSummariesOf(report) {
  return report.issues.map((issue) => `${issue.code} ${issue.path}`);
}

function sha256Of(text) {
  return createHash('sha256').update(text).digest('hex');
}

const EVERY_SOURCE = Object.keys(SOURCES);

test('a warm cache serves pull online and offline without network or DNS', async () => {
  await withProject(
    { transport: 'public-http', cachedSources: EVERY_SOURCE },
    async (directory) => {
      for (const flags of [['--offline'], []]) {
        const run = await runWithoutNetwork(directory, 'pull', ...flags, '--json');
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(attemptsIn(run), [], flags.join(' '));
        assert.equal(jsonReportOf(run).facts.cachedCount, 3);
      }
    },
  );
});

test('a warm cache needs no credential variable, also with s3-readonly', async () => {
  await withProject(
    { transport: 's3-readonly', cachedSources: EVERY_SOURCE },
    async (directory) => {
      for (const flags of [['--offline'], []]) {
        const run = await runWithoutNetwork(directory, 'pull', ...flags);
        assert.equal(run.status, 0, run.stderr);
      }
    },
  );
});

test('a cold offline pull with s3-readonly and no variables is a cache miss, not a credential error', async () => {
  await withProject({ transport: 's3-readonly', cachedSources: [] }, async (directory) => {
    const run = await runWithoutNetwork(directory, 'pull', '--offline', '--json');
    assert.equal(run.status, 10, run.stderr);
    assert.equal(jsonReportOf(run).error.details.missingCount, 3);
  });
});

test('a cold offline pull lists every missing ID with its locked hash and contacts nothing', async () => {
  await withProject({ transport: 'public-http', cachedSources: [] }, async (directory) => {
    await writeSourceTree(directory, { 'images/cat.png': 'cat, edited since' });
    const run = await runWithoutNetwork(directory, 'pull', '--offline', '--json');
    assert.equal(run.status, 10);
    assert.deepEqual(attemptsIn(run), []);
    const report = jsonReportOf(run);
    assert.deepEqual(issueSummariesOf(report), [
      'CACHE_MISS images/cat.png',
      'CACHE_MISS images/dog.png',
      'CACHE_MISS voice/hi.mp3',
    ]);
    for (const [index, [source, content]] of Object.entries(SOURCES).entries()) {
      const id = source.replace(/\.[a-z0-9]+$/u, '');
      assert.ok(report.issues[index].message.includes(`"${id}" (sha256 ${sha256Of(content)})`), id);
    }
    assert.ok(!report.issues[0].message.includes(sha256Of('cat, edited since')));
    assert.equal(report.error.details.missingCount, 3);
  });
});

test('local sources never stand in for missing cache entries, edited or not', async () => {
  await withProject({ transport: 'public-http', cachedSources: [] }, async (directory) => {
    await writeSourceTree(directory, { 'images/cat.png': 'cat, edited since' });
    const run = await runWithoutNetwork(directory, 'pull', '--offline', '--restore-sources');
    assert.equal(run.status, 10);
    assert.deepEqual(attemptsIn(run), []);
    const entries = await readdir(join(directory, '.cratepin-cache', 'originals', 'sha256'));
    assert.deepEqual(entries, [], 'nothing was copied from the source directory');
    const cat = join(directory, 'assets', 'source', 'images', 'cat.png');
    assert.equal(await readFile(cat, 'utf8'), 'cat, edited since');
    assert.deepEqual((await readdir(directory)).toSorted(), [
      '.cratepin-cache',
      'assets',
      'cratepin-lock.json',
      'cratepin.config.json',
    ]);
  });
});

test('a mixed cache reports only the misses; the hits stay verified', async () => {
  const project = { transport: 'public-http', cachedSources: ['images/dog.png'] };
  await withProject(project, async (directory) => {
    const run = await runWithoutNetwork(directory, 'pull', '--offline', '--json');
    assert.equal(run.status, 10);
    const report = jsonReportOf(run);
    assert.deepEqual(issueSummariesOf(report), [
      'CACHE_MISS images/cat.png',
      'CACHE_MISS voice/hi.mp3',
    ]);
    assert.equal(report.facts.cachedCount, 1);
    assert.deepEqual(attemptsIn(run), []);
  });
});

test('control: an online pull with a cold cache reaches for the network and is blocked', async () => {
  await withProject({ transport: 'public-http', cachedSources: [] }, async (directory) => {
    const run = await runWithoutNetwork(directory, 'pull');
    assert.notEqual(run.status, 0);
    assert.ok(attemptsIn(run).length > 0, 'the block is in effect');
  });
});

/** Each way a dependency could reach the network, called under the block. */
const NETWORK_CALLS = `
const dns = require('node:dns');
const calls = [
  () => fetch('https://example.com/'),
  () => require('node:net').connect(443, 'example.com'),
  () => require('node:tls').connect(443, 'example.com'),
  () => require('node:https').get('https://example.com/'),
  () => require('node:http').request('http://example.com/'),
  () => dns.lookup('example.com', () => {}),
  () => dns.resolveTxt('example.com', () => {}),
  () => new dns.Resolver().resolve4('example.com', () => {}),
  () => dns.promises.lookup('example.com'),
  () => new dns.promises.Resolver().resolveMx('example.com'),
];
for (const call of calls) {
  try { Promise.resolve(call()).catch(() => {}); } catch {}
}
`;

test('control: the block catches fetch, sockets, TLS, HTTP(S) and every DNS route', () => {
  const run = spawnSync(process.execPath, ['--import', NETWORK_BLOCK_URL, '-e', NETWORK_CALLS], {
    encoding: 'utf8',
  });
  assert.equal(attemptsIn(run).length, 10, run.stderr);
});
