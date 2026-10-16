import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  canDenyAccess,
  withReadDenied,
} from '../../sources/catalog/source-fixtures.test-support.ts';
import { FakeS3 } from '../../sources/storage/testing/fake-s3.test-support.ts';
import {
  commitCurrentLock,
  DEFAULT_CONFIG_FILE,
  objectKeyOf,
  readerVariablesFor,
  runCliAsync,
  withTempDirectory,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

const SOURCES = { 'images/cat.png': 'cat', 'images/dog.png': 'dog', 'voice/hi.mp3': 'hi' };
const SHA256_OF_CAT = '77af778b51abd4a3c51c5ddd97204a9c3ae614ebccb75a606c3b6865aed6744e';

/** A project whose committed lock pins SOURCES and whose storage holds their bytes. */
async function pushedProject(directory, fake, read) {
  const config = { schemaVersion: 1, projectId: 'demo', ...(read ? { r2: { read } } : {}) };
  await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(config));
  await writeSourceTree(directory, SOURCES);
  await commitCurrentLock(directory);
  for (const content of Object.values(SOURCES)) {
    fake.objects.set(objectKeyOf(content), Buffer.from(content));
  }
}

function publicRead(fake) {
  return { transport: 'public-http', publicBaseUrl: fake.publicBaseUrl.href };
}

async function withFake(useFake) {
  const fake = await FakeS3.start();
  try {
    await withTempDirectory((directory) => useFake(fake, directory));
  } finally {
    await fake.close();
  }
}

async function cachedNamesIn(directory) {
  return readdir(join(directory, '.cratepin-cache', 'originals', 'sha256')).catch(() => []);
}

function isUnsignedGet(request) {
  return request.method === 'GET' && !request.isSigned;
}

function isSigned(request) {
  return request.isSigned;
}

function requestedKeysOf(fake) {
  return fake.requests.map((request) => request.key).toSorted();
}

function idsToDownloadOf(facts) {
  return facts.wouldDownload.map((object) => object.ids.join()).toSorted();
}

function isDownloadFailure(code) {
  return code === 'DOWNLOAD_FAILED';
}

function issueCodesOf(report) {
  return report.issues.map((issue) => issue.code);
}

function issueSummariesOf(report) {
  return report.issues.map((issue) => `${issue.code} ${issue.path}`);
}

test('public-http pull needs no credential and fills the cache with verified originals', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    const first = await runCliAsync(directory, {}, 'pull', '--json');
    assert.equal(first.status, 0, first.stderr);
    const facts = JSON.parse(first.stdout).facts;
    assert.equal(facts.downloadedCount, 3);
    assert.equal(facts.downloadedBytes, 8);
    assert.equal((await cachedNamesIn(directory)).length, 3);
    const cat = join(directory, '.cratepin-cache', 'originals', 'sha256', SHA256_OF_CAT);
    assert.equal(await readFile(cat, 'utf8'), 'cat');
    assert.ok(fake.requests.every(isUnsignedGet));
    assert.deepEqual(
      requestedKeysOf(fake),
      Object.values(SOURCES).map(objectKeyOf).toSorted(),
      'exact locked keys only, never a listing',
    );
    const second = await runCliAsync(directory, {}, 'pull', '--json');
    assert.equal(JSON.parse(second.stdout).facts.cachedCount, 3);
    assert.equal(fake.requests.length, 3, 'a warm cache sends no request');
  });
});

test('s3-readonly pull resolves only the read-only pair, and only on a cache miss', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake);
    const withoutVariables = await runCliAsync(directory, {}, 'pull', '--json');
    assert.equal(withoutVariables.status, 2);
    const missing = JSON.parse(withoutVariables.stderr).error.details.missing;
    assert.match(missing, /R2_READ_ACCESS_KEY_ID/);
    assert.doesNotMatch(missing, /WRITE/);
    const pulled = await runCliAsync(directory, readerVariablesFor(fake), 'pull', '--json');
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.ok(fake.requests.every(isSigned));
    const warm = await runCliAsync(directory, {}, 'pull', '--json');
    assert.equal(warm.status, 0, 'a warm cache needs no credential');
  });
});

test('every original that cannot be retrieved is listed by ID and hash', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    fake.objects.delete(objectKeyOf('dog'));
    fake.objects.set(objectKeyOf('hi'), Buffer.from('ho'));
    fake.failNext({
      method: 'GET',
      key: objectKeyOf('cat'),
      status: 403,
      s3Code: 'Denied',
      times: 5,
    });
    const run = await runCliAsync(directory, {}, 'pull', '--json');
    assert.equal(run.status, 5, 'the first failed ID, images/cat, was refused');
    const report = JSON.parse(run.stderr);
    assert.deepEqual(issueSummariesOf(report), [
      'OBJECT_FORBIDDEN images/cat.png',
      'OBJECT_MISSING images/dog.png',
      'OBJECT_CORRUPT voice/hi.mp3',
    ]);
    assert.match(
      report.issues[0].message,
      new RegExp(`"images/cat" \\(sha256 ${SHA256_OF_CAT}\\)`),
    );
    assert.equal(report.error.details.failedCount, 3);
    assert.deepEqual(await cachedNamesIn(directory), []);
    assert.deepEqual(await readdir(join(directory, '.cratepin-cache', 'incoming')), []);
  });
});

test('pull --dry-run lists what it would download and touches nothing', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    const run = await runCliAsync(directory, {}, 'pull', '--dry-run', '--json');
    assert.equal(run.status, 0, run.stderr);
    const facts = JSON.parse(run.stdout).facts;
    assert.equal(facts.wouldDownloadBytes, 8);
    assert.deepEqual(idsToDownloadOf(facts), ['images/cat', 'images/dog', 'voice/hi']);
    assert.deepEqual(fake.requests, []);
    assert.equal((await readdir(directory)).includes('.cratepin-cache'), false);
  });
});

test('--restore-sources fills a fresh checkout and never replaces an edited source', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    await rm(join(directory, 'assets', 'source'), { recursive: true });
    const fresh = await runCliAsync(directory, {}, 'pull', '--restore-sources', '--json');
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(JSON.parse(fresh.stdout).facts.restoredSources, Object.keys(SOURCES));
    await writeSourceTree(directory, { 'images/cat.png': 'cat in progress' });
    await rm(join(directory, 'assets', 'source', 'voice', 'hi.mp3'));
    const again = await runCliAsync(directory, {}, 'pull', '--restore-sources', '--json');
    const report = JSON.parse(again.stdout);
    assert.deepEqual(report.facts.restoredSources, ['voice/hi.mp3']);
    assert.deepEqual(report.facts.keptSources, ['images/cat.png']);
    assert.deepEqual(issueSummariesOf(report), ['SOURCE_KEPT images/cat.png']);
    const cat = join(directory, 'assets', 'source', 'images', 'cat.png');
    assert.equal(await readFile(cat, 'utf8'), 'cat in progress');
  });
});

test('pull --offline sends nothing: a cold cache lists every missing ID and hash', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    const cold = await runCliAsync(directory, {}, 'pull', '--offline', '--json');
    assert.equal(cold.status, 10);
    const report = JSON.parse(cold.stderr);
    assert.deepEqual(issueCodesOf(report), ['CACHE_MISS', 'CACHE_MISS', 'CACHE_MISS']);
    assert.equal(report.error.details.missingCount, 3);
    assert.deepEqual(fake.requests, []);
    assert.equal((await runCliAsync(directory, {}, 'pull')).status, 0);
    const warm = await runCliAsync(directory, {}, 'pull', '--offline', '--json');
    assert.equal(warm.status, 0, warm.stderr);
    assert.equal(fake.requests.length, 3, 'only the online pull sent requests');
  });
});

test('a corrupt cache entry is quarantined and fetched again', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    assert.equal((await runCliAsync(directory, {}, 'pull')).status, 0);
    const cat = join(directory, '.cratepin-cache', 'originals', 'sha256', SHA256_OF_CAT);
    await writeFile(cat, 'tac');
    const run = await runCliAsync(directory, {}, 'pull', '--json');
    const report = JSON.parse(run.stdout);
    assert.deepEqual(issueSummariesOf(report), ['CACHE_CORRUPT images/cat.png']);
    assert.equal(report.facts.quarantinedCount, 1);
    assert.equal(await readFile(cat, 'utf8'), 'cat');
  });
});

test('pull needs a valid committed lock', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), '{"schemaVersion":1,"projectId":"demo"}');
    const absent = await runCliAsync(directory, {}, 'pull', '--json');
    assert.equal(absent.status, 10);
    await writeFile(join(directory, 'cratepin-lock.json'), '{"schemaVersion":1}');
    const invalid = await runCliAsync(directory, {}, 'pull', '--json');
    assert.equal(invalid.status, 8);
    assert.ok(JSON.parse(invalid.stderr).issues.length > 0);
  });
});

test('pull --dry-run predicts offline misses and source restores, still writing nothing', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    const offline = await runCliAsync(
      directory,
      {},
      ...['pull', '--dry-run', '--offline', '--restore-sources', '--json'],
    );
    assert.equal(offline.status, 10);
    const offlineReport = JSON.parse(offline.stderr);
    assert.equal(offlineReport.facts.wouldDownload, undefined, 'offline downloads nothing');
    assert.equal(offlineReport.facts.wouldRestoreSources, undefined, 'and restores nothing');
    assert.ok(issueSummariesOf(offlineReport).includes('RESTORE_SKIPPED .'));
    assert.deepEqual(issueCodesOf(offlineReport), [
      'RESTORE_SKIPPED',
      'CACHE_MISS',
      'CACHE_MISS',
      'CACHE_MISS',
    ]);
    assert.equal((await runCliAsync(directory, {}, 'pull')).status, 0);
    await rm(join(directory, 'assets', 'source', 'images'), { recursive: true });
    const restore = await runCliAsync(
      directory,
      {},
      'pull',
      '--dry-run',
      '--restore-sources',
      '--json',
    );
    const facts = JSON.parse(restore.stdout).facts;
    assert.deepEqual(facts.wouldRestoreSources, ['images/cat.png', 'images/dog.png']);
    assert.equal(facts.unchangedSourceCount, 1);
    assert.deepEqual(await readdir(join(directory, 'assets', 'source')), ['voice']);
  });
});

test('a transfer that keeps failing is listed as DOWNLOAD_FAILED and is retryable', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    fake.failNext({
      method: 'GET',
      key: objectKeyOf('dog'),
      status: 503,
      s3Code: 'Busy',
      times: 10,
    });
    const run = await runCliAsync(directory, {}, 'pull', '--json');
    assert.equal(run.status, 6);
    const report = JSON.parse(run.stderr);
    assert.deepEqual(issueSummariesOf(report), ['DOWNLOAD_FAILED images/dog.png']);
    assert.equal(report.error.isRetryable, true);
    assert.equal(report.facts.downloadedCount, 2);
  });
});

test('a plain pull never touches the source directory', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    await rm(join(directory, 'assets', 'source', 'images', 'cat.png'));
    await writeSourceTree(directory, { 'images/dog.png': 'dog, edited' });
    assert.equal((await runCliAsync(directory, {}, 'pull')).status, 0);
    assert.deepEqual(await readdir(join(directory, 'assets', 'source', 'images')), ['dog.png']);
    const dog = join(directory, 'assets', 'source', 'images', 'dog.png');
    assert.equal(await readFile(dog, 'utf8'), 'dog, edited');
  });
});

test('sources are not restored while any original is missing, and the report says so', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    await rm(join(directory, 'assets', 'source'), { recursive: true });
    const run = await runCliAsync(
      directory,
      {},
      'pull',
      '--offline',
      '--restore-sources',
      '--json',
    );
    assert.equal(run.status, 10);
    assert.ok(issueSummariesOf(JSON.parse(run.stderr)).includes('RESTORE_SKIPPED .'));
    assert.equal((await readdir(join(directory, 'assets'))).includes('source'), false);
  });
});

test('a restore that stops still reports what is cached', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    await rm(join(directory, 'assets', 'source'), { recursive: true });
    await writeSourceTree(directory, { images: 'a file where a directory belongs' });
    const run = await runCliAsync(directory, {}, 'pull', '--restore-sources', '--json');
    assert.equal(run.status, 9);
    const report = JSON.parse(run.stderr);
    assert.equal(report.error.code, 'OUTPUT_CONFLICT');
    assert.equal(report.facts.downloadedCount, 3);
    assert.deepEqual(report.facts.restoredSources, []);
  });
});

test('s3-readonly downloads are verified like public ones', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake);
    fake.objects.set(objectKeyOf('hi'), Buffer.from('ho'));
    const run = await runCliAsync(directory, readerVariablesFor(fake), 'pull', '--json');
    assert.equal(run.status, 7);
    assert.deepEqual(issueSummariesOf(JSON.parse(run.stderr)), ['OBJECT_CORRUPT voice/hi.mp3']);
  });
});

test('every ID sharing a missing object is listed', async () => {
  await withFake(async (fake, directory) => {
    const config = { schemaVersion: 1, projectId: 'demo', r2: { read: publicRead(fake) } };
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(config));
    await writeSourceTree(directory, { 'images/a.png': 'same', 'images/b.png': 'same' });
    await commitCurrentLock(directory);
    const run = await runCliAsync(directory, {}, 'pull', '--json');
    assert.equal(run.status, 10);
    assert.deepEqual(issueSummariesOf(JSON.parse(run.stderr)), [
      'OBJECT_MISSING images/a.png',
      'OBJECT_MISSING images/b.png',
    ]);
    assert.equal(JSON.parse(run.stderr).error.details.failedCount, 1);
  });
});

test('a storage address that redirects fails the pull as a configuration problem', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    const location = 'http://127.0.0.1:9/elsewhere';
    fake.failNext({ method: 'GET', status: 301, s3Code: 'Moved', location, times: 10 });
    const run = await runCliAsync(directory, {}, 'pull', '--concurrency', '1', '--json');
    assert.equal(run.status, 2);
    const report = JSON.parse(run.stderr);
    assert.equal(report.error.code, 'CONFIG_INVALID');
    assert.ok(issueCodesOf(report).every(isDownloadFailure));
    assert.match(report.issues[0].message, /publicBaseUrl/);
  });
});

test(
  'a source that cannot be read while planning the restore keeps the pull facts',
  {
    skip: !canDenyAccess(),
  },
  async () => {
    await withFake(async (fake, directory) => {
      await pushedProject(directory, fake, publicRead(fake));
      const cat = join(directory, 'assets', 'source', 'images', 'cat.png');
      const pullAndRestore = runCliAsync.bind(
        undefined,
        directory,
        {},
        'pull',
        '--restore-sources',
        '--json',
      );
      const run = await withReadDenied([cat], pullAndRestore);
      assert.equal(run.status, 1);
      const report = JSON.parse(run.stderr);
      assert.equal(report.facts.downloadedCount, 3);
      assert.deepEqual(report.facts.restoredSources, []);
    });
  },
);

function isSizeIssue({ path }) {
  return path.endsWith('/bytes');
}

test('a locked original larger than limits.maxSourceBytes stops pull before any request', async () => {
  await withFake(async (fake, directory) => {
    await pushedProject(directory, fake, publicRead(fake));
    const config = JSON.parse(await readFile(join(directory, DEFAULT_CONFIG_FILE), 'utf8'));
    const smaller = { ...config, limits: { maxSourceBytes: 2 } };
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(smaller));
    const run = await runCliAsync(directory, {}, 'pull', '--json');
    assert.equal(run.status, 8);
    assert.ok(JSON.parse(run.stderr).issues.some(isSizeIssue));
    assert.deepEqual(fake.requests, []);
  });
});

/** A pushed project with `count` small originals, each its own object. */
async function manyOriginalsProject(directory, fake, count) {
  const config = { schemaVersion: 1, projectId: 'demo', r2: { read: publicRead(fake) } };
  await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(config));
  const sources = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `voice/line-${String(index)}.mp3`,
      `ID3 ${String(index)}`,
    ]),
  );
  await writeSourceTree(directory, sources);
  await commitCurrentLock(directory);
  for (const content of Object.values(sources))
    fake.objects.set(objectKeyOf(content), Buffer.from(content));
}

test('a cold pull keeps at most --concurrency downloads in flight', async () => {
  await withFake(async (fake, directory) => {
    await manyOriginalsProject(directory, fake, 24);
    fake.simulate({ responseDelayMs: 30 });
    const run = await runCliAsync(directory, {}, 'pull', '--concurrency', '3', '--json');
    assert.equal(run.status, 0, run.stderr);
    const peak = fake.maxConcurrentByMethod.get('GET');
    assert.ok(peak !== undefined && peak >= 2 && peak <= 3, `peak ${String(peak)}`);
  });
});

function isDownload({ method }) {
  return method === 'GET';
}

test('a persistent failure is tried exactly transferAttempts times per original', async () => {
  await withFake(async (fake, directory) => {
    await manyOriginalsProject(directory, fake, 8);
    const config = JSON.parse(await readFile(join(directory, DEFAULT_CONFIG_FILE), 'utf8'));
    const twoAttempts = { ...config, limits: { transferAttempts: 2 } };
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(twoAttempts));
    fake.failNext({ method: 'GET', status: 503, s3Code: 'Busy', times: 100 });
    const run = await runCliAsync(directory, {}, 'pull', '--concurrency', '4', '--json');
    assert.equal(run.status, 6);
    assert.equal(fake.requests.filter(isDownload).length, 16);
    assert.deepEqual(await readdir(join(directory, '.cratepin-cache', 'incoming')), []);
    assert.deepEqual(await readdir(join(directory, '.cratepin-cache', 'claims')), []);
  });
});
