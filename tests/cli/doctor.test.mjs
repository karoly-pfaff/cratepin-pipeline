import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  canDenyAccess,
  withReadDenied,
} from '../../sources/catalog/source-fixtures.test-support.ts';

import { attemptsIn, reportOf, withProject } from '../building/projects.test-support.mjs';
import {
  DEFAULT_CONFIG_FILE,
  readerVariablesFor,
  runCliAsync,
  runCliWith,
  withTempDirectory,
  writerVariablesFor,
} from '../support/cli-runs.test-support.mjs';

const VOICE_SHA256 = createHash('sha256').update('ID3 hello').digest('hex');
const PUBLIC_READ = { isWarm: false };
const PRIVATE_READ = { isWarm: false, transport: 's3-readonly' };

function statusesOf(report) {
  return Object.fromEntries(report.facts.checks.map(({ check, status }) => [check, status]));
}

function isRead({ method }) {
  return method === 'GET' || method === 'HEAD';
}

function isSignedHead({ method, isSigned }) {
  return method === 'HEAD' && isSigned;
}

function isReadAccess({ check }) {
  return check === 'read-access';
}

function codesOf(issues) {
  return issues.map(({ code }) => code);
}

function doctor(directory, variables, ...flags) {
  return runCliAsync(directory, variables, 'doctor', '--json', ...flags);
}

async function exitCodeOf(directory, variables, ...flags) {
  return (await doctor(directory, variables, ...flags)).status;
}

const NETWORK_BLOCK = new URL('../support/network-block.test-support.mjs', import.meta.url).href;

/** doctor --offline with every credential variable set, under the network-block preload. */
function offlineWithCredentials(directory, fake) {
  const variables = { ...readerVariablesFor(fake), ...writerVariablesFor(fake) };
  const start = { directory, variables, nodeOptions: ['--import', NETWORK_BLOCK] };
  return runCliWith(start, 'doctor', '--offline', '--json');
}

test('offline doctor resolves no credential and sends no request, also with keys set', async () => {
  await withProject(PRIVATE_READ, async (directory, fake) => {
    const run = await offlineWithCredentials(directory, fake);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(attemptsIn(run), []);
    const report = reportOf(run);
    assert.deepEqual(statusesOf(report), {
      config: 'ok',
      lock: 'ok',
      cache: 'notice',
      output: 'ok',
      'read-access': 'skipped',
      'writer-access': 'skipped',
    });
    assert.equal(report.facts.offline, true);
    assert.equal(report.facts.missingCount, 2);
    assert.deepEqual(fake.requests, []);
    assert.match(report.facts.toolVersion, /^\d+\.\d+\.\d+/);
    assert.match(report.facts.sharp, /^\d+\.\d+\.\d+/);
  });
});

test('a warm cache and a reachable public store pass; doctor only reads', async () => {
  await withProject({ isWarm: true }, async (directory, fake) => {
    const requestsBefore = fake.requests.length;
    const run = await doctor(directory, {});
    assert.equal(run.status, 0, run.stderr);
    const statuses = statusesOf(reportOf(run));
    assert.equal(statuses.cache, 'ok');
    assert.equal(statuses['read-access'], 'ok');
    assert.equal(statuses['writer-access'], 'skipped', 'no writer variable is set');
    assert.ok(fake.requests.slice(requestsBefore).every(isRead), 'doctor never writes');
  });
});

test('online doctor reads a locked original with the read key and checks the writer key', async () => {
  await withProject(PRIVATE_READ, async (directory, fake) => {
    const run = await doctor(directory, {
      ...readerVariablesFor(fake),
      ...writerVariablesFor(fake),
    });
    assert.equal(run.status, 0, run.stderr);
    const report = reportOf(run);
    assert.equal(statusesOf(report)['read-access'], 'ok');
    assert.equal(statusesOf(report)['writer-access'], 'ok');
    assert.match(report.facts.probedKey, /^cratepin\/v1\/projects\/demo\/sources\/sha256\//);
    assert.equal(fake.requests.length, 2, 'one HEAD with the read key, one with the writer key');
    assert.ok(fake.requests.every(isSignedHead));
  });
});

test('an invalid config fails with exit 2 and nothing else is checked', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), '{"schemaVersion":1}');
    const run = await doctor(directory, {});
    assert.equal(run.status, 2);
    const statuses = Object.values(statusesOf(reportOf(run)));
    assert.deepEqual(statuses, ['failed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  });
});

test('missing read variables fail with exit 2, naming the variables only', async () => {
  await withProject(PRIVATE_READ, async (directory) => {
    const run = await doctor(directory, {});
    assert.equal(run.status, 2);
    assert.match(reportOf(run).error.details.missing, /R2_READ_ACCESS_KEY_ID/);
  });
});

test('a rejected key fails with exit 5', async () => {
  await withProject(PRIVATE_READ, async (directory, fake) => {
    const wrongSecret = { R2_READ_SECRET_ACCESS_KEY: 'wrong-secret-0123456789abcdef' };
    assert.equal(await exitCodeOf(directory, { ...readerVariablesFor(fake), ...wrongSecret }), 5);
  });
});

test('storage that keeps failing gives exit 6', async () => {
  await withProject(PUBLIC_READ, async (directory, fake) => {
    fake.failNext({ method: 'HEAD', status: 503, s3Code: 'SlowDown', times: 10 });
    assert.equal(await exitCodeOf(directory, {}), 6);
  });
});

test('a damaged cache entry gives exit 7 with the entry as an issue', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    await writeFile(
      join(directory, '.cratepin-cache', 'originals', 'sha256', VOICE_SHA256),
      'ID3 other',
    );
    const report = reportOf(await doctor(directory, {}, '--offline'));
    assert.equal(report.error.exitCode, 7);
    assert.deepEqual(codesOf(report.issues), ['CACHE_CORRUPT']);
  });
});

test('an invalid lock gives exit 8', async () => {
  await withProject(PUBLIC_READ, async (directory) => {
    await writeFile(join(directory, 'cratepin-lock.json'), '{"schemaVersion":1}');
    assert.equal(await exitCodeOf(directory, {}, '--offline'), 8);
  });
});

test('an output directory the tool does not own gives exit 9', async () => {
  await withProject(PUBLIC_READ, async (directory) => {
    await mkdir(join(directory, 'public', 'assets'));
    await writeFile(join(directory, 'public', 'assets', 'hand-made.png'), 'x');
    const report = reportOf(await doctor(directory, {}, '--offline'));
    assert.equal(report.error.exitCode, 9);
    assert.equal(report.error.details.reason, 'OUTPUT_NOT_OWNED');
  });
});

test('a locked original missing in storage gives exit 10', async () => {
  await withProject(PUBLIC_READ, async (directory, fake) => {
    fake.objects.clear();
    const report = reportOf(await doctor(directory, {}));
    assert.equal(report.error.exitCode, 10);
    assert.equal(statusesOf(report)['read-access'], 'failed');
  });
});

async function doctorWithUnreadableLock(directory) {
  const lockFile = join(directory, 'cratepin-lock.json');
  return reportOf(await withReadDenied([lockFile], () => doctor(directory, {}, '--offline')));
}

test(
  'a lock that cannot be read fails the lock check, and the other checks still run',
  { skip: !canDenyAccess() },
  async () => {
    await withProject(PUBLIC_READ, async (directory) => {
      const report = await doctorWithUnreadableLock(directory);
      assert.equal(report.error.exitCode, 1);
      assert.equal(statusesOf(report).lock, 'failed');
      assert.equal(statusesOf(report).output, 'ok');
    });
  },
);

test('a rejected writer key fails the writer check with exit 5 while reads pass', async () => {
  await withProject(PRIVATE_READ, async (directory, fake) => {
    const wrongWriter = {
      ...writerVariablesFor(fake),
      R2_WRITE_SECRET_ACCESS_KEY: 'wrong-0123456789abcdef',
    };
    const report = reportOf(
      await doctor(directory, { ...readerVariablesFor(fake), ...wrongWriter }),
    );
    assert.equal(report.error.exitCode, 5);
    assert.equal(statusesOf(report)['read-access'], 'ok');
    assert.equal(statusesOf(report)['writer-access'], 'failed');
  });
});

test('one writer variable without the other fails with exit 2, naming the missing one', async () => {
  await withProject(PUBLIC_READ, async (directory, fake) => {
    const halfWriter = { ...writerVariablesFor(fake), R2_WRITE_ACCESS_KEY_ID: '' };
    const report = reportOf(await doctor(directory, halfWriter));
    assert.equal(report.error.exitCode, 2);
    assert.equal(report.error.details.missing, 'R2_WRITE_ACCESS_KEY_ID');
  });
});

test('a stored original of another size than the lock gives exit 7', async () => {
  await withProject(PUBLIC_READ, async (directory, fake) => {
    for (const key of fake.objects.keys()) fake.objects.set(key, Buffer.from('another size'));
    const report = reportOf(await doctor(directory, {}));
    assert.equal(report.error.exitCode, 7);
    assert.equal(statusesOf(report)['read-access'], 'failed');
  });
});

test('without a lock, storage answering is only a notice, not a confirmed store', async () => {
  await withProject(PUBLIC_READ, async (directory) => {
    await rm(join(directory, 'cratepin-lock.json'));
    const run = await doctor(directory, {});
    assert.equal(run.status, 0, run.stderr);
    const statuses = statusesOf(reportOf(run));
    assert.equal(statuses.lock, 'notice');
    assert.equal(statuses.cache, 'skipped');
    assert.equal(statuses['read-access'], 'notice');
  });
});

test('a missing config file is a failed config check with the rest skipped', async () => {
  await withTempDirectory(async (directory) => {
    const report = reportOf(await doctor(directory, {}));
    assert.equal(report.error.exitCode, 10);
    assert.deepEqual(Object.values(statusesOf(report)), [
      'failed',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
  });
});

test('without a lock the writer key is only a notice: a not-found answer confirms nothing', async () => {
  await withProject(PUBLIC_READ, async (directory, fake) => {
    await rm(join(directory, 'cratepin-lock.json'));
    const run = await doctor(directory, writerVariablesFor(fake));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(statusesOf(reportOf(run))['writer-access'], 'notice');
    assert.equal(
      fake.requests.filter(isSignedHead).length,
      1,
      'one HEAD signed with the writer key',
    );
  });
});

test('doctor never claims stored bytes from a HEAD: a same-size other object reads as size only', async () => {
  await withProject(PUBLIC_READ, async (directory, fake) => {
    const first = reportOf(await doctor(directory, {}));
    const key = first.facts.probedKey;
    fake.objects.set(key, Buffer.alloc(fake.objects.get(key).length, 0x21));
    const run = await doctor(directory, {});
    const readAccess = reportOf(run).facts.checks.find(isReadAccess);
    assert.equal(readAccess.status, 'ok');
    assert.match(readAccess.finding, /with its locked size; a HEAD does not read the bytes/u);
    assert.doesNotMatch(readAccess.finding, /holds the locked original/u);
  });
});
