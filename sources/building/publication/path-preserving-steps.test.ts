import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  failAt,
  firstAndLastOfEachKey,
  freezeFrom,
  recordOnly,
  tornWriteAt,
} from '../../output/publication/file-step-faults.test-support.ts';
import type {
  FaultPlan,
  FileStep,
} from '../../output/publication/file-step-faults.test-support.ts';
import { workDirectoryOf } from '../../output/layout/work-directory.ts';
import type { SourceLock } from '../../lock/source-lock.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import type { BuildFixture } from '../build-fixtures.test-support.ts';
import {
  BUILD_CONFIG,
  buildOf,
  buildOriginals,
  sameTree,
  snapshotOf,
  withoutFirstAsset,
} from '../build-runs.test-support.ts';
import {
  assertFaulted,
  assertNoWorkLeft,
  assertOnlyExpectedPublicEntries,
  assertSentinelsKept,
  endFaultedRun,
  faultedBuildOf,
  isVerified,
  openFixturePool,
  outcomeOf,
  PATH_PRESERVING_WORK_ENTRIES,
  plantSentinels,
  removeOutput,
  restoreSavedOutput,
  saveOutput,
  sweepSteps,
} from './publication-steps.test-support.ts';
import type { PlanAt } from './publication-steps.test-support.ts';

// Every file step a path-preserving build takes in public/ is failed, frozen (as a crash would
// stop it, every later step failing too) or torn in turn; each time the output must be the old
// complete tree or the new one, never a mix, and the next build must reach the new one cleanly.

type Tree = Record<string, string>;

/** A published output: the lock it was built from and every file of its root. */
interface Publication {
  readonly lock: SourceLock;
  readonly tree: Tree;
}

/** The two outputs of a fixture: of its whole lock, and of the lock without its first asset. */
interface Outputs {
  readonly whole: Publication;
  readonly smaller: Publication;
}

/** A publication: the output it replaces (none before the first) and the one it publishes. */
interface Change {
  readonly from: Publication | undefined;
  readonly to: Publication;
}

type ChangeOf = (outputs: Outputs) => Change;

/** The whole output replaced by the smaller one: one file fewer, every tool file rewritten. */
const replacement: ChangeOf = ({ whole, smaller }) => ({ from: whole, to: smaller });

/** The whole output published into an absent root. */
const firstPublication: ChangeOf = ({ whole }) => ({ from: undefined, to: whole });

/** Plants the sentinels, records both outputs and saves the whole one, where a change starts. */
async function outputsIn(fixture: BuildFixture): Promise<Outputs> {
  await plantSentinels(fixture);
  const root = fixture.project.paths.outputRoot;
  const smaller = await withoutFirstAsset(fixture);
  await buildOf(smaller);
  const smallerTree = await snapshotOf(root);
  await buildOf(fixture);
  await saveOutput(fixture);
  return {
    whole: { lock: fixture.lock, tree: await snapshotOf(root) },
    smaller: { lock: smaller.lock, tree: smallerTree },
  };
}

const pool = await openFixturePool(
  { originals: await buildOriginals(), config: BUILD_CONFIG, prepare: outputsIn },
  8,
);
after(() => pool.close());

/** Back to the output the change starts from (the saved whole one, or none). */
async function resetToStart(fixture: BuildFixture, change: Change): Promise<void> {
  if (change.from === undefined) await removeOutput(fixture);
  else await restoreSavedOutput(fixture);
  const tree = await snapshotOf(fixture.project.paths.outputRoot);
  assert.ok(sameTree(tree, change.from?.tree ?? {}), 'every step starts from the old output');
}

/** The first and last step of each kind of the change, recorded in an unfaulted run. */
async function recordedStepsOf(changeOf: ChangeOf): Promise<FileStep[]> {
  let steps: FileStep[] = [];
  await pool.use(async (fixture, outputs) => {
    const change = changeOf(outputs);
    await resetToStart(fixture, change);
    const recorded = await faultedBuildOf(fixture, change.to.lock, recordOnly);
    steps = firstAndLastOfEachKey(recorded.steps);
  });
  return steps;
}

const recordings = new Map<ChangeOf, Promise<FileStep[]>>();

/** The steps worth faulting, recorded once for every test that needs them. */
function stepsToFault(changeOf: ChangeOf): Promise<FileStep[]> {
  const recording = recordings.get(changeOf) ?? recordedStepsOf(changeOf);
  recordings.set(changeOf, recording);
  return recording;
}

/** How one step is faulted, and whether the old output may be left waiting in the backup. */
interface Fault {
  readonly plan: FaultPlan;
  readonly step: FileStep;
  /** Only a run frozen between the two renames of the swap leaves no root, the old one aside. */
  readonly mayLeaveBackup: boolean;
}

/** The output after a faulted step: the root, or the backup when a frozen swap left no root. */
async function publishedTreeAfter(fixture: BuildFixture, fault: Fault): Promise<Tree> {
  const work = workDirectoryOf(fixture.project.paths.outputRoot);
  const isRootMissing = (await entryKindAt(work.root)) === 'absent';
  return snapshotOf(isRootMissing && fault.mayLeaveBackup ? work.backup : work.root);
}

/**
 * Verify, given the new lock, passes only when the new output is published complete with nothing
 * left over; the old output kept, or work left next to the root, never verifies.
 */
async function assertVerifiedOnlyWhenComplete(
  fixture: BuildFixture,
  change: Change,
  step: string,
): Promise<void> {
  const root = fixture.project.paths.outputRoot;
  const isNewPublished = sameTree(await snapshotOf(root), change.to.tree);
  const hasWork = (await entryKindAt(workDirectoryOf(root).directory)) !== 'absent';
  const isVerifiedNow = await isVerified(fixture, change.to.lock);
  assert.equal(isVerifiedNow, isNewPublished && !hasWork, `${step}: verify`);
}

/** The next build, unfaulted, publishes the new output and leaves no work behind. */
async function assertNextBuildRepairs(
  fixture: BuildFixture,
  change: Change,
  step: string,
): Promise<void> {
  await endFaultedRun(fixture);
  const repaired = await buildOf({ ...fixture, lock: change.to.lock });
  assert.equal(repaired.failure, undefined, `${step}: the next build succeeds`);
  const tree = await snapshotOf(fixture.project.paths.outputRoot);
  assert.ok(sameTree(tree, change.to.tree), `${step}: the next build publishes the new output`);
  await assertNoWorkLeft(fixture, step);
  await assertSentinelsKept(fixture, step);
  assert.ok(await isVerified(fixture, change.to.lock), `${step}: the repaired output verifies`);
}

/** Runs the change faulted at one step; asserts what every faulted step must leave. */
async function faultChange(fixture: BuildFixture, change: Change, fault: Fault): Promise<void> {
  await resetToStart(fixture, change);
  const run = await faultedBuildOf(fixture, change.to.lock, fault.plan);
  const label = `${fault.step.key} #${String(fault.step.index)} (${outcomeOf(run)})`;
  assertFaulted(run, fault.step);
  const tree = await publishedTreeAfter(fixture, fault);
  const expected = outcomeOf(run) === 'published' ? change.to.tree : (change.from?.tree ?? {});
  assert.ok(sameTree(tree, expected), `${label}: the old output or the new one, complete`);
  await assertSentinelsKept(fixture, label);
  await assertOnlyExpectedPublicEntries(fixture, PATH_PRESERVING_WORK_ENTRIES, label);
  await assertVerifiedOnlyWhenComplete(fixture, change, label);
  await assertNextBuildRepairs(fixture, change, label);
}

/** Runs the change once per step, with the plan `planAt` makes for that step. */
async function sweepChange(
  changeOf: ChangeOf,
  steps: readonly FileStep[],
  planAt: PlanAt,
): Promise<void> {
  const mayLeaveBackup = planAt === freezeFrom;
  await sweepSteps(pool, steps, (fixture, outputs, step) =>
    faultChange(fixture, changeOf(outputs), { plan: planAt(step), step, mayLeaveBackup }),
  );
}

/** Every recorded step, each with `planAt`. */
async function sweepEveryStep(changeOf: ChangeOf, planAt: PlanAt): Promise<void> {
  const steps = await stepsToFault(changeOf);
  await sweepChange(changeOf, steps, planAt);
}

/** The recorded writes of staged files: every output and tool file of the next root. */
async function stagedWritesOf(changeOf: ChangeOf): Promise<FileStep[]> {
  return (await stepsToFault(changeOf)).filter(({ key }) =>
    key.startsWith('createWriteStream .assets.cratepin/staging/'),
  );
}

function operationsOf(steps: readonly FileStep[]): Set<string> {
  return new Set(steps.map(({ key }) => key.split(' ')[0] ?? key));
}

const EVERY_OPERATION = new Set([
  'mkdir',
  'writeFile',
  'link',
  'rm',
  'createWriteStream',
  'rename',
  'unlink',
  'rmdir',
]);

describe('every step of a path-preserving publication', { concurrency: true }, () => {
  test('a failure at any step of a path-preserving publication keeps the old complete output or publishes the new one', async () => {
    assert.deepEqual(operationsOf(await stepsToFault(replacement)), EVERY_OPERATION);
    await sweepEveryStep(replacement, failAt);
  });

  test('a publication frozen at any step leaves the old output, the new one, or the old one waiting in the backup, and the next build repairs it', async () => {
    await sweepEveryStep(replacement, freezeFrom);
  });

  test('a staged file torn mid-write is never published', async () => {
    const writes = await stagedWritesOf(replacement);
    assert.equal(writes.length, 4, 'the staged output and every tool file');
    await sweepChange(replacement, writes, tornWriteAt);
  });

  test('a first publication failing at any step leaves no root or a complete one', async () => {
    await sweepEveryStep(firstPublication, failAt);
  });
});
