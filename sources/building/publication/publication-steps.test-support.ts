import assert from 'node:assert/strict';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { isCacheName } from '../../cache/cache-file-names.ts';
import {
  failAt,
  withFileStepFaults,
} from '../../output/publication/file-step-faults.test-support.ts';
import type {
  FaultedRun,
  FaultPlan,
  FileStep,
  StepMark,
} from '../../output/publication/file-step-faults.test-support.ts';
import { workDirectoryOf } from '../../output/layout/work-directory.ts';
import type { SourceLock } from '../../lock/source-lock.ts';
import { verifyOutput } from '../../verify/output-verification.ts';
import { withBuildFixture } from '../build-fixtures.test-support.ts';
import type { BuildFixture, FixtureOriginal } from '../build-fixtures.test-support.ts';
import type { BuildResult } from '../build-run.ts';
import { buildOf } from '../build-runs.test-support.ts';

/** Files a build must never touch: two in `public/` next to the output, one outside it. */
const SENTINELS: Readonly<Record<string, string>> = {
  'public/index.html': 'the host page',
  'public/other/keep.txt': 'kept next to the output',
  'sentinel/keep.txt': 'kept outside public',
};

/** What `public/` holds after a build, the output root aside: the host's own files. */
const HOST_ENTRIES = ['index.html', 'other'];

/** The work directory's own entries in path-preserving mode; nothing else may appear in it. */
export const PATH_PRESERVING_WORK_ENTRIES: ReadonlySet<string> = new Set([
  'staging',
  'backup',
  'trash',
  'claims',
]);

function publicDirectoryOf(fixture: BuildFixture): string {
  return join(fixture.workspace, 'public');
}

function workPathOf(fixture: BuildFixture): string {
  return workDirectoryOf(fixture.project.paths.outputRoot).directory;
}

export async function plantSentinels(fixture: BuildFixture): Promise<void> {
  for (const [path, text] of Object.entries(SENTINELS)) {
    await mkdir(join(fixture.workspace, ...path.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(fixture.workspace, ...path.split('/')), text);
  }
}

export async function assertSentinelsKept(fixture: BuildFixture, step: string): Promise<void> {
  for (const [path, text] of Object.entries(SENTINELS)) {
    const kept = await readFile(join(fixture.workspace, ...path.split('/')), 'utf8');
    assert.equal(kept, text, `${step}: ${path} untouched`);
  }
}

async function sortedNamesIn(directory: string): Promise<string[]> {
  return (await readdir(directory).catch((): string[] => [])).toSorted(compareCodeUnits);
}

/**
 * `public/` holds the host's files, the output root and at most the work directory, which holds
 * only `workEntries`.
 */
export async function assertOnlyExpectedPublicEntries(
  fixture: BuildFixture,
  workEntries: ReadonlySet<string>,
  step: string,
): Promise<void> {
  const allowed = new Set([...HOST_ENTRIES, 'assets', '.assets.cratepin']);
  const names = await sortedNamesIn(publicDirectoryOf(fixture));
  assert.deepEqual(
    names.filter((name) => !allowed.has(name)),
    [],
    `${step}: public/`,
  );
  const workNames = await sortedNamesIn(workPathOf(fixture));
  assert.deepEqual(
    workNames.filter((name) => !workEntries.has(name)),
    [],
    `${step}: work`,
  );
}

/** Every name in `directory` that `isExpected` refuses; none when it is missing. */
export async function unexpectedNamesIn(
  directory: string,
  isExpected: (name: string) => boolean,
): Promise<string[]> {
  return (await sortedNamesIn(directory)).filter((name) => !isExpected(name));
}

/** After a build: the host's files and the output root, no work directory and no claim. */
export async function assertNoWorkLeft(fixture: BuildFixture, step: string): Promise<void> {
  const names = await sortedNamesIn(publicDirectoryOf(fixture));
  assert.deepEqual(names, ['assets', ...HOST_ENTRIES], `${step}: no work directory left`);
}

/** Whether verify finds the published output complete for `lock`, with nothing left over. */
export function isVerified(fixture: BuildFixture, lock: SourceLock): Promise<boolean> {
  return verifyOutput({ project: fixture.project, lock }).then(
    ({ issues }) => issues.length === 0,
    () => false,
  );
}

/** What a build said: rejected before its result, failed, or its publication's outcome. */
export function outcomeOf(run: { readonly result: BuildResult | undefined }): string {
  if (run.result === undefined) return 'rejected';
  if (run.result.failure !== undefined) return 'failed';
  return run.result.publication?.outcome ?? 'stopped';
}

/** Where a fixture keeps a copy of the output every step starts from, outside `public/`. */
function savedOutputOf(fixture: BuildFixture): string {
  return join(fixture.workspace, 'output-before-each-step');
}

/** Keeps a copy of the published output, so each step can start from it without a build. */
export async function saveOutput(fixture: BuildFixture): Promise<void> {
  await cp(fixture.project.paths.outputRoot, savedOutputOf(fixture), { recursive: true });
}

/** Removes the output root and the work directory next to it, as before any build. */
export async function removeOutput(fixture: BuildFixture): Promise<void> {
  const work = workDirectoryOf(fixture.project.paths.outputRoot);
  await rm(work.root, { recursive: true, force: true });
  await rm(work.directory, { recursive: true, force: true });
}

/** Puts back the saved output, with no work directory next to it. */
export async function restoreSavedOutput(fixture: BuildFixture): Promise<void> {
  await removeOutput(fixture);
  await cp(savedOutputOf(fixture), fixture.project.paths.outputRoot, { recursive: true });
}

/**
 * A process ID no operating system hands out, to stand for a run that has ended: far above the
 * Linux and macOS limits and the IDs Windows issues. The ID of a process that just ended would do
 * for a moment, but a sweep under load outlasts it and Windows reuses it.
 */
const ENDED_PROCESS_ID = 2 ** 30 + 2;

/**
 * Ends the faulted run as its process would end: the claims and claim temporary files it could
 * not remove now name a process that is gone, so the next build may remove them, as it does
 * after a crash.
 */
export async function endFaultedRun(fixture: BuildFixture): Promise<void> {
  const { claims } = workDirectoryOf(fixture.project.paths.outputRoot);
  const owner = { pid: ENDED_PROCESS_ID, host: hostname(), command: 'build' };
  for (const name of await sortedNamesIn(claims)) {
    const isClaimFile = isCacheName('claim', name) || isCacheName('claimInProgress', name);
    if (isClaimFile) await writeFile(join(claims, name), JSON.stringify(owner));
  }
}

/** One build of `lock` with its file steps in `public/` faulted as `plan` says. */
export function faultedBuildOf(
  fixture: BuildFixture,
  lock: SourceLock,
  plan: FaultPlan,
): Promise<FaultedRun & { readonly result: BuildResult | undefined }> {
  return withFileStepFaults(publicDirectoryOf(fixture), plan, () => buildOf({ ...fixture, lock }));
}

/** The first step the faulted run failed or tore is `step`: the run took the recorded steps. */
export function assertFaulted(run: FaultedRun, step: FileStep): void {
  const faulted = run.faults[0];
  const label = `${step.key} #${String(step.occurrence)} was faulted`;
  assert.deepEqual([faulted?.key, faulted?.occurrence], [step.key, step.occurrence], label);
}

/** Makes the fault plan for a marked step: `failAt`, `freezeFrom` or `tornWriteAt`. */
export type PlanAt = (mark: StepMark) => FaultPlan;

const CLAIM_TEMPORARY_FILE_REMOVAL = 'rm .assets.cratepin/claims/.<uuid>.tmp';

/**
 * A failure the build absorbs and so may still publish: a claim's temporary file that cannot be
 * removed right away does not fail the claim (releasing removes it).
 */
export function isAbsorbedFailure(planAt: PlanAt, { key }: FileStep): boolean {
  return planAt === failAt && key === CLAIM_TEMPORARY_FILE_REMOVAL;
}

/** How the fixtures of a pool are made: their originals, config and what is done once created. */
export interface PoolFixture<State> {
  readonly originals: readonly FixtureOriginal[];
  readonly config: object;
  readonly prepare: (fixture: BuildFixture) => Promise<State>;
}

/** A fixture of a pool: the fixture, what preparing it gave, and how to end it. */
interface OpenFixture<State> {
  readonly fixture: BuildFixture;
  readonly state: State;
  readonly close: () => Promise<void>;
}

/** Creates and prepares a fixture that stays until it is closed. */
function openFixture<State>(made: PoolFixture<State>): Promise<OpenFixture<State>> {
  const opened = Promise.withResolvers<OpenFixture<State>>();
  const closing = Promise.withResolvers<undefined>();
  const lifetime = withBuildFixture(made.originals, made.config, async (fixture) => {
    const state = await made.prepare(fixture);
    const close = async (): Promise<void> => {
      closing.resolve(undefined);
      await lifetime;
    };
    opened.resolve({ fixture, state, close });
    await closing.promise;
  });
  lifetime.catch(opened.reject);
  return opened.promise;
}

/** Fixtures shared by every test of a file; each serves one check at a time. */
export interface FixturePool<State> {
  /** Runs `check` on the next free fixture, waiting for one. */
  readonly use: (check: (fixture: BuildFixture, state: State) => Promise<void>) => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Opens `size` fixtures made as `made` says, to share between tests running side by side. */
export async function openFixturePool<State>(
  made: PoolFixture<State>,
  size: number,
): Promise<FixturePool<State>> {
  const all = await Promise.all(Array.from({ length: size }, () => openFixture(made)));
  const free = [...all];
  const waiting: ((open: OpenFixture<State>) => void)[] = [];
  const acquire = (): Promise<OpenFixture<State>> => {
    const open = free.pop();
    if (open !== undefined) return Promise.resolve(open);
    const next = Promise.withResolvers<OpenFixture<State>>();
    waiting.push(next.resolve);
    return next.promise;
  };
  const release = (open: OpenFixture<State>): void => {
    const next = waiting.shift();
    if (next === undefined) free.push(open);
    else next(open);
  };
  return {
    use: async (check) => {
      const open = await acquire();
      try {
        await check(open.fixture, open.state);
      } finally {
        release(open);
      }
    },
    close: async () => {
      await Promise.all(all.map(({ close }) => close()));
    },
  };
}

/** Runs `check` for every step on the pool's fixtures; all finish before the first failure is thrown. */
export async function sweepSteps<State, Step>(
  pool: FixturePool<State>,
  steps: readonly Step[],
  check: (fixture: BuildFixture, state: State, step: Step) => Promise<void>,
): Promise<void> {
  const checks = steps.map((step) => pool.use((fixture, state) => check(fixture, state, step)));
  const failure = (await Promise.allSettled(checks)).find(({ status }) => status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
