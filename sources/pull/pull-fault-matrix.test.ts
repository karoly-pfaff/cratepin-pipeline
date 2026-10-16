import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import type { TestContext } from 'node:test';

import { lockedObjectOf, withPreparedCache } from '../cache/cache-fixtures.test-support.ts';
import { originalPathOf } from '../cache/cache-layout.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import type { PlannedObject } from '../lock/upload-plan.ts';
import { FakeS3 } from '../storage/testing/fake-s3.test-support.ts';
import type {
  FakeS3Request,
  RequestFault,
  RequestPlan,
} from '../storage/testing/fake-s3.test-support.ts';
import {
  droppedBeforeBody,
  droppedMidBody,
  extendedBody,
  FaultTrace,
  faultPlanOf,
  faultSeeds,
  flippedByte,
  permanentRefusal,
  replayCommand,
  shortenedBody,
  stepOf,
  transientRefusal,
  withTraceOnFailure,
  wrongBytesUnderPlausibleHeaders,
} from '../storage/testing/fault-matrix.test-support.ts';
import type { FaultTarget } from '../storage/testing/fault-matrix.test-support.ts';
import { createR2BlobReader } from '../storage/r2/r2-blob-store.ts';
import { DEFAULT_TRANSFER_SETTINGS } from '../storage/transfer/transfer-settings.ts';
import { retrieveLockedOriginals } from './locked-originals.ts';
import type { OriginalOutcome } from './locked-originals.ts';

// Every cell pulls three locked originals with the read-only key, one at a time so its trace
// replays exactly, with one kind of storage or cache fault the seed parameterizes. Whatever
// happens, the cache holds only entries whose bytes hash to their names, no download part is
// left, the quarantine holds only bytes that did not match, every object reported available is
// exactly in the cache, and once the faults stop a rerun makes every original available.

const FILE = 'sources/pull/pull-fault-matrix.test.ts';
const ATTEMPTS = DEFAULT_TRANSFER_SETTINGS.transferAttempts;
const SETTINGS = { ...DEFAULT_TRANSFER_SETTINGS, delayBeforeRetry: () => 0 };
const CONTENTS = ['cat bytes', 'dog bytes!', 'sun bytes, longer'];
const OBJECTS: readonly PlannedObject[] = CONTENTS.map((content) => lockedObjectOf(content));

type Expectation = 'succeeds' | 'fails';

/**
 * What a cell does to the cache: before the pull (`entry-*`, at an object the seed picks) or,
 * like another run publishing meanwhile, when the download of that object starts (`race-*`).
 */
type CacheAction =
  | 'entry-same-size'
  | 'entry-shorter'
  | 'entry-longer'
  | 'entry-directory'
  | 'race-same-bytes'
  | 'race-wrong-bytes'
  | 'cancel'
  | 'cancel-mid-body';

interface FaultCell {
  readonly id: string;
  readonly targets: readonly FaultTarget[];
  readonly expect: Expectation;
  readonly action?: CacheAction;
}

const CELLS: readonly FaultCell[] = [
  {
    id: 'get/transient-once',
    targets: [{ step: 'get', fault: transientRefusal }],
    expect: 'succeeds',
  },
  {
    id: 'get/transient-exhausted',
    targets: [{ step: 'get', times: ATTEMPTS, fault: transientRefusal }],
    expect: 'fails',
  },
  { id: 'get/refused', targets: [{ step: 'get', fault: permanentRefusal }], expect: 'fails' },
  {
    id: 'get/missing-object',
    targets: [{ step: 'get', fault: () => ({ refuse: { status: 404, s3Code: 'NoSuchKey' } }) }],
    expect: 'fails',
  },
  { id: 'get/flipped-byte', targets: [{ step: 'get', fault: flippedByte }], expect: 'fails' },
  {
    id: 'get/wrong-bytes-plausible-headers',
    targets: [{ step: 'get', fault: wrongBytesUnderPlausibleHeaders }],
    expect: 'fails',
  },
  {
    id: 'get/dropped-before-body',
    targets: [{ step: 'get', fault: droppedBeforeBody }],
    expect: 'succeeds',
  },
  {
    id: 'get/dropped-mid-body',
    targets: [{ step: 'get', fault: droppedMidBody }],
    expect: 'fails',
  },

  { id: 'get/longer-object', targets: [{ step: 'get', fault: extendedBody }], expect: 'fails' },
  { id: 'get/shorter-object', targets: [{ step: 'get', fault: shortenedBody }], expect: 'fails' },
  { id: 'cache/corrupt-same-size', targets: [], action: 'entry-same-size', expect: 'succeeds' },
  { id: 'cache/corrupt-shorter', targets: [], action: 'entry-shorter', expect: 'succeeds' },
  { id: 'cache/corrupt-longer', targets: [], action: 'entry-longer', expect: 'succeeds' },
  { id: 'cache/directory-at-entry', targets: [], action: 'entry-directory', expect: 'succeeds' },
  { id: 'race/other-run-same-bytes', targets: [], action: 'race-same-bytes', expect: 'succeeds' },
  { id: 'race/other-run-wrong-bytes', targets: [], action: 'race-wrong-bytes', expect: 'succeeds' },
  { id: 'cancel/at-get', targets: [], action: 'cancel', expect: 'fails' },
  { id: 'cancel/mid-body', targets: [], action: 'cancel-mid-body', expect: 'fails' },
];

interface Scene {
  readonly layout: CacheLayout;
  readonly fake: FakeS3;
  /** The object the seed picked for the cell's cache action. */
  readonly victim: PlannedObject;
  readonly controller: AbortController;
  /** What the cell put at the victim's entry name: bytes, a directory, or nothing yet. */
  readonly planted: PlantedEntry;
}

/** What a cell put at the victim's entry name, and whether it was there before the pull. */
class PlantedEntry {
  content: Buffer | 'directory' | undefined;
  /** Planted before the pull, so the pull must report quarantining it. */
  wasBeforePull = false;

  note(content: Buffer | 'directory', wasBeforePull: boolean): void {
    this.content = content;
    this.wasBeforePull = wasBeforePull;
  }

  /** Something other than the victim's exact bytes, which must end in the quarantine. */
  isCorrupt(exact: Buffer): boolean {
    return (
      this.content === 'directory' || (this.content !== undefined && !this.content.equals(exact))
    );
  }
}

function sha256Of(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function contentOf(object: PlannedObject): Buffer {
  return Buffer.from(CONTENTS[OBJECTS.indexOf(object)] ?? '');
}

function wrongBytesOf(object: PlannedObject): Buffer {
  const wrong = contentOf(object);
  wrong[0] = (wrong[0] ?? 0) ^ 0xff;
  return wrong;
}

/** The bytes or directory a cell plants at the victim's entry name before the pull. */
const ENTRY_PLANTS: Partial<
  Record<CacheAction, (path: string, object: PlannedObject) => Promise<void>>
> = {
  'entry-same-size': (path, object) => writeFile(path, wrongBytesOf(object)),
  'entry-shorter': (path, object) => writeFile(path, contentOf(object).subarray(1)),
  'entry-longer': (path, object) =>
    writeFile(path, Buffer.concat([contentOf(object), Buffer.from('+')])),
  'entry-directory': (path) => mkdir(path),
};

async function plantEntry(scene: Scene, action: CacheAction | undefined): Promise<void> {
  const plant = action === undefined ? undefined : ENTRY_PLANTS[action];
  if (plant === undefined) return;
  const path = originalPathOf(scene.layout, scene.victim.sha256);
  await plant(path, scene.victim);
  scene.planted.note((await stat(path)).isDirectory() ? 'directory' : await readFile(path), true);
}

/** Another run publishes the victim's entry, written at once, before this download publishes. */
function publishAs(scene: Scene, bytes: Buffer): () => undefined {
  return () => {
    writeFileSync(originalPathOf(scene.layout, scene.victim.sha256), bytes);
    scene.planted.note(bytes, false);
    return undefined;
  };
}

/**
 * What happens when the victim's download starts: another run publishes its entry, a cancel, or
 * a cancel once half the body is on the way (returned as the fault of that read).
 */
function raceOf(
  scene: Scene,
  action: CacheAction | undefined,
): (() => RequestFault | undefined) | undefined {
  const races: Partial<Record<CacheAction, () => RequestFault | undefined>> = {
    'race-same-bytes': publishAs(scene, contentOf(scene.victim)),
    'race-wrong-bytes': publishAs(scene, wrongBytesOf(scene.victim)),
    cancel: () => {
      scene.controller.abort();
      return undefined;
    },
    'cancel-mid-body': () => ({
      midBody: () => {
        scene.controller.abort();
      },
    }),
  };
  return action === undefined ? undefined : races[action];
}

function isVictimRead(request: FakeS3Request, scene: Scene): boolean {
  return stepOf(request) === 'get' && request.key === scene.victim.objectKey;
}

/** The plan, doing the cell's race once, when the victim's download starts, and tracing it. */
function planWithRace(
  plan: RequestPlan,
  { scene, trace, action }: { scene: Scene; trace: FaultTrace; action: CacheAction | undefined },
): RequestPlan {
  const race = action === undefined ? undefined : raceOf(scene, action);
  if (race === undefined || action === undefined) return plan;
  let hasRaced = false;
  return (request: FakeS3Request) => {
    if (hasRaced || !isVictimRead(request, scene)) return plan(request);
    hasRaced = true;
    const raced = race();
    if (raced !== undefined) {
      trace.record(request, raced);
      return raced;
    }
    trace.note(request, action);
    return plan(request);
  };
}

async function withScene(seed: number, useScene: (scene: Scene) => Promise<void>): Promise<void> {
  await withPreparedCache(async (layout) => {
    const fake = await FakeS3.start();
    try {
      for (const object of OBJECTS) fake.objects.set(object.objectKey, contentOf(object));
      // Seed n puts the cache action at object n mod 3, so the default seeds hit each one.
      const victim = OBJECTS[seed % OBJECTS.length] ?? OBJECTS[0];
      assert.ok(victim !== undefined);
      await useScene({
        layout,
        fake,
        victim,
        controller: new AbortController(),
        planted: new PlantedEntry(),
      });
    } finally {
      await fake.close();
    }
  });
}

/** The outcomes, or the error a cancelled retrieval stops with. */
async function pull(scene: Scene): Promise<OriginalOutcome[] | Error> {
  try {
    return await retrieveLockedOriginals({
      layout: scene.layout,
      objects: OBJECTS,
      isOffline: false,
      openReader: () => createR2BlobReader(scene.fake.readOnlyConnection, SETTINGS),
      concurrency: 1,
      signal: scene.controller.signal,
    });
  } catch (error) {
    return error as Error;
  }
}

async function assertCacheSound(layout: CacheLayout): Promise<void> {
  for (const name of await readdir(layout.originals)) {
    const path = join(layout.originals, name);
    assert.ok((await stat(path)).isFile(), `${name} is a file`);
    assert.equal(sha256Of(await readFile(path)), name, `${name} holds its own bytes`);
  }
  assert.deepEqual(
    (await readdir(layout.incoming)).filter((name) => name.endsWith('.part')),
    [],
  );
  for (const name of await readdir(layout.quarantine)) {
    const path = join(layout.quarantine, name);
    if ((await stat(path)).isFile()) {
      assert.notEqual(
        sha256Of(await readFile(path)),
        name.slice(0, 64),
        'only bytes that did not match are quarantined',
      );
    }
  }
}

function failedOf(outcomes: readonly OriginalOutcome[]): OriginalOutcome[] {
  return outcomes.filter(({ status }) => status === 'failed' || status === 'missing');
}

async function assertOutcome(
  scene: Scene,
  cell: FaultCell,
  result: OriginalOutcome[] | Error,
): Promise<void> {
  if (result instanceof Error) {
    assert.equal(cell.expect, 'fails', result.message);
    return;
  }
  for (const { object } of result.filter((outcome) => !failedOf(result).includes(outcome))) {
    assert.equal(
      sha256Of(await readFile(originalPathOf(scene.layout, object.sha256))),
      object.sha256,
    );
  }
  assert.equal(failedOf(result).length === 0, cell.expect === 'succeeds', JSON.stringify(result));
}

/** Bytes that did not match were moved aside, never deleted or served. */
async function assertPlantedQuarantined(
  scene: Scene,
  result: OriginalOutcome[] | Error,
): Promise<void> {
  const { content } = scene.planted;
  if (content === undefined || !scene.planted.isCorrupt(contentOf(scene.victim))) return;
  const names = await readdir(scene.layout.quarantine);
  const kept = await Promise.all(
    names.map((name) => quarantinedMatches(join(scene.layout.quarantine, name), content)),
  );
  assert.ok(kept.includes(true), 'the corrupt entry is in the quarantine');
  if (scene.planted.wasBeforePull && !(result instanceof Error)) {
    assert.ok(result.find(isVictimOutcome(scene))?.wasQuarantined, 'reported as quarantined');
  }
}

function isVictimOutcome(scene: Scene): (outcome: OriginalOutcome) => boolean {
  return ({ object }) => object === scene.victim;
}

async function quarantinedMatches(path: string, planted: Buffer | 'directory'): Promise<boolean> {
  const isDirectory = (await stat(path)).isDirectory();
  if (planted === 'directory') return isDirectory;
  return !isDirectory && (await readFile(path)).equals(planted);
}

async function assertRerunMakesAllAvailable(scene: Scene): Promise<void> {
  scene.fake.planRequests(undefined);
  const rerun = await pull({ ...scene, controller: new AbortController() });
  assert.ok(!(rerun instanceof Error), 'the rerun is not cancelled');
  assert.deepEqual(failedOf(rerun), []);
  await assertCacheSound(scene.layout);
}

async function runCell(context: TestContext, cell: FaultCell, seed: number): Promise<void> {
  await withScene(seed, async (scene) => {
    const trace = new FaultTrace();
    await plantEntry(scene, cell.action);
    const plan = faultPlanOf(cell.targets, { seed, trace });
    scene.fake.planRequests(planWithRace(plan, { scene, trace, action: cell.action }));
    const result = await pull(scene);
    const replay = replayCommand(`pull ${cell.id}`, seed, FILE);
    await withTraceOnFailure(context, { trace, replay }, async () => {
      await assertCacheSound(scene.layout);
      await assertOutcome(scene, cell, result);
      await assertPlantedQuarantined(scene, result);
      await assertRerunMakesAllAvailable(scene);
    });
  });
}

// Each cell has its own cache and storage, so cells run side by side.
describe('pull fault matrix', { concurrency: 8 }, () => {
  for (const cell of CELLS) {
    for (const seed of faultSeeds()) {
      test(`pull ${cell.id} seed ${String(seed)}`, (context) => runCell(context, cell, seed));
    }
  }
});
