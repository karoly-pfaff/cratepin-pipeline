import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';

import { startCli } from './cli-runs.test-support.mjs';

// Two real CLI processes interleaved at named file system steps: one is paused at a step (see
// step-at.test-support.mjs) while the test runs others and observes the cache and the output, then
// released. Nothing depends on timing: every wait is for a file a process wrote.

const STEP_AT_URL = new URL('./step-at.test-support.mjs', import.meta.url).href;
const POLL_MS = 25;
/** How long a run may take to reach its step before the test fails instead of hanging. */
const REACH_TIMEOUT_MS = 120_000;

/**
 * Starts the CLI in `directory` with `args`, paused at `step` (STEP_AT without its action, e.g.
 * `rename:/staging -> :after`); `label` names its pause files, kept in `.pauses/` there. Returns
 * the run, whose `finished` resolves with its exit status and output.
 */
export function startPaused({ directory, label, step, variables = {} }, ...args) {
  const pauseDirectory = join(directory, '.pauses');
  mkdirSync(pauseDirectory, { recursive: true });
  const pause = { STEP_AT: `pause:${step}`, PAUSE_DIR: pauseDirectory, PAUSE_LABEL: label };
  const start = {
    directory,
    variables: { ...variables, ...pause },
    nodeOptions: ['--import', STEP_AT_URL],
  };
  const { child, finished } = startCli(start, ...args);
  const run = {
    label,
    child,
    finished,
    reachedFile: join(pauseDirectory, `${label}.reached`),
    goFile: join(pauseDirectory, `${label}.go`),
    exit: undefined,
  };
  void finished.then((exit) => {
    run.exit = exit;
  });
  return run;
}

/** Waits until the run is paused at its step; fails if it ended first or took too long. */
export async function untilReached(run) {
  const deadline = Date.now() + REACH_TIMEOUT_MS;
  while (!existsSync(run.reachedFile)) {
    if (run.exit !== undefined) {
      assert.fail(
        `${run.label} ended (${String(run.exit.status)}) before its step: ${run.exit.stderr}`,
      );
    }
    if (Date.now() > deadline) assert.fail(`${run.label} did not reach its step in time`);
    await delay(POLL_MS);
  }
}

/** Lets a paused run go on; resolves with its exit status and output once it ended. */
export function release(run) {
  writeFileSync(run.goFile, '');
  return run.finished;
}

/**
 * Ends every run still going, as a failed test leaves them, and waits until each has exited (a
 * process still exiting counts as live for a claim); runs never started are `undefined`.
 */
export async function stopRuns(...runs) {
  for (const run of runs.filter((started) => started !== undefined)) {
    // SIGKILL: a paused CLI handles SIGTERM as a cancel and, paused, would never act on it.
    if (run.exit === undefined) run.child.kill('SIGKILL');
    await run.finished;
  }
}

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function namesIn(directory) {
  return readdir(directory).catch(() => []);
}

/**
 * Every file below `directory` by its path relative to it (forward slashes) with the SHA-256 of
 * its bytes, or `undefined` when there is no such directory; comparable wherever the tree moved.
 */
export async function treeOf(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
    () => undefined,
  );
  if (entries === undefined) return undefined;
  const files = entries.filter((entry) => entry.isFile());
  const hashed = await Promise.all(
    files.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      return [relative(directory, path).replaceAll('\\', '/'), sha256Of(await readFile(path))];
    }),
  );
  return Object.fromEntries(hashed.toSorted(([left], [right]) => (left < right ? -1 : 1)));
}

const SHA256_NAME = /^[0-9a-f]{64}$/u;

/** Every original in the cache is named by the SHA-256 of its bytes; no part file has an entry's name. */
async function assertEntriesNamedByContent(originals) {
  for (const name of await namesIn(originals)) {
    assert.match(name, SHA256_NAME, `${name}: only complete entries are in the originals`);
    assert.equal(sha256Of(await readFile(join(originals, name))), name, `${name}: its own bytes`);
  }
}

/** Every derivative record names an output that is there and holds the recorded bytes. */
async function assertRecordsHaveOutputs(derivatives) {
  const records = (await namesIn(derivatives)).filter((name) => name.endsWith('.json'));
  for (const name of records) {
    const record = JSON.parse(await readFile(join(derivatives, name), 'utf8'));
    const output = await readFile(join(derivatives, name.slice(0, -'.json'.length))).catch(
      () => undefined,
    );
    assert.ok(output !== undefined, `${name}: a record without its output`);
    assert.equal(sha256Of(output), record.output.sha256, `${name}: the recorded output`);
  }
}

/** What any reader of the cache may rely on at any moment, whatever runs meanwhile. */
export async function assertCacheConsistent(directory, cacheDirectory = '.cratepin-cache') {
  const cache = join(directory, cacheDirectory);
  await assertEntriesNamedByContent(join(cache, 'originals', 'sha256'));
  await assertRecordsHaveOutputs(join(cache, 'derivatives'));
}

/**
 * A separate process that reads a generation-mode output as a game would: the manifest, the
 * generation it names and every file of that generation's listing, each hashed. It prints the
 * generation and the paths that are missing or not the listed bytes.
 */
const GENERATION_READER = `
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readOrNothing = (path) => { try { return readFileSync(path); } catch { return Buffer.alloc(0); } };
const root = process.argv[1];
const { generation } = JSON.parse(readFileSync(root + '/cratepin-manifest.json', 'utf8'));
const directory = root + '/generations/' + generation.slice(0, 16);
const listingText = readFileSync(directory + '/.cratepin-generation.json', 'utf8');
const broken = JSON.parse(listingText).files
  .filter((file) => sha256Of(readOrNothing(directory + '/' + file.path)) !== file.sha256)
  .map((file) => file.path);
if (sha256Of(listingText) !== generation) broken.push('the listing');
process.stdout.write(JSON.stringify({ generation, broken }));
`;

/** What the reader process found in the output root of `directory`. */
async function readGenerationInAnotherProcess(directory) {
  const root = join(directory, 'public', 'assets');
  const args = ['--input-type=module', '-e', GENERATION_READER, root];
  const { stdout } = await promisify(execFile)(process.execPath, args);
  return JSON.parse(stdout);
}

/** The root holds one of `trees` whole, or, between a swap's renames, the backup holds `backupTree`. */
async function assertPathPreservingWhole(directory, { trees, backupTree }) {
  const root = await treeOf(join(directory, 'public', 'assets'));
  if (root === undefined && backupTree !== undefined) {
    const backup = join(directory, 'public', '.assets.cratepin', 'backup');
    assert.deepEqual(await treeOf(backup), backupTree, 'the previous output waits whole');
    return;
  }
  const isOneWhole = trees.some((tree) => isDeepStrictEqual(tree, root));
  assert.ok(isOneWhole, `the output root holds one release whole: ${JSON.stringify(root)}`);
}

/** A reader process finds the manifest naming one of `generations`, every byte of it in place. */
async function assertGenerationWhole(directory, { generations }) {
  const { generation, broken } = await readGenerationInAnotherProcess(directory);
  assert.deepEqual(broken, [], `generation ${generation} is complete`);
  assert.ok(generations.includes(generation), `${generation} is one of the releases`);
}

const PUBLIC_CHECKS = {
  'path-preserving': assertPathPreservingWhole,
  generation: assertGenerationWhole,
};

/**
 * What anyone reading `public/` may rely on at any moment. Path-preserving: the root holds one
 * of `trees` (by `treeOf`) whole, or is missing only between a swap's renames when `backupTree`
 * is given, with that tree whole in the backup. Generation: the manifest names one of
 * `generations` (digests), complete, as a separate reader process finds it.
 */
export function assertPublicConsistent(directory, { mode, ...expected }) {
  return PUBLIC_CHECKS[mode](directory, expected);
}
