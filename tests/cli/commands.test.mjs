import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { FAKE_CREDENTIALS, FakeS3 } from '../../sources/storage/testing/fake-s3.test-support.ts';
import {
  commitCurrentLock,
  DEFAULT_CONFIG_FILE,
  objectKeyOf,
  runCliAsync,
  runCliIn,
  withTempDirectory,
  writerVariablesFor,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

function issuePathsOf(report) {
  return report.issues.map((issue) => issue.path);
}

test('help lists implemented and planned commands; unknown commands are usage errors', async () => {
  await withTempDirectory((directory) => {
    for (const helpArguments of [[], ['help'], ['--help'], ['hash', '-h']]) {
      const helpRun = runCliIn(directory, ...helpArguments);
      assert.equal(helpRun.status, 0);
      assert.match(helpRun.stdout, /Implemented:[\s\S]*doctor[\s\S]*Planned: remote gc/);
    }
    const plannedRun = runCliIn(directory, 'remote', 'gc');
    assert.equal(plannedRun.status, 3);
    assert.match(plannedRun.stderr, /NOT_IMPLEMENTED/);
    const typoRun = runCliIn(directory, 'frobnicate');
    assert.equal(typoRun.status, 4);
    assert.match(typoRun.stderr, /USAGE/);
    assert.doesNotMatch(typoRun.stderr, /planned/);
  });
});

test('every malformed command line fails with USAGE before touching the filesystem', async () => {
  const malformedCommandLines = [
    ['init', '--bogus'],
    ['init', '-f'],
    ['init', '--force'],
    ['init', 'positional.json'],
    ['init', '--json=yes'],
    ['init', '--config'],
    ['init', '--config', '--json'],
    ['init', '--config', 'a.json', '--config', 'b.json'],
    ['init', '--offline'],
    ['validate', '--dry-run'],
    ['hash'],
    ['hash', 'a', 'b'],
    ['build', '--concurrency', '0'],
    ['build', '--concurrency=65'],
    ['build', '--concurrency', 'four'],
    ['validate', '--config='],
    ['init', '--config='],
    ['cache'],
    ['cache', 'gc'],
    ['remote', 'anything'],
    ['validate', '--bogus', '--help'],
    ['init', '--frob', 'help'],
    ['--bogus', '--help'],
  ];
  await withTempDirectory(async (directory) => {
    for (const commandLine of malformedCommandLines) {
      const usageRun = runCliIn(directory, ...commandLine);
      assert.equal(usageRun.status, 4, commandLine.join(' '));
      assert.match(usageRun.stderr, /USAGE/, commandLine.join(' '));
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

test('init writes once, refuses to overwrite and --dry-run writes nothing', async () => {
  await withTempDirectory(async (directory) => {
    const dryRun = runCliIn(directory, 'init', '--dry-run', '--json');
    assert.equal(dryRun.status, 0);
    assert.equal(JSON.parse(dryRun.stdout).facts.written, false);
    assert.deepEqual(await readdir(directory), []);
    assert.equal(runCliIn(directory, 'init').status, 0);
    const written = await readFile(join(directory, DEFAULT_CONFIG_FILE), 'utf8');
    assert.equal(
      JSON.parse(written).outputUrlPath,
      undefined,
      'the URL path follows outputDir and is never written',
    );
    const overwrite = runCliIn(directory, 'init');
    assert.equal(overwrite.status, 9);
    assert.match(overwrite.stderr, /OUTPUT_CONFLICT/);
    assert.equal(await readFile(join(directory, DEFAULT_CONFIG_FILE), 'utf8'), written);
    assert.equal(runCliIn(directory, 'validate').status, 0);
  });
});

test('a planned command receives dry-run as a real policy', async () => {
  await withTempDirectory((directory) => {
    const cleanupRun = runCliIn(directory, 'remote', 'gc', '--dry-run', '--json');
    assert.equal(cleanupRun.status, 3);
    const cleanupError = JSON.parse(cleanupRun.stderr).error;
    assert.match(cleanupError.message, /"remote gc" is planned/);
    assert.deepEqual(cleanupError.details, { dryRun: true });
  });
});

test('validate resolves paths from the config file, reports issues and missing files distinctly', async () => {
  await withTempDirectory(async (directory) => {
    const configDirectory = join(directory, 'games', 'demo');
    await mkdir(configDirectory, { recursive: true });
    const configFile = join(configDirectory, DEFAULT_CONFIG_FILE);
    await writeFile(configFile, JSON.stringify({ schemaVersion: 1, projectId: 'demo' }));
    const validRun = runCliIn(directory, 'validate', '--config', configFile, '--json');
    assert.equal(validRun.status, 0);
    assert.equal(
      JSON.parse(validRun.stdout).facts.sourceRoot,
      join(configDirectory, 'assets', 'source'),
    );
    await writeFile(configFile, JSON.stringify({ schemaVersion: 2 }));
    const invalidRun = runCliIn(directory, 'validate', '--config', configFile, '--json');
    assert.equal(invalidRun.status, 2);
    const invalidReport = JSON.parse(invalidRun.stderr);
    assert.deepEqual(issuePathsOf(invalidReport), ['/schemaVersion', '/projectId']);
    assert.equal(runCliIn(directory, 'validate', '--config', 'missing.json').status, 10);
  });
});

test('text and JSON output of the same command carry the same facts', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'abc.txt'), 'abc');
    const textRun = runCliIn(directory, 'hash', 'abc.txt');
    const jsonRun = runCliIn(directory, 'hash', 'abc.txt', '--json');
    const { facts } = JSON.parse(jsonRun.stdout);
    assert.equal(facts.bytes, 3);
    for (const [name, value] of Object.entries(facts))
      assert.ok(textRun.stdout.includes(`${name}: ${String(value)}`), name);
  });
});

test('validate rejects a layout where the output root would overwrite the sources', async () => {
  await withTempDirectory(async (directory) => {
    const overlappingConfig = {
      schemaVersion: 1,
      projectId: 'demo',
      sourceDir: 'media',
      outputDir: 'media/out',
      outputUrlPath: 'media/out',
    };
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(overlappingConfig));
    const layoutRun = runCliIn(directory, 'validate', '--json');
    assert.equal(layoutRun.status, 2);
    assert.deepEqual(issuePathsOf(JSON.parse(layoutRun.stderr)), ['/outputDir']);
    assert.deepEqual(await readdir(directory), [DEFAULT_CONFIG_FILE]);
  });
});

test('-- ends options so a file name may start with a dash, and command --help shows help', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, '-dash.txt'), 'abc');
    const dashRun = runCliIn(directory, 'hash', '--json', '--', '-dash.txt');
    assert.equal(dashRun.status, 0);
    assert.equal(JSON.parse(dashRun.stdout).facts.bytes, 3);
    assert.equal(runCliIn(directory, 'hash', '--help').status, 0);
  });
});

test('a relative --config resolves from the working directory, its paths from the config file', async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(join(directory, 'games', 'demo'), { recursive: true });
    const configText = JSON.stringify({ schemaVersion: 1, projectId: 'demo' });
    await writeFile(join(directory, 'games', 'demo', DEFAULT_CONFIG_FILE), configText);
    const relativeConfig = ['games', 'demo', DEFAULT_CONFIG_FILE].join('/');
    const validRun = runCliIn(directory, 'validate', '--config', relativeConfig, '--json');
    assert.equal(validRun.status, 0);
    const expectedSourceRoot = join(directory, 'games', 'demo', 'assets', 'source');
    assert.equal(JSON.parse(validRun.stdout).facts.sourceRoot, expectedSourceRoot);
  });
});

test('init --dry-run predicts the conflict a real run would hit', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), 'existing');
    const dryRun = runCliIn(directory, 'init', '--dry-run');
    assert.equal(dryRun.status, 9);
    assert.match(dryRun.stderr, /OUTPUT_CONFLICT/);
    assert.equal(await readFile(join(directory, DEFAULT_CONFIG_FILE), 'utf8'), 'existing');
  });
});

test('a directory passed as --config is invalid data, not a generic failure', async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(join(directory, 'not-a-file'));
    assert.equal(runCliIn(directory, 'validate', '--config', 'not-a-file').status, 8);
  });
});

test('a credential-shaped profile name never reaches rendered output', async () => {
  const credentialShape = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  await withTempDirectory(async (directory) => {
    const config = {
      schemaVersion: 1,
      projectId: 'demo',
      profiles: { [credentialShape]: { kind: 'copy' } },
    };
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(config));
    for (const outputFlags of [[], ['--json']]) {
      const validateRun = runCliIn(directory, 'validate', ...outputFlags);
      assert.equal(validateRun.status, 2);
      assert.ok(!`${validateRun.stdout}${validateRun.stderr}`.includes(credentialShape));
    }
  });
});

test('--json after -- is a file name, not the output format', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, '--json'), 'abc');
    const textRun = runCliIn(directory, 'hash', '--', '--json');
    assert.equal(textRun.status, 0);
    assert.match(textRun.stdout, /^hash: succeeded/);
  });
});

test('init --dry-run predicts a missing target directory', async () => {
  await withTempDirectory(async (directory) => {
    const dryRun = runCliIn(directory, 'init', '--dry-run', '--config', 'missing/dir/config.json');
    assert.equal(dryRun.status, 10);
    assert.match(dryRun.stderr, /NOT_FOUND/);
  });
});

function sourceSummariesOf(report) {
  return report.facts.assets.map((asset) => `${asset.id} ${asset.path} ${asset.category}`);
}

/** `<ids> <bytes>` per planned object, sorted, e.g. `images/bird 4`. */
function objectSummariesOf(objects) {
  return objects.map((object) => `${object.ids} ${object.bytes}`).toSorted();
}

function issueSummariesOf(issues) {
  return issues.map((issue) => `${issue.code} ${issue.path}`);
}

function issueCodesOf(report) {
  return report.issues.map((issue) => issue.code);
}

async function listTree(directory) {
  return (await readdir(directory, { recursive: true })).toSorted();
}

test('scan lists sorted originals with hashes and writes nothing', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), '{"schemaVersion":1,"projectId":"demo"}');
    await writeSourceTree(directory, {
      'voice/en/hi.mp3': 'hi',
      'images/b.png': 'same',
      'images/a.png': 'same',
      '.env': 'SECRET=never-read',
    });
    const treeBefore = await listTree(directory);
    const scanRun = runCliIn(directory, 'scan', '--json');
    assert.equal(scanRun.status, 0, scanRun.stderr);
    const report = JSON.parse(scanRun.stdout);
    assert.deepEqual(sourceSummariesOf(report), [
      'images/a images/a.png image',
      'images/b images/b.png image',
      'voice/en/hi voice/en/hi.mp3 voice',
    ]);
    assert.equal(report.facts.totalBytes, 10);
    assert.deepEqual(issueCodesOf(report), ['DUPLICATE_CONTENT', 'DUPLICATE_CONTENT']);
    assert.doesNotMatch(scanRun.stdout, /\.env|never-read/);
    const textRun = runCliIn(directory, 'scan');
    assert.match(
      textRun.stdout,
      /- id: images\/a, path: images\/a\.png, mediaType: image\/png, category: image, sha256: [0-9a-f]{64}, bytes: 4/,
    );
    assert.deepEqual(await listTree(directory), treeBefore);
  });
});

test('scan fails with INVALID_DATA for unusable originals and NOT_FOUND without sources', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), '{"schemaVersion":1,"projectId":"demo"}');
    const missingRun = runCliIn(directory, 'scan', '--json');
    assert.equal(missingRun.status, 10);
    await writeSourceTree(directory, { 'voice/en/portrait.png': 'png among voice lines' });
    const invalidRun = runCliIn(directory, 'scan', '--json');
    assert.equal(invalidRun.status, 8);
    const report = JSON.parse(invalidRun.stderr);
    assert.equal(report.error.code, 'INVALID_DATA');
    assert.deepEqual(issueCodesOf(report), ['UNMATCHED_PATTERN', 'CATEGORY_MISMATCH']);
  });
});

async function projectWithCommittedLock(directory) {
  await writeFile(join(directory, DEFAULT_CONFIG_FILE), '{"schemaVersion":1,"projectId":"demo"}');
  await writeSourceTree(directory, {
    'images/cat.png': 'cat',
    'images/dog.png': 'dog',
    'images/sun.png': 'sun',
    'voice/hi.mp3': 'old',
  });
  await commitCurrentLock(directory);
  await rm(join(directory, 'assets', 'source', 'images', 'cat.png'));
  await rm(join(directory, 'assets', 'source', 'images', 'dog.png'));
  await writeSourceTree(directory, {
    'images/kitty.png': 'cat',
    'images/bird.png': 'bird',
    'voice/hi.mp3': 'new',
  });
}

test('scan previews added, changed, removed and renamed IDs against the committed lock', async () => {
  await withTempDirectory(async (directory) => {
    await projectWithCommittedLock(directory);
    const scanRun = runCliIn(directory, 'scan', '--json');
    assert.equal(scanRun.status, 0, scanRun.stderr);
    const { facts, issues } = JSON.parse(scanRun.stdout);
    assert.deepEqual(facts.addedIds, ['images/bird', 'images/kitty']);
    assert.deepEqual(facts.changed, [{ id: 'voice/hi', changedFields: ['sha256', 'objectKey'] }]);
    assert.deepEqual(facts.removedIds, ['images/cat', 'images/dog']);
    assert.deepEqual(facts.identityChanges, [{ fromId: 'images/cat', toId: 'images/kitty' }]);
    assert.equal(facts.unchangedCount, 1);
    assert.deepEqual(issueSummariesOf(issues), ['IDENTITY_CHANGED images/kitty.png']);
  });
});

test('push --dry-run plans uploads with byte counts and changes nothing', async () => {
  await withTempDirectory(async (directory) => {
    await projectWithCommittedLock(directory);
    const treeBefore = await listTree(directory);
    const lockBefore = await readFile(join(directory, 'cratepin-lock.json'), 'utf8');
    const planRun = runCliIn(directory, 'push', '--dry-run', '--json');
    assert.equal(planRun.status, 0, planRun.stderr);
    const { facts } = JSON.parse(planRun.stdout);
    assert.deepEqual(objectSummariesOf(facts.uploads), ['images/bird 4', 'voice/hi 3']);
    assert.equal(facts.uploadBytes, 7);
    assert.equal(facts.alreadyLockedCount, 2);
    assert.equal(facts.keptUnreferencedBytes, 6);
    assert.equal(JSON.parse(planRun.stdout).command, 'push --dry-run');
    assert.deepEqual(objectSummariesOf(facts.keptUnreferenced), ['images/dog 3', 'voice/hi 3']);
    assert.equal(runCliIn(directory, 'push', '--json').status, 8, 'removals need confirmation');
    assert.deepEqual(await listTree(directory), treeBefore);
    assert.equal(await readFile(join(directory, 'cratepin-lock.json'), 'utf8'), lockBefore);
  });
});

test('missing originals, a stale assets entry and an invalid lock stop scan and push', async () => {
  await withTempDirectory(async (directory) => {
    await projectWithCommittedLock(directory);
    await rm(join(directory, 'assets', 'source'), { recursive: true });
    await mkdir(join(directory, 'assets', 'source'));
    const emptyRun = runCliIn(directory, 'push', '--dry-run', '--json');
    assert.equal(emptyRun.status, 8);
    assert.ok(issueSummariesOf(JSON.parse(emptyRun.stderr).issues).includes('SOURCES_MISSING .'));
    await writeFile(
      join(directory, DEFAULT_CONFIG_FILE),
      '{"schemaVersion":1,"projectId":"demo","assets":[{"source":"images/gone.png","id":"gone"}]}',
    );
    await writeSourceTree(directory, { 'images/cat.png': 'cat' });
    const staleRun = runCliIn(directory, 'scan', '--json');
    assert.equal(staleRun.status, 8);
    const staleIssues = issueSummariesOf(JSON.parse(staleRun.stderr).issues);
    assert.ok(staleIssues.includes('MISSING_SOURCE /assets/0/source'));
    await writeFile(
      join(directory, 'cratepin-lock.json'),
      '{"schemaVersion":3,"projectId":"demo"}',
    );
    const futureRun = runCliIn(directory, 'scan', '--json');
    assert.equal(futureRun.status, 8);
    assert.equal(JSON.parse(futureRun.stderr).issues[0].code, 'LOCK_UNSUPPORTED');
  });
});

test('a changed objectPrefix is reported once, with the catalog still listed', async () => {
  await withTempDirectory(async (directory) => {
    await projectWithCommittedLock(directory);
    await writeFile(
      join(directory, DEFAULT_CONFIG_FILE),
      '{"schemaVersion":1,"projectId":"demo","objectPrefix":"assets/v2"}',
    );
    const scanRun = runCliIn(directory, 'scan', '--json');
    assert.equal(scanRun.status, 8);
    const report = JSON.parse(scanRun.stderr);
    assert.deepEqual(issueSummariesOf(report.issues), ['LOCK_INVALID /assets']);
    assert.match(report.issues[0].message, /objectPrefix changed/);
    assert.equal(report.facts.assetCount, 4);
  });
});

function lockedIdsOf(lock) {
  return lock.assets.map((asset) => asset.id);
}

/** The one stored key the committed lock does not reference yet. */
function newestObjectKey(fake, lockText) {
  return [...fake.objects.keys()].find((key) => !lockText.includes(key));
}

test('push needs writer credentials and names only the missing variables', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), '{"schemaVersion":1,"projectId":"demo"}');
    await writeSourceTree(directory, { 'images/a.png': 'a' });
    const run = await runCliAsync(directory, {}, 'push', '--json');
    assert.equal(run.status, 2, run.stderr);
    const report = JSON.parse(run.stderr);
    assert.match(report.error.details.missing, /R2_ENDPOINT, R2_BUCKET, R2_WRITE_ACCESS_KEY_ID/);
    assert.deepEqual(await readdir(directory), ['assets', 'cratepin.config.json']);
  });
});

test('push refuses to drop IDs from the lock without --confirm-removals', async () => {
  await withTempDirectory(async (directory) => {
    await projectWithCommittedLock(directory);
    const lockBefore = await readFile(join(directory, 'cratepin-lock.json'), 'utf8');
    const run = await runCliAsync(directory, {}, 'push', '--json');
    assert.equal(run.status, 8, run.stderr);
    assert.deepEqual(issueCodesOf(JSON.parse(run.stderr)), [
      'REMOVAL_UNCONFIRMED',
      'REMOVAL_UNCONFIRMED',
    ]);
    assert.equal(await readFile(join(directory, 'cratepin-lock.json'), 'utf8'), lockBefore);
  });
});

test('push uploads to storage, writes the lock and leaves nothing to scan', async () => {
  await withTempDirectory(async (directory) => {
    const fake = await FakeS3.start();
    try {
      await writeFile(
        join(directory, DEFAULT_CONFIG_FILE),
        '{"schemaVersion":1,"projectId":"demo"}',
      );
      await writeSourceTree(directory, { 'images/a.png': 'a', 'voice/hi.mp3': 'hi' });
      const run = await runCliAsync(directory, writerVariablesFor(fake), 'push', '--json');
      assert.equal(run.status, 0, run.stderr);
      const report = JSON.parse(run.stdout);
      assert.deepEqual([report.facts.createdCount, report.facts.lockUpdated], [2, true]);
      assert.equal(fake.objects.size, 2);
      assert.ok(!run.stdout.includes(FAKE_CREDENTIALS.secretAccessKey));
      const scan = JSON.parse(runCliIn(directory, 'scan', '--json').stdout);
      assert.deepEqual([scan.facts.addedIds, scan.facts.unchangedCount], [[], 2]);
    } finally {
      await fake.close();
    }
  });
});

test('push with --confirm-removals writes the smaller lock and keeps the dropped objects', async () => {
  await withTempDirectory(async (directory) => {
    const fake = await FakeS3.start();
    try {
      await writeFile(
        join(directory, DEFAULT_CONFIG_FILE),
        '{"schemaVersion":1,"projectId":"demo"}',
      );
      await writeSourceTree(directory, { 'images/a.png': 'a', 'images/b.png': 'b' });
      assert.equal((await runCliAsync(directory, writerVariablesFor(fake), 'push')).status, 0);
      await rm(join(directory, 'assets', 'source', 'images', 'b.png'));
      const run = await runCliAsync(
        directory,
        writerVariablesFor(fake),
        'push',
        '--confirm-removals',
        '--json',
      );
      assert.equal(run.status, 0, run.stderr);
      const lock = JSON.parse(await readFile(join(directory, 'cratepin-lock.json'), 'utf8'));
      assert.deepEqual(lockedIdsOf(lock), ['images/a']);
      assert.equal(JSON.parse(run.stdout).facts.keptUnreferencedKeys.length, 1);
      assert.equal(fake.objects.size, 2);
    } finally {
      await fake.close();
    }
  });
});

test('a failed push reports its unreferenced objects and leaves the lock byte for byte', async () => {
  await withTempDirectory(async (directory) => {
    const fake = await FakeS3.start();
    try {
      await writeFile(
        join(directory, DEFAULT_CONFIG_FILE),
        '{"schemaVersion":1,"projectId":"demo"}',
      );
      await writeSourceTree(directory, { 'images/a.png': 'a' });
      assert.equal((await runCliAsync(directory, writerVariablesFor(fake), 'push')).status, 0);
      const lockBefore = await readFile(join(directory, 'cratepin-lock.json'), 'utf8');
      await writeSourceTree(directory, { 'images/b.png': 'b' });
      fake.failNext({ method: 'GET', status: 403, s3Code: 'AccessDenied', times: 10 });
      const run = await runCliAsync(directory, writerVariablesFor(fake), 'push', '--json');
      assert.equal(run.status, 5, run.stderr);
      const { facts } = JSON.parse(run.stderr);
      assert.equal(facts.lockUpdated, false);
      assert.deepEqual(facts.unreferencedKeys, [newestObjectKey(fake, lockBefore)]);
      assert.equal(await readFile(join(directory, 'cratepin-lock.json'), 'utf8'), lockBefore);
    } finally {
      await fake.close();
    }
  });
});

test('a resolved secret is redacted wherever it appears in the report', async () => {
  await withTempDirectory(async (directory) => {
    const fake = await FakeS3.start();
    try {
      const secretLookingId = 'images/key-0123456789';
      await writeFile(
        join(directory, DEFAULT_CONFIG_FILE),
        '{"schemaVersion":1,"projectId":"demo"}',
      );
      await writeSourceTree(directory, { [`${secretLookingId}.png`]: 'a' });
      const variables = { ...writerVariablesFor(fake), R2_WRITE_ACCESS_KEY_ID: secretLookingId };
      const run = await runCliAsync(directory, variables, 'push', '--json');
      assert.equal(run.status, 5, run.stderr);
      assert.ok(!run.stderr.includes(secretLookingId));
      assert.match(run.stderr, /\[REDACTED\]/);
    } finally {
      await fake.close();
    }
  });
});

test('a repeated push leaves the lock untouched; a failure lists objects found already stored', async () => {
  await withTempDirectory(async (directory) => {
    const fake = await FakeS3.start();
    try {
      await writeFile(
        join(directory, DEFAULT_CONFIG_FILE),
        '{"schemaVersion":1,"projectId":"demo"}',
      );
      await writeSourceTree(directory, { 'images/a.png': 'a' });
      assert.equal((await runCliAsync(directory, writerVariablesFor(fake), 'push')).status, 0);
      const repeat = await runCliAsync(directory, writerVariablesFor(fake), 'push', '--json');
      assert.equal(JSON.parse(repeat.stdout).facts.lockUpdated, false);
      await writeSourceTree(directory, { 'images/b.png': 'b', 'images/c.png': 'c' });
      const storedKey = objectKeyOf('b');
      fake.objects.set(storedKey, Buffer.from('b'));
      fake.failNext({
        method: 'PUT',
        key: objectKeyOf('c'),
        status: 403,
        s3Code: 'AccessDenied',
        times: 10,
      });
      const failed = await runCliAsync(directory, writerVariablesFor(fake), 'push', '--json');
      assert.equal(failed.status, 5, failed.stderr);
      assert.ok(JSON.parse(failed.stderr).facts.unreferencedKeys.includes(storedKey));
    } finally {
      await fake.close();
    }
  });
});

const FIVE_MIB = 5 * 1024 * 1024;

/** Two originals large enough for four parts each, and six small ones, all to be pushed. */
function mixedSizeSources() {
  const sources = {
    'music/long-a.mp3': Buffer.alloc(16 * 1024 * 1024, 1),
    'music/long-b.mp3': Buffer.alloc(16 * 1024 * 1024, 2),
  };
  for (let index = 0; index < 6; index += 1)
    sources[`voice/line-${String(index)}.mp3`] = `ID3 ${String(index)}`;
  return sources;
}

async function pushMixedSizes(directory, fake) {
  const limits = { multipartThresholdBytes: FIVE_MIB, multipartPartBytes: FIVE_MIB };
  await writeFile(
    join(directory, DEFAULT_CONFIG_FILE),
    JSON.stringify({ schemaVersion: 1, projectId: 'demo', limits }),
  );
  await writeSourceTree(directory, mixedSizeSources());
  fake.simulate({ slowQuery: { queryIncludes: 'partNumber', delayMs: 50 } });
  return runCliAsync(directory, writerVariablesFor(fake), 'push', '--concurrency', '2', '--json');
}

test('push keeps --concurrency uploads in flight, multipart parts included', async () => {
  await withTempDirectory(async (directory) => {
    const fake = await FakeS3.start();
    try {
      const run = await pushMixedSizes(directory, fake);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).facts.createdCount, 8);
      assert.ok(fake.maxConcurrentParts <= 2, `parts at once: ${String(fake.maxConcurrentParts)}`);
      assert.ok((fake.maxConcurrentByMethod.get('PUT') ?? 0) <= 2);
      assert.equal(fake.uploads.size, 0, 'every multipart upload was completed');
    } finally {
      await fake.close();
    }
  });
});
