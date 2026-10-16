import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  FAKE_READ_ONLY_CREDENTIALS,
  FakeS3,
} from '../../sources/storage/testing/fake-s3.test-support.ts';

import {
  attemptsIn,
  issueSummariesOf,
  reportOf,
  runWithoutNetwork,
  snapshotOf,
  withProject,
} from '../building/projects.test-support.mjs';
import {
  DEFAULT_CONFIG_FILE,
  objectKeyOf,
  readerVariablesFor,
  runCliAsync,
  runCliWith,
  withTempDirectory,
  writerVariablesFor,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

// How the CLI behaves in the continuous integration a game repository runs: a trusted job holds
// only a read-only key, a fork's job holds no secret at all, and a job may restore the cache an
// earlier job saved. Storage refuses writes signed with the fake's read-only key, as a
// bucket-scoped read-only token makes R2 refuse them.

const NETWORK_BLOCK_URL = new URL('../support/network-block.test-support.mjs', import.meta.url)
  .href;

/** Distinct values no output may ever show: a secret a CI job was given. */
const SENTINELS = {
  R2_READ_ACCESS_KEY_ID: 'sentinel-read-key-id-7f3a',
  R2_READ_SECRET_ACCESS_KEY: 'sentinel-read-secret-9c1e',
  R2_WRITE_ACCESS_KEY_ID: 'sentinel-write-key-id-2b8d',
  R2_WRITE_SECRET_ACCESS_KEY: 'sentinel-write-secret-5e6f',
  GITHUB_TOKEN: 'sentinel-github-token-4a0c',
};

function assertNoSentinel(run) {
  for (const value of Object.values(SENTINELS)) {
    assert.ok(!run.stdout.includes(value), `stdout shows ${value}`);
    assert.ok(!run.stderr.includes(value), `stderr shows ${value}`);
  }
}

function sha256Of(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** The cache files a CI cache step saves: never claims, downloads in progress or quarantine. */
const SAVED_CACHE_PARTS = ['cratepin-cache.json', 'originals', 'derivatives'];

/**
 * Copies what a CI checkout of the project in `from` holds into the new `to`: config, lock and
 * host page but no originals (consumers ignore `assets/source/`), plus the cache parts a CI job
 * saves.
 */
async function restoredCheckout(from, to) {
  for (const name of [DEFAULT_CONFIG_FILE, 'cratepin-lock.json']) {
    await cp(join(from, name), join(to, name), { recursive: true });
  }
  await mkdir(join(to, 'public'));
  await cp(join(from, 'public', 'index.html'), join(to, 'public', 'index.html'));
  for (const name of SAVED_CACHE_PARTS) {
    await cp(join(from, '.cratepin-cache', name), join(to, '.cratepin-cache', name), {
      recursive: true,
    });
  }
}

function isWriteWithReadOnlyKey({ method, accessKeyId }) {
  const isRead = method === 'GET' || method === 'HEAD';
  return !isRead && accessKeyId === FAKE_READ_ONLY_CREDENTIALS.accessKeyId;
}

function isMultipartStart({ method, query }) {
  return method === 'POST' && query.startsWith('uploads');
}

function isUnsignedGet({ method, isSigned }) {
  return method === 'GET' && !isSigned;
}

function isReadOnlyRead({ method, accessKeyId }) {
  const isRead = method === 'GET' || method === 'HEAD';
  return isRead && accessKeyId === FAKE_READ_ONLY_CREDENTIALS.accessKeyId;
}

/**
 * A fresh checkout holding the cache a trusted job saved after reading the originals with the
 * read-only key and building, so it holds derivatives too.
 */
async function withRestoredCheckout(useCheckout) {
  await withProject({ isWarm: true, transport: 's3-readonly' }, (warmed) =>
    withTempDirectory(async (checkout) => {
      assert.equal((await runWithoutNetwork(warmed, 'build', '--offline')).status, 0);
      await restoredCheckout(warmed, checkout);
      await useCheckout(checkout);
    }),
  );
}

const MEBIBYTE = 1024 * 1024;
/** Uploads of at least 5 MiB go in parts, so a 6 MiB original starts a multipart upload. */
const PARTED_LIMITS = { multipartThresholdBytes: 5 * MEBIBYTE, multipartPartBytes: 5 * MEBIBYTE };

/** Pushes `sources` with the fake's read-only key in the writer variables. */
async function pushWithReadOnlyKey(fake, directory, sources) {
  const config = { schemaVersion: 1, projectId: 'demo', limits: PARTED_LIMITS };
  await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(config));
  await writeSourceTree(directory, sources);
  const variables = {
    ...writerVariablesFor(fake),
    R2_WRITE_ACCESS_KEY_ID: FAKE_READ_ONLY_CREDENTIALS.accessKeyId,
    R2_WRITE_SECRET_ACCESS_KEY: FAKE_READ_ONLY_CREDENTIALS.secretAccessKey,
  };
  return runCliAsync(directory, variables, 'push', '--json');
}

for (const [shape, sources] of [
  ['a single upload', { 'voice/hi.mp3': 'ID3 hi' }],
  ['a multipart upload', { 'music/long.mp3': Buffer.alloc(6 * MEBIBYTE, 4) }],
]) {
  test(`a push signed with a read-only key is refused for ${shape} and stores nothing`, async () => {
    const fake = await FakeS3.start();
    try {
      await withTempDirectory(async (directory) => {
        const run = await pushWithReadOnlyKey(fake, directory, sources);
        assert.equal(run.status, 5, run.stderr);
        assert.equal(JSON.parse(run.stderr).error.code, 'AUTH_FAILED');
        assert.deepEqual([fake.objects.size, fake.uploads.size], [0, 0], 'nothing stored or open');
        assert.ok(fake.requests.some(isWriteWithReadOnlyKey), 'storage refused a real write');
        assert.equal(fake.requests.some(isMultipartStart), shape === 'a multipart upload');
        assert.ok(
          !(await readdir(directory)).includes('cratepin-lock.json'),
          'no lock was written',
        );
        const output = run.stdout + run.stderr;
        assert.ok(!output.includes(FAKE_READ_ONLY_CREDENTIALS.secretAccessKey));
      });
    } finally {
      await fake.close();
    }
  });
}

test('a fork build with no secret and a cold cache stops before any request, naming only read variables', async () => {
  await withProject({ isWarm: false, transport: 's3-readonly' }, async (directory, fake) => {
    const publicBefore = await snapshotOf(join(directory, 'public'));
    const run = await runCliAsync(directory, {}, 'build', '--json');
    assert.equal(run.status, 2, run.stderr);
    const { missing } = JSON.parse(run.stderr).error.details;
    assert.match(missing, /R2_READ_ACCESS_KEY_ID/);
    assert.doesNotMatch(missing, /WRITE/);
    assert.deepEqual(fake.requests, []);
    assert.deepEqual(await snapshotOf(join(directory, 'public')), publicBefore);
  });
});

test('a fork build with no secret reads a public bucket unsigned', async () => {
  await withProject({ isWarm: false, transport: 'public-http' }, async (directory, fake) => {
    const run = await runCliAsync(directory, {}, 'build', '--json');
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fake.requests.length > 0);
    assert.ok(fake.requests.every(isUnsignedGet));
  });
});

test('a trusted build reads with the read-only key only, then needs no secret once warm', async () => {
  await withProject({ isWarm: true, transport: 's3-readonly' }, async (directory, fake) => {
    assert.ok(fake.requests.length > 0, 'the warm-up read storage');
    assert.ok(fake.requests.every(isReadOnlyRead));
    const run = await runWithoutNetwork(directory, 'build', '--json');
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(attemptsIn(run), []);
  });
});

test('a restored CI cache builds and verifies offline in a fresh checkout with no secret', async () => {
  await withRestoredCheckout(async (checkout) => {
    const built = await runWithoutNetwork(checkout, 'build', '--offline', '--json');
    assert.equal(built.status, 0, built.stderr);
    assert.equal(reportOf(built).facts.reusedCount, 1, 'the restored derivative is reused');
    const verified = await runWithoutNetwork(checkout, 'verify', '--json');
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual([...attemptsIn(built), ...attemptsIn(verified)], []);
  });
});

test('a restored cache missing one original names only that original, also with secrets set', async () => {
  await withRestoredCheckout(async (checkout) => {
    const sha256 = sha256Of('ID3 hello');
    await rm(join(checkout, '.cratepin-cache', 'originals', 'sha256', sha256));
    const publicBefore = await snapshotOf(join(checkout, 'public'));
    const start = { directory: checkout, variables: SENTINELS };
    const run = await runCliWith(
      { ...start, nodeOptions: ['--import', NETWORK_BLOCK_URL] },
      'build',
      '--offline',
      '--json',
    );
    assert.equal(run.status, 10, run.stderr);
    const report = reportOf(run);
    assert.deepEqual(issueSummariesOf(report), ['CACHE_MISS voice/hu/hello.mp3']);
    assert.ok(report.issues[0].message.includes(sha256), 'the message names the hash');
    assert.deepEqual(await snapshotOf(join(checkout, 'public')), publicBefore);
    assertNoSentinel(run);
  });
});

for (const args of [
  ['pull', '--offline'],
  ['pull', '--offline', '--json'],
  ['build', '--offline'],
  ['build', '--offline', '--json'],
]) {
  test(`a cold ${args.join(' ')} with secrets set shows none of them`, async () => {
    await withProject({ isWarm: false, transport: 's3-readonly' }, async (directory) => {
      const run = await runCliWith(
        { directory, variables: SENTINELS, nodeOptions: ['--import', NETWORK_BLOCK_URL] },
        ...args,
      );
      assert.equal(run.status, 10, run.stderr);
      assert.deepEqual(attemptsIn(run), []);
      assertNoSentinel(run);
    });
  });
}

for (const command of ['pull', 'build']) {
  test(`an online ${command} that misses an original in storage shows no secret it holds`, async () => {
    await withProject({ isWarm: false, transport: 's3-readonly' }, async (directory, fake) => {
      fake.objects.delete(objectKeyOf('ID3 hello'));
      const variables = { ...SENTINELS, ...readerVariablesFor(fake) };
      for (const args of [[command], [command, '--json']]) {
        const run = await runCliAsync(directory, variables, ...args);
        assert.equal(run.status, 10, run.stderr);
        assert.ok((run.stdout + run.stderr).includes('voice/hu/hello'), 'the miss is named');
        assertNoSentinel(run);
        const output = run.stdout + run.stderr;
        assert.ok(!output.includes(FAKE_READ_ONLY_CREDENTIALS.secretAccessKey));
        assert.ok(!output.includes(FAKE_READ_ONLY_CREDENTIALS.accessKeyId));
      }
    });
  });
}

test('a build whose read key storage rejects fails as AUTH_FAILED and shows no secret', async () => {
  await withProject({ isWarm: false, transport: 's3-readonly' }, async (directory, fake) => {
    const variables = {
      ...SENTINELS,
      R2_ENDPOINT: fake.connection.endpoint.href,
      R2_BUCKET: fake.connection.bucket,
    };
    for (const args of [['build'], ['build', '--json']]) {
      const run = await runCliAsync(directory, variables, ...args);
      assert.equal(run.status, 5, run.stderr);
      assertNoSentinel(run);
    }
  });
});
