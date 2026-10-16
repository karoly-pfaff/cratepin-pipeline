import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  failAt,
  firstAndLastOfEachKey,
  freezeFrom,
  recordOnly,
} from '../../output/publication/file-step-faults.test-support.ts';
import type {
  FaultPlan,
  FileStep,
} from '../../output/publication/file-step-faults.test-support.ts';
import { generationLayoutOf } from '../../output/generation/generation-layout.ts';
import type { GenerationLayout } from '../../output/generation/generation-layout.ts';
import { generationNameOf } from '../../output/generation/generation-listing.ts';
import { writeListedTree } from '../../output/publication/publication-fixtures.test-support.ts';
import type { SourceLock } from '../../lock/source-lock.ts';
import { workDirectoryOf } from '../../output/layout/work-directory.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import { lockOfOriginals } from '../build-fixtures.test-support.ts';
import type { BuildFixture, FixtureOriginal } from '../build-fixtures.test-support.ts';
import {
  buildOf,
  buildOriginals,
  GENERATION_CONFIG,
  snapshotOf,
} from '../build-runs.test-support.ts';
import {
  assertFaulted,
  assertNoWorkLeft,
  assertOnlyExpectedPublicEntries,
  assertSentinelsKept,
  isAbsorbedFailure,
  endFaultedRun,
  faultedBuildOf,
  isVerified,
  openFixturePool,
  outcomeOf,
  plantSentinels,
  removeOutput,
  restoreSavedOutput,
  saveOutput,
  sweepSteps,
  unexpectedNamesIn,
} from './publication-steps.test-support.ts';
import type { PlanAt } from './publication-steps.test-support.ts';

// Every file step a generation-mode build takes in public/ is failed or frozen (as a crash would
// stop it, every later step failing too) in turn. The root manifest is the commit point: until
// it is switched, it names the old generation, every byte of it intact; from then on the new one.
// The next build must reach the new generation and leave no staging, trash or temporary manifest.
// A failed removal of the output claim's temporary file is absorbed: the build may still publish.

/** The published manifest and every byte of the generation it names, as one comparable text. */
type PublishedState = string;

const NO_MANIFEST: PublishedState = 'no manifest';

/** A published release: the lock it was built from and what its publication leaves. */
interface Publication {
  readonly lock: SourceLock;
  readonly state: PublishedState;
}

/** A fixture's releases: the published one, with an older one retained, and the next one. */
interface Releases {
  readonly published: Publication;
  readonly next: Publication;
}

/** A build: the release it replaces (none before the first) and the one it publishes. */
interface Change {
  readonly from: Publication | undefined;
  readonly to: Publication;
}

type ChangeOf = (releases: Releases) => Change;

/** The next release replaces the published one, retiring the oldest generation. */
const nextRelease: ChangeOf = ({ published, next }) => ({ from: published, to: next });

/** The next release built into an absent root: root, marker and generations/ are created. */
const firstBuild: ChangeOf = ({ next }) => ({ from: undefined, to: next });

function layoutOf(fixture: BuildFixture): GenerationLayout {
  return generationLayoutOf(fixture.project.paths.outputRoot);
}

async function publishedStateOf(fixture: BuildFixture): Promise<PublishedState> {
  const layout = layoutOf(fixture);
  const manifest = await readFile(layout.manifest, 'utf8').catch(() => undefined);
  if (manifest === undefined) return NO_MANIFEST;
  const { generation } = JSON.parse(manifest) as { generation: string };
  const directory = join(layout.generations, generationNameOf(generation));
  return JSON.stringify({ manifest, generation: await snapshotOf(directory) });
}

/** Three cached originals: an image, a voice line and another voice line. */
async function threeOriginals(): Promise<[FixtureOriginal, FixtureOriginal, FixtureOriginal]> {
  const [image, voice] = (await buildOriginals()) as [FixtureOriginal, FixtureOriginal];
  return [image, voice, { ...voice, source: 'voice/hu/bye.mp3', bytes: Buffer.from('ID3 bye') }];
}

const ORIGINALS = await threeOriginals();
const [IMAGE, VOICE, OTHER_VOICE] = ORIGINALS;

/** Three releases: the image with a voice line, only that voice line, only the other one. */
const FIRST_LOCK = lockOfOriginals([IMAGE, VOICE]);
const SECOND_LOCK = lockOfOriginals([VOICE]);
const NEXT_LOCK = lockOfOriginals([OTHER_VOICE]);

/**
 * A damaged, unpublished generation holding the next generation's name: placing the next one
 * first moves it to the trash, and it is removed whole as its listing proves it.
 */
async function plantNameHolder(fixture: BuildFixture, name: string): Promise<void> {
  const directory = join(layoutOf(fixture).generations, name);
  await rm(directory, { recursive: true, force: true });
  await writeListedTree(directory, { 'junk.txt': 'not this generation' });
}

/**
 * Plants the sentinels and records the next release's publication, then publishes the first and
 * second releases (the second named, the first retained) with a holder of the next one's name,
 * and saves that output, where every step of the next release starts.
 */
async function releasesIn(fixture: BuildFixture): Promise<Releases> {
  await plantSentinels(fixture);
  const nextGeneration = (await buildOf({ ...fixture, lock: NEXT_LOCK })).assembled?.generation;
  const next = { lock: NEXT_LOCK, state: await publishedStateOf(fixture) };
  await removeOutput(fixture);
  await buildOf({ ...fixture, lock: FIRST_LOCK });
  await buildOf({ ...fixture, lock: SECOND_LOCK });
  await plantNameHolder(fixture, generationNameOf(nextGeneration ?? ''));
  await saveOutput(fixture);
  return { published: { lock: SECOND_LOCK, state: await publishedStateOf(fixture) }, next };
}

const pool = await openFixturePool(
  { originals: ORIGINALS, config: GENERATION_CONFIG, prepare: releasesIn },
  6,
);
after(() => pool.close());

async function resetToStart(fixture: BuildFixture, change: Change): Promise<void> {
  if (change.from === undefined) await removeOutput(fixture);
  else await restoreSavedOutput(fixture);
  const expected = change.from?.state ?? NO_MANIFEST;
  assert.equal(await publishedStateOf(fixture), expected, 'every step starts from the old output');
}

/** The steps worth faulting, and the index of the manifest switch, the commit point. */
interface RecordedSteps {
  readonly steps: readonly FileStep[];
  readonly switchIndex: number;
}

const MANIFEST_SWITCH = 'rename assets/.cratepin-manifest.json.tmp > assets/cratepin-manifest.json';

async function recordedStepsOf(changeOf: ChangeOf): Promise<RecordedSteps> {
  let recorded: RecordedSteps = { steps: [], switchIndex: -1 };
  await pool.use(async (fixture, releases) => {
    const change = changeOf(releases);
    await resetToStart(fixture, change);
    const { steps } = await faultedBuildOf(fixture, change.to.lock, recordOnly);
    const switchIndex = steps.findIndex(({ key }) => key === MANIFEST_SWITCH);
    recorded = { steps: firstAndLastOfEachKey(steps), switchIndex };
  });
  assert.ok(recorded.switchIndex > 0, 'the manifest switch was recorded');
  return recorded;
}

const recordings = new Map<ChangeOf, Promise<RecordedSteps>>();

/** The steps worth faulting, recorded once for every test that needs them. */
function stepsToFault(changeOf: ChangeOf): Promise<RecordedSteps> {
  const recording = recordings.get(changeOf) ?? recordedStepsOf(changeOf);
  recordings.set(changeOf, recording);
  return recording;
}

/**
 * How one step is faulted, and whether the build then publishes: it does after the switch, and
 * may when it absorbs the failure.
 */
interface Fault {
  readonly plan: FaultPlan;
  readonly step: FileStep;
  readonly isAfterSwitch: boolean;
  readonly isAbsorbed: boolean;
}

const ROOT_NAMES: ReadonlySet<string> = new Set([
  '.cratepin-output.json',
  'cratepin-manifest.json',
  '.cratepin-manifest.json.tmp',
  'generations',
]);

/** A marker being written, which a crash may leave next to the root's marker. */
const MARKER_IN_PROGRESS = /^\.cratepin-output\.json\.[0-9a-f-]{36}\.tmp$/u;

function isRootName(name: string): boolean {
  return ROOT_NAMES.has(name) || MARKER_IN_PROGRESS.test(name);
}

function isGenerationsName(name: string): boolean {
  return /^[0-9a-f]{16}$/u.test(name) || name === '.staging' || name === '.trash';
}

/** public/, the root and generations/ hold only what the host and the tool put there. */
async function assertOnlyExpectedEntries(fixture: BuildFixture, step: string): Promise<void> {
  await assertOnlyExpectedPublicEntries(fixture, new Set(['claims']), step);
  const layout = layoutOf(fixture);
  assert.deepEqual(await unexpectedNamesIn(layout.root, isRootName), [], `${step}: the root`);
  const strays = await unexpectedNamesIn(layout.generations, isGenerationsName);
  assert.deepEqual(strays, [], `${step}: generations/`);
}

/** Leftovers verify reports: the root's staging, trash or temporary manifest, or work next to it. */
async function hasLeftovers(fixture: BuildFixture): Promise<boolean> {
  const { staging, trash, manifestInProgress } = layoutOf(fixture);
  const work = workDirectoryOf(fixture.project.paths.outputRoot).directory;
  const kinds = await Promise.all([staging, trash, manifestInProgress, work].map(entryKindAt));
  return kinds.some((kind) => kind !== 'absent');
}

/**
 * Verify, given the new lock, passes only when the new generation is published complete with no
 * staging, trash, temporary manifest or output claim left.
 */
async function assertVerifiedOnlyWhenComplete(
  fixture: BuildFixture,
  change: Change,
  step: string,
): Promise<void> {
  const isNewPublished = (await publishedStateOf(fixture)) === change.to.state;
  const isComplete = isNewPublished && !(await hasLeftovers(fixture));
  assert.equal(await isVerified(fixture, change.to.lock), isComplete, `${step}: verify`);
}

/** The next build, unfaulted, publishes the new generation and leaves no work behind. */
async function assertNextBuildRepairs(
  fixture: BuildFixture,
  change: Change,
  step: string,
): Promise<void> {
  await endFaultedRun(fixture);
  const repaired = await buildOf({ ...fixture, lock: change.to.lock });
  assert.equal(repaired.failure, undefined, `${step}: the next build succeeds`);
  assert.equal(await publishedStateOf(fixture), change.to.state, `${step}: the new generation`);
  await assertNoWorkLeft(fixture, step);
  assert.equal(
    await hasLeftovers(fixture),
    false,
    `${step}: no staging, trash, temporary or claim`,
  );
  await assertSentinelsKept(fixture, step);
  assert.ok(await isVerified(fixture, change.to.lock), `${step}: the repaired output verifies`);
}

/** Runs the build faulted at one step; asserts what every faulted step must leave. */
async function faultBuild(fixture: BuildFixture, change: Change, fault: Fault): Promise<void> {
  await resetToStart(fixture, change);
  const run = await faultedBuildOf(fixture, change.to.lock, fault.plan);
  const label = `${fault.step.key} #${String(fault.step.index)} (${outcomeOf(run)})`;
  assertFaulted(run, fault.step);
  const isPublished = outcomeOf(run) === 'published';
  if (!fault.isAbsorbed) {
    assert.equal(isPublished, fault.isAfterSwitch, `${label}: published only after the switch`);
  }
  const expected = isPublished ? change.to.state : (change.from?.state ?? NO_MANIFEST);
  assert.equal(await publishedStateOf(fixture), expected, `${label}: a complete generation`);
  await assertSentinelsKept(fixture, label);
  await assertOnlyExpectedEntries(fixture, label);
  await assertVerifiedOnlyWhenComplete(fixture, change, label);
  await assertNextBuildRepairs(fixture, change, label);
}

/** Runs the build once per step, with the plan `planAt` makes for that step. */
async function sweepBuild(
  changeOf: ChangeOf,
  steps: readonly FileStep[],
  planAt: PlanAt,
): Promise<void> {
  const { switchIndex } = await stepsToFault(changeOf);
  await sweepSteps(pool, steps, (fixture, releases, step) =>
    faultBuild(fixture, changeOf(releases), {
      plan: planAt(step),
      step,
      isAfterSwitch: step.index > switchIndex,
      isAbsorbed: isAbsorbedFailure(planAt, step),
    }),
  );
}

/** Every recorded step, each with `planAt`. */
async function sweepEveryStep(changeOf: ChangeOf, planAt: PlanAt): Promise<void> {
  const { steps } = await stepsToFault(changeOf);
  await sweepBuild(changeOf, steps, planAt);
}

/** The recorded steps of `changeOf` with one of `keys`. */
async function stepsWithKeys(changeOf: ChangeOf, keys: readonly string[]): Promise<FileStep[]> {
  const { steps } = await stepsToFault(changeOf);
  return steps.filter(({ key }) => keys.includes(key));
}

const MARKER_IN_PROGRESS_KEY = 'assets/.cratepin-output.json.<uuid>.tmp';

/** The steps that create the root, link its marker into place and create generations/. */
const ROOT_CREATION_KEYS = [
  'mkdir assets',
  `writeFile ${MARKER_IN_PROGRESS_KEY}`,
  `link ${MARKER_IN_PROGRESS_KEY} > assets/.cratepin-output.json`,
  `rm ${MARKER_IN_PROGRESS_KEY}`,
  'mkdir assets/generations',
];

/** Whether old generations are moved to the trash after the switch, among the recorded steps. */
async function isRetentionRecorded(changeOf: ChangeOf): Promise<boolean> {
  const { steps, switchIndex } = await stepsToFault(changeOf);
  return steps.some(({ key, index }) => index > switchIndex && key.includes('/.trash/'));
}

/** Builds the next release with `plan`; the failure it reports. */
async function failureMessageOf(plan: FaultPlan): Promise<string> {
  let message = '';
  await pool.use(async (fixture, releases) => {
    const change = nextRelease(releases);
    await resetToStart(fixture, change);
    const run = await faultedBuildOf(fixture, change.to.lock, plan);
    message = run.result?.failure?.message ?? 'no failure';
    assert.equal(await publishedStateOf(fixture), change.from?.state, 'the previous manifest');
  });
  return message;
}

describe('every step of a generation-mode publication', { concurrency: true }, () => {
  // Every step is failed: the steps up to the switch keep the old manifest, the later ones
  // (retention, the claim's release) cannot undo a publication.
  test('a failure at any step before the manifest switch keeps the old manifest and every byte of its generation', async () => {
    await sweepEveryStep(nextRelease, failAt);
  });

  test('a generation build frozen at any step, retention included, keeps a manifest naming a complete generation', async () => {
    assert.ok(await isRetentionRecorded(nextRelease), 'retention is among the steps');
    await sweepEveryStep(nextRelease, freezeFrom);
  });

  test('a temporary manifest that cannot be written or renamed keeps the previous manifest published', async () => {
    const steps = await stepsWithKeys(nextRelease, [
      'writeFile assets/.cratepin-manifest.json.tmp',
      MANIFEST_SWITCH,
    ]);
    assert.equal(steps.length, 2, 'the write and the switch');
    await sweepBuild(nextRelease, steps, failAt);
    await sweepBuild(nextRelease, steps, freezeFrom);
    const message = await failureMessageOf(failAt({ key: MANIFEST_SWITCH, occurrence: 0 }));
    assert.match(message, /the previous manifest stays published/u);
  });

  test('a first generation build failing at the root, the marker or generations/ leaves no manifest', async () => {
    const creations = await stepsWithKeys(firstBuild, ROOT_CREATION_KEYS);
    assert.equal(creations.length, ROOT_CREATION_KEYS.length, 'every creation was recorded');
    await sweepBuild(firstBuild, creations, failAt);
    await sweepBuild(firstBuild, creations, freezeFrom);
  });
});
