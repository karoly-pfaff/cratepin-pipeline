import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  pngOf,
  transparentArtwork,
} from '../../sources/media/testing/media-fixtures.test-support.ts';
import { FakeS3 } from '../../sources/storage/testing/fake-s3.test-support.ts';
import {
  commitCurrentLock,
  DEFAULT_CONFIG_FILE,
  objectKeyOf,
  readerVariablesFor,
  runCliAsync,
  runCliWith,
  startCli,
  withTempDirectory,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

const NETWORK_BLOCK_URL = new URL('../support/network-block.test-support.mjs', import.meta.url)
  .href;

export function runWithoutNetwork(directory, ...args) {
  return runCliWith(
    { directory, variables: {}, nodeOptions: ['--import', NETWORK_BLOCK_URL] },
    ...args,
  );
}

async function sourcesOf() {
  return {
    'app/ui/button.png': await pngOf(transparentArtwork(9, 9)),
    'voice/hu/hello.mp3': 'ID3 hello',
  };
}

function configFor(fake, { transport, outputMode }) {
  return {
    schemaVersion: 1,
    projectId: 'demo',
    outputMode,
    ...(transport === 'public-http'
      ? { r2: { read: { transport, publicBaseUrl: fake.publicBaseUrl.href } } }
      : {}),
    profiles: { 'ui-strict': { kind: 'image', webp: { lossless: true, keepSmaller: false } } },
    profileRules: [{ match: 'app/ui/**', profile: 'ui-strict' }],
  };
}

/** Writes the config, a host page in `public/`, the sources and their lock; storage gets them. */
async function writeProject(directory, fake, settings) {
  const sources = await sourcesOf();
  await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(configFor(fake, settings)));
  await mkdir(join(directory, 'public'));
  await writeFile(join(directory, 'public', 'index.html'), 'the host page');
  await writeSourceTree(directory, sources);
  await commitCurrentLock(directory);
  for (const content of Object.values(sources))
    fake.objects.set(objectKeyOf(content), Buffer.from(content));
}

/**
 * A project whose lock pins the sources, with a host page in `public/`; with `isWarm`, a pull with
 * the read-only key has filled the cache. With `transport: 's3-readonly'` reading storage needs
 * credential variables, which no later run here gets unless a test passes them; `outputMode` is
 * the config's. `useProject` gets the directory and the fake storage holding the sources.
 */
export async function withProject(
  { isWarm, transport = 'public-http', outputMode = 'path-preserving' },
  useProject,
) {
  const fake = await FakeS3.start();
  try {
    await withTempDirectory(async (directory) => {
      await writeProject(directory, fake, { transport, outputMode });
      if (isWarm) {
        const warmUp = await runCliAsync(directory, readerVariablesFor(fake), 'pull', '--json');
        assert.equal(warmUp.status, 0, warmUp.stderr);
      }
      await useProject(directory, fake);
    });
  } finally {
    await fake.close();
  }
}

/** Every entry below `directory`: directories by name, files with the SHA-256 of their bytes. */
export async function snapshotOf(directory) {
  const names = await readdir(directory, { recursive: true, withFileTypes: true });
  const directories = names
    .filter((entry) => !entry.isFile())
    .map((entry) => [join(entry.parentPath, entry.name), 'directory']);
  const files = names
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const hashes = await Promise.all(
    files.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ]),
  );
  return Object.fromEntries(
    [...directories, ...hashes].toSorted(([left], [right]) => (left < right ? -1 : 1)),
  );
}

export function issueSummariesOf(report) {
  return report.issues.map((issue) => `${issue.code} ${issue.path}`);
}

export function attemptsIn(run) {
  return run.stderr.split('\n').filter((line) => line.startsWith('NETWORK_ATTEMPT'));
}

export function reportOf(run) {
  if (run.status === 0) return JSON.parse(run.stdout);
  return JSON.parse(
    run.stderr
      .split('\n')
      .filter((line) => !line.startsWith('NETWORK_ATTEMPT'))
      .join('\n'),
  );
}

export function offlineBuild(directory) {
  return runWithoutNetwork(directory, 'build', '--offline', '--json');
}

/** A file next to the output that no build may touch. */
export async function writeSentinel(directory) {
  await mkdir(join(directory, 'public', 'other'));
  await writeFile(join(directory, 'public', 'other', 'keep.txt'), 'keep');
}

export async function assertSentinelsKept(directory) {
  assert.equal(await readFile(join(directory, 'public', 'index.html'), 'utf8'), 'the host page');
  assert.equal(await readFile(join(directory, 'public', 'other', 'keep.txt'), 'utf8'), 'keep');
}

/** The lock texts with both sources and with the voice line removed, as two releases. */
export async function twoReleases(directory) {
  const lockFile = join(directory, 'cratepin-lock.json');
  const full = await readFile(lockFile, 'utf8');
  await rm(join(directory, 'assets', 'source', 'voice'), { recursive: true });
  await commitCurrentLock(directory);
  const smaller = await readFile(lockFile, 'utf8');
  return {
    useFull: () => writeFile(lockFile, full),
    useSmaller: () => writeFile(lockFile, smaller),
  };
}

const STEP_AT_URL = new URL('../support/step-at.test-support.mjs', import.meta.url).href;

/**
 * Builds offline, ended abruptly at `step` as a crash would, e.g. `rename:/staging -> :after`
 * (see step-at.test-support.mjs).
 */
export function buildCrashingAt(directory, step) {
  return startCli(
    {
      directory,
      variables: { STEP_AT: `crash:${step}` },
      nodeOptions: ['--import', STEP_AT_URL],
    },
    'build',
    '--offline',
    '--json',
  ).finished;
}

/**
 * Removes the claim a crashed build left, as its error asks a person to: on a busy Windows
 * machine its process ID can belong to another process at once, which would keep the next build
 * out (a reused ID counts as live). No other build runs here.
 */
export async function removeCrashedClaims(directory) {
  const claims = join(directory, '.cratepin-cache', 'claims');
  const names = await readdir(claims);
  for (const name of names.filter((entry) => entry.startsWith('build-'))) {
    await rm(join(claims, name));
  }
  await rm(join(directory, 'public', '.assets.cratepin', 'claims'), {
    recursive: true,
    force: true,
  });
}
