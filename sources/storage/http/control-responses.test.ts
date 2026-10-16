import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { collectUntilCancelled } from '../../byte-streams.ts';
import { PipelineError } from '../../errors.ts';
import { FakeS3 } from '../testing/fake-s3.test-support.ts';
import type { FakeS3Request, RequestFault, RequestPlan } from '../testing/fake-s3.test-support.ts';
import { createR2BlobReader, createR2BlobWriter } from '../r2/r2-blob-store.ts';
import { DEFAULT_TRANSFER_SETTINGS } from '../transfer/transfer-settings.ts';

const KEY = 'p/projects/demo/sources/sha256/control';
const CONTENT = Buffer.from('original');
const SETTINGS = {
  ...DEFAULT_TRANSFER_SETTINGS,
  multipartThresholdBytes: 4,
  multipartPartBytes: 4,
  partConcurrency: 1,
  transferAttempts: 3,
  requestTimeoutMs: 2000,
  delayBeforeRetry: () => 0,
};
const PHASES = {
  initiate: { method: 'POST', query: 'uploads=' },
  part: { method: 'PUT', query: 'partNumber=1&' },
  complete: { method: 'POST', query: 'uploadId=' },
  put: { method: 'PUT', query: '' },
  error: { method: 'GET', query: '' },
} as const;
type Phase = keyof typeof PHASES;
type ControlBodyFault = NonNullable<RequestFault['controlBody']>;

function isPhase(request: FakeS3Request, phase: Phase): boolean {
  const match = PHASES[phase];
  return request.method === match.method && request.query.startsWith(match.query);
}

function faultFor(phase: Phase, controlBody: ControlBodyFault): RequestPlan {
  const fault = {
    controlBody,
    ...(phase === 'error' ? { refuse: { status: 503, s3Code: 'SlowDown' } } : {}),
  };
  return (request) => (isPhase(request, phase) ? fault : undefined);
}

function transferFor(fake: FakeS3, phase: Phase, signal: AbortSignal): Promise<unknown> {
  if (phase === 'error') {
    return collectUntilCancelled(
      createR2BlobReader(fake.connection, SETTINGS).readBlob(KEY, { signal }),
      signal,
    );
  }
  const settings = { ...SETTINGS, multipartThresholdBytes: phase === 'put' ? 100 : 4 };
  const writer = createR2BlobWriter(fake.connection, settings);
  return writer.createBlobIfAbsent(controlUpload(), { signal });
}

function controlUpload() {
  return {
    key: KEY,
    bytes: CONTENT.length,
    sha256: createHash('sha256').update(CONTENT).digest('hex'),
    openBody: async function* () {
      yield await Promise.resolve(CONTENT);
    },
  };
}

/** An outer cancellation makes a regression fail rather than hang the complete suite. */
async function failureWithin(fake: FakeS3, phase: Phase): Promise<PipelineError> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 30_000);
  try {
    await transferFor(fake, phase, controller.signal);
  } catch (error) {
    assert.ok(error instanceof PipelineError);
    return error;
  } finally {
    clearTimeout(timer);
  }
  throw new Error('Expected transfer failure');
}

function assertAmbiguousCompletion(fake: FakeS3): void {
  const completions = fake.requests.filter((request) => isPhase(request, 'complete'));
  assert.equal(completions.length, 1, 'ambiguous completion is never repeated');
  assert.equal(completions[0]?.ifNoneMatch, '*');
  assert.equal(fake.requests.at(-1)?.method, 'DELETE', 'owned session is aborted');
}

function assertOwnedUploadOutcome(fake: FakeS3, phase: Phase): void {
  assert.equal(fake.uploads.size, phase === 'initiate' ? 1 : 0);
  const hasStored = phase === 'complete' || phase === 'put';
  assert.equal(fake.objects.size, hasStored ? 1 : 0);
  if (hasStored) assert.deepEqual(fake.objects.get(KEY), CONTENT);
  if (phase === 'complete') assertAmbiguousCompletion(fake);
}

async function checkFault(phase: Phase, fault: ControlBodyFault, code: string): Promise<void> {
  const fake = await FakeS3.start();
  try {
    fake.planRequests(faultFor(phase, fault));
    const failure = await failureWithin(fake, phase);
    assert.equal(failure.code, code);
    assert.ok(
      fake.requests.some((request) => isPhase(request, phase)),
      'the intended control phase was reached',
    );
    if (phase === 'initiate') assert.equal(failure.details.unconfirmedMultipartInitiation, true);
    assertOwnedUploadOutcome(fake, phase);
  } finally {
    await fake.close();
  }
}

for (const phase of Object.keys(PHASES) as Phase[]) {
  test(`${phase}: prompt headers followed by a stalled control body respect the body timeout`, async () => {
    await checkFault(phase, { isStalled: true }, 'TRANSIENT_TRANSFER');
  });
}

for (const phase of ['initiate', 'part', 'complete', 'put'] as const) {
  test(`${phase}: oversized control bodies are refused without accumulating an unlimited response`, async () => {
    await checkFault(phase, { bytes: Buffer.alloc(65_537, 120) }, 'INVALID_DATA');
  });
}

function refusedPartAndStalledAbort(request: FakeS3Request): RequestFault | undefined {
  if (isPhase(request, 'part')) return { refuse: { status: 403, s3Code: 'AccessDenied' } };
  if (request.method === 'DELETE') {
    return { refuse: { status: 503, s3Code: 'SlowDown' }, controlBody: { isStalled: true } };
  }
  return undefined;
}

test('a stalled abort error body settles and reports the owned upload left open', async () => {
  const fake = await FakeS3.start();
  try {
    fake.planRequests(refusedPartAndStalledAbort);
    const failure = await failureWithin(fake, 'part');
    assert.equal(failure.code, 'AUTH_FAILED', 'cleanup retains the original failure');
    assert.equal(fake.uploads.size, 1);
    assert.equal(failure.details.abandonedUploadId, [...fake.uploads.keys()][0]);
    assert.equal(fake.objects.size, 0);
  } finally {
    await fake.close();
  }
});

function abortPastCleanupBudget(request: FakeS3Request): RequestFault | undefined {
  const fault = refusedPartAndStalledAbort(request);
  if (request.method !== 'DELETE') return fault;
  return { ...fault, controlBody: { isStalled: true, releaseAfterMs: 35_000 } };
}

test(
  'the total cleanup budget interrupts a still-live abort before its longer idle deadline',
  { timeout: 45_000 },
  async () => {
    const fake = await FakeS3.start();
    const caller = new AbortController();
    const settings = { ...SETTINGS, transferAttempts: 1, requestTimeoutMs: 60_000 };
    try {
      fake.planRequests(abortPastCleanupBudget);
      const startedAt = performance.now();
      await assert.rejects(
        createR2BlobWriter(fake.connection, settings).createBlobIfAbsent(controlUpload(), {
          signal: caller.signal,
        }),
        (error: unknown) => {
          assert.ok(error instanceof PipelineError);
          assert.equal(
            error.code,
            'AUTH_FAILED',
            'the original part failure survives cleanup timeout',
          );
          assert.equal(error.details.abandonedUploadId, [...fake.uploads.keys()][0]);
          return true;
        },
      );
      const elapsedMs = performance.now() - startedAt;
      assert.ok(elapsedMs >= 29_000 && elapsedMs < 35_000, `cleanup took ${String(elapsedMs)} ms`);
      assert.equal(caller.signal.aborted, false, 'cleanup owns its deadline');
      assert.equal(fake.objects.size, 0);
      assert.equal(fake.uploads.size, 1);
    } finally {
      await fake.close();
    }
  },
);
