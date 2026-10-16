import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import type { TestContext } from 'node:test';

import { catalogSources } from '../catalog/asset-catalog.ts';
import { inventorySources } from '../catalog/inventory.ts';
import { checkedProjectIn, writeSources } from '../catalog/source-fixtures.test-support.ts';
import { serializeLock, stageLock } from '../lock/source-lock.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import { loadCommittedLock } from '../lock/lock-file.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { FakeS3 } from '../storage/testing/fake-s3.test-support.ts';
import type { FakeS3Request, RequestPlan } from '../storage/testing/fake-s3.test-support.ts';
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
import type { FaultTarget, StorageStep } from '../storage/testing/fault-matrix.test-support.ts';
import { createR2BlobReader, createR2BlobWriter } from '../storage/r2/r2-blob-store.ts';
import { DEFAULT_TRANSFER_SETTINGS } from '../storage/transfer/transfer-settings.ts';
import type { TransferSettings } from '../storage/transfer/transfer-settings.ts';
import { pushStagedLock } from './push-run.ts';
import type { PushResult } from './push-run.ts';

// Every cell pushes two new originals (one small, one in five parts) over a lock already
// committed for a third, which the push confirms by readback, with one kind of storage or source
// fault the seed parameterizes, one object and one part at a time so its trace replays exactly.
// Whatever happens, the invariants hold: the lock is either the new one with every object
// proven, or byte for byte the old one; storage holds only exact bytes (or the wrong ones another
// writer planted, never replaced); no upload is left open unless the error names it, except one
// whose start was never answered; and once the faults stop, a rerun commits the lock, unless
// another writer's wrong bytes block it.

const FILE = 'sources/push/push-fault-matrix.test.ts';
const ATTEMPTS = DEFAULT_TRANSFER_SETTINGS.transferAttempts;
const SETTINGS: TransferSettings = {
  ...DEFAULT_TRANSFER_SETTINGS,
  multipartThresholdBytes: 64 * 1024,
  multipartPartBytes: 64 * 1024,
  partConcurrency: 1,
  delayBeforeRetry: () => 0,
};
const PARTS = 5;
const COMMITTED_SOURCES = { 'voice/hi.mp3': 'ID3 committed before the run' };
/** Five parts, each as large as a file read chunk, so a change near the end is read after part 1. */
const LONG = Buffer.from(
  Array.from({ length: 4 * 64 * 1024 + 5000 }, (_, index) => (index * 7) % 251),
);
const NEW_SOURCES = { 'images/cat.png': 'cat bytes', 'music/long.mp3': LONG };
const KEY_PREFIX = 'cratepin/v1/projects/demo/sources/sha256/';

type Expectation = 'succeeds' | 'fails';
type SourceName = keyof typeof NEW_SOURCES;

/**
 * Done once, when the step's first request arrives and before storage answers it: `cancel`
 * cancels the push; `forget-uploads` makes storage drop its open uploads, as a lifecycle rule
 * does, so an abort finds none; `rewrite-long` changes the large source after the scan.
 */
type StepAction = 'cancel' | 'forget-uploads' | 'rewrite-long';

/** Bytes another writer stores under a key right before the push's own write lands. */
interface Planted {
  readonly source: SourceName;
  readonly isWrong: boolean;
}

/** Which original a target hits: the one in parts, the small one or the one already locked. */
type TargetObject = 'long' | 'cat' | 'committed';

interface FaultCell {
  readonly id: string;
  readonly targets: readonly (FaultTarget & { readonly object?: TargetObject })[];
  readonly expect: Expectation;
  readonly planted?: Planted;
  readonly atStep?: { readonly step: StorageStep; readonly action: StepAction };
  /** The start of an upload was never answered, so its ID is unknown and it may stay open. */
  readonly mayLeaveUnknownUpload?: boolean;
  /** The abort itself is faulted, so the error may name the upload it left open. */
  readonly mayNameOpenUpload?: boolean;
}

function sha256Of(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

const KEYS_BY_OBJECT: Record<TargetObject, string> = {
  long: `${KEY_PREFIX}${sha256Of(LONG)}`,
  cat: `${KEY_PREFIX}${sha256Of(NEW_SOURCES['images/cat.png'])}`,
  committed: `${KEY_PREFIX}${sha256Of(COMMITTED_SOURCES['voice/hi.mp3'])}`,
};

const lostAnswer = (): { losesAnswer: true } => ({ losesAnswer: true });

const CELLS: readonly FaultCell[] = [
  {
    id: 'put/transient-once',
    targets: [{ step: 'put', nth: 1, fault: transientRefusal }],
    expect: 'succeeds',
  },
  {
    id: 'put/transient-exhausted',
    targets: [{ step: 'put', nth: 1, times: ATTEMPTS, fault: transientRefusal }],
    expect: 'fails',
  },
  {
    id: 'put/refused',
    targets: [{ step: 'put', nth: 1, fault: permanentRefusal }],
    expect: 'fails',
  },
  {
    id: 'put/stored-answer-lost',
    targets: [{ step: 'put', nth: 1, fault: lostAnswer }],
    expect: 'succeeds',
  },
  {
    id: 'put/other-writer-same-bytes',
    targets: [],
    planted: { source: 'images/cat.png', isWrong: false },
    expect: 'succeeds',
  },
  {
    id: 'put/other-writer-wrong-bytes',
    targets: [],
    planted: { source: 'images/cat.png', isWrong: true },
    expect: 'fails',
  },
  // Changed after the scan, before its upload opens the file (the small original goes first).
  {
    id: 'source/changed-before-upload',
    targets: [],
    atStep: { step: 'put', action: 'rewrite-long' },
    expect: 'fails',
  },
  {
    id: 'source/changed-between-parts',
    targets: [],
    atStep: { step: 'part', action: 'rewrite-long' },
    expect: 'fails',
  },
  {
    id: 'head/transient-once',
    targets: [{ step: 'head', object: 'long', nth: 1, fault: transientRefusal }],
    expect: 'succeeds',
  },
  {
    id: 'head/refused',
    targets: [{ step: 'head', object: 'long', nth: 1, fault: permanentRefusal }],
    expect: 'fails',
  },
  {
    id: 'initiate/transient-once',
    targets: [{ step: 'initiate', nth: 1, fault: transientRefusal }],
    expect: 'succeeds',
  },
  {
    id: 'initiate/transient-exhausted',
    targets: [{ step: 'initiate', nth: 1, times: ATTEMPTS, fault: transientRefusal }],
    expect: 'fails',
  },
  {
    id: 'initiate/refused',
    targets: [{ step: 'initiate', nth: 1, fault: permanentRefusal }],
    expect: 'fails',
  },
  {
    id: 'initiate/started-answer-lost',
    targets: [{ step: 'initiate', nth: 1, fault: lostAnswer }],
    mayLeaveUnknownUpload: true,
    expect: 'succeeds',
  },
  {
    id: 'part/transient-once',
    targets: [{ step: 'part', upTo: PARTS, fault: transientRefusal }],
    expect: 'succeeds',
  },
  {
    id: 'part/transient-exhausted',
    targets: [{ step: 'part', upTo: PARTS, times: ATTEMPTS, fault: transientRefusal }],
    expect: 'fails',
  },
  {
    id: 'part/refused',
    targets: [{ step: 'part', upTo: PARTS, fault: permanentRefusal }],
    expect: 'fails',
  },
  {
    id: 'part/stored-answer-lost',
    targets: [{ step: 'part', upTo: PARTS, fault: lostAnswer }],
    expect: 'succeeds',
  },
  // A completion is sent once: even a transient failure is not repeated.
  {
    id: 'complete/transient-not-retried',
    targets: [{ step: 'complete', nth: 1, fault: transientRefusal }],
    expect: 'fails',
  },
  {
    id: 'complete/refused',
    targets: [{ step: 'complete', nth: 1, fault: permanentRefusal }],
    expect: 'fails',
  },
  {
    id: 'complete/stored-answer-lost',
    targets: [{ step: 'complete', nth: 1, fault: lostAnswer }],
    expect: 'fails',
  },
  {
    id: 'complete/other-writer-same-bytes',
    targets: [],
    planted: { source: 'music/long.mp3', isWrong: false },
    expect: 'succeeds',
  },
  {
    id: 'complete/other-writer-wrong-bytes',
    targets: [],
    planted: { source: 'music/long.mp3', isWrong: true },
    expect: 'fails',
  },
  {
    id: 'abort/fails-after-refused-completion',
    targets: [{ step: 'abort', nth: 1, times: ATTEMPTS, fault: transientRefusal }],
    planted: { source: 'music/long.mp3', isWrong: false },
    mayNameOpenUpload: true,
    expect: 'fails',
  },
  {
    id: 'abort/fails-after-refused-part',
    targets: [
      { step: 'part', upTo: PARTS, fault: permanentRefusal },
      { step: 'abort', nth: 1, times: ATTEMPTS, fault: transientRefusal },
    ],
    mayNameOpenUpload: true,
    expect: 'fails',
  },
  {
    id: 'abort/unknown-upload-after-refused-part',
    targets: [{ step: 'part', upTo: PARTS, fault: permanentRefusal }],
    atStep: { step: 'abort', action: 'forget-uploads' },
    expect: 'fails',
  },
  {
    id: 'abort/aborted-answer-lost-after-refused-part',
    targets: [
      { step: 'part', upTo: PARTS, fault: permanentRefusal },
      { step: 'abort', nth: 1, fault: lostAnswer },
    ],
    expect: 'fails',
  },
  {
    id: 'readback/transient-once',
    targets: [{ step: 'get', fault: transientRefusal }],
    expect: 'succeeds',
  },
  {
    id: 'readback/transient-exhausted',
    targets: [{ step: 'get', nth: 1, times: ATTEMPTS, fault: transientRefusal }],
    expect: 'fails',
  },
  { id: 'readback/refused', targets: [{ step: 'get', fault: permanentRefusal }], expect: 'fails' },
  { id: 'readback/flipped-byte', targets: [{ step: 'get', fault: flippedByte }], expect: 'fails' },
  {
    id: 'readback/wrong-bytes-plausible-headers',
    targets: [{ step: 'get', fault: wrongBytesUnderPlausibleHeaders }],
    expect: 'fails',
  },
  {
    id: 'readback/dropped-before-body',
    targets: [{ step: 'get', fault: droppedBeforeBody }],
    expect: 'succeeds',
  },
  {
    id: 'readback/dropped-mid-body',
    targets: [{ step: 'get', fault: droppedMidBody }],
    expect: 'fails',
  },
  {
    id: 'readback/longer-object',
    targets: [{ step: 'get', fault: extendedBody }],
    expect: 'fails',
  },
  {
    id: 'readback/shorter-object',
    targets: [{ step: 'get', fault: shortenedBody }],
    expect: 'fails',
  },
  {
    id: 'confirm/flipped-byte',
    targets: [{ step: 'get', object: 'committed', nth: 1, fault: flippedByte }],
    expect: 'fails',
  },
  {
    id: 'confirm/refused',
    targets: [{ step: 'get', object: 'committed', nth: 1, fault: permanentRefusal }],
    expect: 'fails',
  },
  {
    id: 'cancel/at-head',
    targets: [],
    atStep: { step: 'head', action: 'cancel' },
    expect: 'fails',
  },
  {
    id: 'cancel/at-initiate',
    targets: [],
    atStep: { step: 'initiate', action: 'cancel' },
    mayLeaveUnknownUpload: true,
    expect: 'fails',
  },
  {
    id: 'cancel/during-put',
    targets: [],
    atStep: { step: 'put', action: 'cancel' },
    expect: 'fails',
  },
  {
    id: 'cancel/during-part',
    targets: [],
    atStep: { step: 'part', action: 'cancel' },
    expect: 'fails',
  },
  {
    id: 'cancel/at-complete',
    targets: [],
    atStep: { step: 'complete', action: 'cancel' },
    expect: 'fails',
  },
  {
    id: 'cancel/during-abort',
    targets: [{ step: 'part', upTo: PARTS, fault: permanentRefusal }],
    atStep: { step: 'abort', action: 'cancel' },
    expect: 'fails',
  },
  {
    id: 'cancel/during-readback',
    targets: [],
    atStep: { step: 'get', action: 'cancel' },
    expect: 'fails',
  },
];

interface Scene {
  readonly workspace: string;
  readonly project: CheckedProject;
  readonly fake: FakeS3;
  /** The committed lock's bytes before the faulted run. */
  readonly lockBefore: string;
}

async function stagedLockOf(project: CheckedProject): Promise<SourceLock> {
  return stageLock(
    project.config,
    catalogSources(await inventorySources(project), project.config.assets),
  );
}

async function committedLockOf(project: CheckedProject): Promise<SourceLock | undefined> {
  const load = await loadCommittedLock(project);
  return load.status === 'valid' ? load.lock : undefined;
}

/** Pushes the sources as scanned before the run; `staged` stays the lock the scan made. */
async function push(scene: Scene, staged: SourceLock, signal?: AbortSignal): Promise<PushResult> {
  const { project, fake } = scene;
  return pushStagedLock({
    project,
    committed: await committedLockOf(project),
    staged,
    storage: {
      writer: createR2BlobWriter(fake.connection, SETTINGS),
      reader: createR2BlobReader(fake.connection, SETTINGS),
    },
    concurrency: 1,
    signal,
  });
}

/** A workspace whose lock already pins one original, plus two new sources to push. */
async function withScene(useScene: (scene: Scene) => Promise<void>): Promise<void> {
  await withWorkspace(async (workspace) => {
    await writeSources(workspace, COMMITTED_SOURCES);
    const fake = await FakeS3.start();
    try {
      const project = await checkedProjectIn(workspace);
      const first = await push(
        { workspace, project, fake, lockBefore: '' },
        await stagedLockOf(project),
      );
      assert.ok(first.ok, 'the lock before the run is committed');
      await writeSources(workspace, NEW_SOURCES);
      const lockBefore = await readFile(project.paths.lockFilePath, 'utf8');
      await useScene({ workspace, project, fake, lockBefore });
    } finally {
      await fake.close();
    }
  });
}

function changedBytesOf(content: Uint8Array | string): Buffer {
  const changed = Buffer.from(content);
  changed[0] = (changed[0] ?? 0) ^ 0xff;
  return changed;
}

/** The planted key and bytes, stored right before the push's own write of that key lands. */
function plantBeforeStore(scene: Scene, planted: Planted): { key: string; bytes: Buffer } {
  const content = Buffer.from(NEW_SOURCES[planted.source]);
  const key = `${KEY_PREFIX}${sha256Of(content)}`;
  const bytes = planted.isWrong ? changedBytesOf(content) : content;
  scene.fake.beforeNextStore(key, () => scene.fake.objects.set(key, bytes));
  return { key, bytes };
}

/** The cell's targets, each limited to the key of the original it names. */
function targetsOf(cell: FaultCell): FaultTarget[] {
  return cell.targets.map(({ object, ...target }) =>
    object === undefined ? target : { ...target, key: KEYS_BY_OBJECT[object] },
  );
}

function sourcePathOf(scene: Scene, source: SourceName): string {
  return join(scene.workspace, 'assets', 'source', ...source.split('/'));
}

/** The source with its last byte changed, so bytes still unread differ from the scan. */
function changedTailOf(content: Uint8Array | string): Buffer {
  const changed = Buffer.from(content);
  changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 0xff;
  return changed;
}

/** Changes a source file at once, before or during its upload; the rerun restores it first. */
function rewriteSource(scene: Scene, source: SourceName): () => void {
  return () => {
    writeFileSync(sourcePathOf(scene, source), changedTailOf(NEW_SOURCES[source]));
  };
}

async function restoreSources(scene: Scene): Promise<void> {
  await writeSources(scene.workspace, NEW_SOURCES);
}

/** The plan, doing the cell's step action once, when that step first arrives. */
function planWithStepAction(
  plan: RequestPlan,
  {
    cell,
    scene,
    controller,
    trace,
  }: { cell: FaultCell; scene: Scene; controller: AbortController; trace: FaultTrace },
): RequestPlan {
  const actions: Record<StepAction, () => void> = {
    cancel: () => {
      controller.abort();
    },
    'forget-uploads': () => {
      scene.fake.uploads.clear();
    },
    'rewrite-long': rewriteSource(scene, 'music/long.mp3'),
  };
  let hasActed = false;
  return (request: FakeS3Request) => {
    if (!hasActed && cell.atStep?.step === stepOf(request)) {
      hasActed = true;
      trace.note(request, cell.atStep.action);
      actions[cell.atStep.action]();
    }
    return plan(request);
  };
}

function assertStorageExact(
  scene: Scene,
  planted: { key: string; bytes: Buffer } | undefined,
): void {
  for (const [key, content] of scene.fake.objects) {
    if (key === planted?.key)
      assert.ok(content.equals(planted.bytes), 'the planted object was never replaced');
    else assert.ok(key.endsWith(sha256Of(content)), `${key} holds other bytes than its name`);
  }
}

/** Upload IDs whose start was answered: the ones the push knows and must abort or name. */
function knownUploadIds(scene: Scene, cell: FaultCell): string[] {
  const open = [...scene.fake.uploads.keys()];
  return cell.mayLeaveUnknownUpload === true ? open.filter((id) => id !== 'upload-1') : open;
}

function assertNoUploadLeftUnnamed(scene: Scene, cell: FaultCell, result: PushResult): void {
  const abandoned = result.ok ? undefined : result.error.details.abandonedUploadId;
  if (cell.mayNameOpenUpload !== true)
    assert.equal(abandoned, undefined, 'every owned upload was aborted');
  const expected = abandoned === undefined ? [] : [abandoned];
  assert.deepEqual(knownUploadIds(scene, cell), expected, 'only an upload the error names is open');
}

/** Every object the push reports as stored is in storage, so a report never claims too much. */
function assertReportedObjectsStored(scene: Scene, result: PushResult): void {
  for (const object of [...result.created, ...result.alreadyStored, ...result.confirmed]) {
    assert.ok(
      scene.fake.objects.has(object.objectKey),
      `${object.objectKey} is reported but missing`,
    );
  }
}

async function assertLockOutcome(
  scene: Scene,
  staged: SourceLock,
  result: PushResult,
): Promise<void> {
  const lock = await readFile(scene.project.paths.lockFilePath, 'utf8');
  if (result.ok) assert.equal(lock, serializeLock(staged));
  else assert.equal(lock, scene.lockBefore, 'a failed push keeps the committed lock byte for byte');
  const leftovers = (await readdir(scene.workspace)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
}

function assertExpectation(cell: FaultCell, result: PushResult): void {
  const message = result.ok
    ? 'the push succeeded'
    : `${result.error.code}: ${result.error.message}`;
  assert.equal(result.ok, cell.expect === 'succeeds', message);
}

/** Once the faults stop, a rerun commits the new lock, unless wrong planted bytes block it. */
async function assertRerunOutcome(
  scene: Scene,
  staged: SourceLock,
  planted: Planted | undefined,
): Promise<void> {
  scene.fake.planRequests(undefined);
  await restoreSources(scene);
  const rerun = await push(scene, staged);
  if (planted?.isWrong === true) {
    assert.ok(!rerun.ok && rerun.error.code === 'INTEGRITY_MISMATCH', 'wrong bytes stay refused');
  } else {
    assert.ok(rerun.ok, rerun.ok ? '' : `${rerun.error.code}: ${rerun.error.message}`);
  }
  await assertLockOutcome(scene, staged, rerun);
}

async function runCell(context: TestContext, cell: FaultCell, seed: number): Promise<void> {
  await withScene(async (scene) => {
    const trace = new FaultTrace();
    const controller = new AbortController();
    const staged = await stagedLockOf(scene.project);
    const planted = cell.planted === undefined ? undefined : plantBeforeStore(scene, cell.planted);
    const plan = faultPlanOf(targetsOf(cell), { seed, trace });
    scene.fake.planRequests(planWithStepAction(plan, { cell, scene, controller, trace }));
    const result = await push(scene, staged, controller.signal);
    const replay = replayCommand(`push ${cell.id}`, seed, FILE);
    await withTraceOnFailure(context, { trace, replay }, async () => {
      assertExpectation(cell, result);
      await assertLockOutcome(scene, staged, result);
      assertStorageExact(scene, planted);
      assertNoUploadLeftUnnamed(scene, cell, result);
      assertReportedObjectsStored(scene, result);
      await assertRerunOutcome(scene, staged, cell.planted);
    });
  });
}

// Each cell has its own workspace and storage, so cells run side by side.
describe('push fault matrix', { concurrency: 8 }, () => {
  for (const cell of CELLS) {
    for (const seed of faultSeeds()) {
      test(`push ${cell.id} seed ${String(seed)}`, (context) => runCell(context, cell, seed));
    }
  }
});

/** The trace of one run of `cell` with `seed`, as text. */
async function traceOf(cell: FaultCell, seed: number): Promise<string> {
  let text = '';
  await withScene(async (scene) => {
    const trace = new FaultTrace();
    scene.fake.planRequests(faultPlanOf(targetsOf(cell), { seed, trace }));
    await push(scene, await stagedLockOf(scene.project));
    text = trace.toString();
  });
  return text;
}

test('a cell run twice with one seed sends the same requests and injects the same faults', async () => {
  for (const id of [
    'part/transient-once',
    'readback/flipped-byte',
    'abort/fails-after-refused-part',
  ]) {
    const cell = CELLS.find((candidate) => candidate.id === id);
    assert.ok(cell !== undefined);
    assert.equal(await traceOf(cell, 7), await traceOf(cell, 7));
  }
});
