import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import type { BlobUpload } from '../../blob-store.ts';
import { compareCodeUnits } from '../../catalog/ordering.ts';
import { PipelineError } from '../../errors.ts';
import { FakeS3 } from '../testing/fake-s3.test-support.ts';
import type { FakeS3Request } from '../testing/fake-s3.test-support.ts';
import { partsOf } from './part-splitter.ts';
import { createR2BlobWriter } from '../r2/r2-blob-store.ts';
import { DEFAULT_TRANSFER_SETTINGS } from '../transfer/transfer-settings.ts';
import type { TransferSettings } from '../transfer/transfer-settings.ts';

const KEY = 'p/projects/demo/sources/sha256/large';
/** Tiny parts so tests stay fast; real R2 needs at least 5 MiB per part. */
const SMALL_PARTS: TransferSettings = {
  ...DEFAULT_TRANSFER_SETTINGS,
  multipartThresholdBytes: 4096,
  multipartPartBytes: 1024,
  partConcurrency: 2,
  delayBeforeRetry: () => 0,
};
const CONTENT = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251));

async function* chunksOf(content: Buffer, chunkBytes: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < content.length; offset += chunkBytes) {
    await delay(1);
    yield content.subarray(offset, offset + chunkBytes);
  }
}

function uploadOf(content: Buffer, declared: Buffer = content): BlobUpload {
  return {
    key: KEY,
    bytes: declared.length,
    sha256: createHash('sha256').update(declared).digest('hex'),
    openBody: () => chunksOf(content, 700),
  };
}

async function withFakeS3(useFake: (fake: FakeS3) => Promise<void>): Promise<void> {
  const fake = await FakeS3.start();
  try {
    await useFake(fake);
  } finally {
    await fake.close();
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PipelineError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function requestSummaries(fake: FakeS3): string[] {
  return fake.requests.map(
    ({ method, query }) => `${method} ${query.replace(/uploadId=[^&]+/, 'uploadId=*')}`,
  );
}

function createLarge(fake: FakeS3, upload: BlobUpload, signal?: AbortSignal): Promise<string> {
  return createR2BlobWriter(fake.connection, SMALL_PARTS).createBlobIfAbsent(upload, { signal });
}

function settledWithinDeadline(pending: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    pending.then(
      () => 'created',
      (error: unknown) => error,
    ),
    delay(1000).then(() => 'stalled'),
  ]);
}

function ignoreExpectedFailure(): undefined {
  return undefined;
}

test('a stalled producer cancels promptly and its owned multipart session is aborted', async () => {
  await withFakeS3(async (fake) => {
    const stalled = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const controller = new AbortController();
    const upload = {
      ...uploadOf(CONTENT),
      openBody: async function* (): AsyncGenerator<Uint8Array> {
        stalled.resolve(undefined);
        await release.promise;
        yield CONTENT;
      },
    };
    const pending = createLarge(fake, upload, controller.signal);
    try {
      await stalled.promise;
      controller.abort();
      const settled = await settledWithinDeadline(pending);
      assert.ok(settled instanceof PipelineError);
      assert.equal(settled.code, 'CANCELLED');
      assertCleanedUp(fake);
      assert.ok(fake.requests.some(isAbort));
    } finally {
      release.resolve(undefined);
      await pending.catch(ignoreExpectedFailure);
    }
  });
});

test('multipart stores the declared bytes when its producer reuses a buffer', async () => {
  await withFakeS3(async (fake) => {
    const expected = Buffer.from('abcdxy');
    const upload = {
      ...uploadOf(expected),
      openBody: async function* (): AsyncGenerator<Uint8Array> {
        const buffer = Buffer.from('abcd');
        yield await Promise.resolve(buffer);
        buffer.write('WXYZ');
        yield await Promise.resolve(Buffer.from('xy'));
      },
    };
    const settings = { ...SMALL_PARTS, multipartThresholdBytes: 1, multipartPartBytes: 4 };
    const writer = createR2BlobWriter(fake.connection, settings);
    assert.equal(await writer.createBlobIfAbsent(upload), 'created');
    assert.deepEqual(fake.objects.get(KEY), expected);
    assert.equal(fake.uploads.size, 0);
  });
});

test('a failed part interrupts a stalled source and retains its original failure', async () => {
  await withFakeS3(async (fake) => {
    const release = Promise.withResolvers<undefined>();
    fake.failNext({
      method: 'PUT',
      queryIncludes: 'partNumber=1',
      status: 403,
      s3Code: 'AccessDenied',
    });
    const upload = {
      ...uploadOf(CONTENT),
      openBody: async function* (): AsyncGenerator<Uint8Array> {
        yield await Promise.resolve(CONTENT.subarray(0, 1024));
        yield CONTENT.subarray(1024);
        await release.promise;
      },
    };
    const pending = createLarge(fake, upload);
    try {
      const settled = await settledWithinDeadline(pending);
      assert.ok(settled instanceof PipelineError);
      assert.equal(settled.code, 'AUTH_FAILED');
      assertCleanedUp(fake);
    } finally {
      release.resolve(undefined);
      await pending.catch(ignoreExpectedFailure);
    }
  });
});

const PART_REQUESTS = [1, 2, 3, 4, 5].map(
  (number) => `PUT partNumber=${String(number)}&uploadId=*`,
);

function attemptsOfPart(fake: FakeS3, partNumber: number): number {
  return fake.requests.filter(({ query }) => query.startsWith(`partNumber=${String(partNumber)}&`))
    .length;
}

function etagWithXmlCharacters(content: Buffer): string {
  return `"a&b<${String(content.length)}>"`;
}

/** Two parts' worth of bytes, then a failure, e.g. a source that turned out to be changed. */
async function* failingAfterTwoParts(): AsyncGenerator<Uint8Array> {
  yield await Promise.resolve(CONTENT.subarray(0, 2 * SMALL_PARTS.multipartPartBytes));
  await delay(50);
  throw new PipelineError('INTEGRITY_MISMATCH', 'The source changed.');
}

/** Nothing was stored and no multipart upload was left open. */
function assertCleanedUp(fake: FakeS3): void {
  assert.equal(fake.objects.size, 0);
  assert.equal(fake.uploads.size, 0);
}

test('the body is cut into equal parts; only the last one is shorter', async () => {
  const sizes: number[] = [];
  for await (const part of partsOf(chunksOf(CONTENT, 700), 1024)) sizes.push(part.length);
  assert.deepEqual(sizes, [1024, 1024, 1024, 1024, 904]);
});

test('a large original is uploaded in parts with bounded concurrency and completed once', async () => {
  await withFakeS3(async (fake) => {
    // Slow parts overlap, so the measured peak is the limit itself.
    fake.simulate({ slowQuery: { queryIncludes: 'partNumber', delayMs: 40 } });
    assert.equal(await createLarge(fake, uploadOf(CONTENT)), 'created');
    assert.deepEqual(fake.objects.get(KEY), CONTENT);
    const summaries = requestSummaries(fake);
    assert.deepEqual(summaries.slice(0, 2), ['HEAD ', 'POST uploads=']);
    assert.deepEqual(summaries.slice(2, -1).toSorted(compareCodeUnits), PART_REQUESTS);
    assert.equal(summaries.at(-1), 'POST uploadId=*');
    assert.equal(fake.maxConcurrentByMethod.get('PUT'), 2, 'two parts were in flight at once');
    assert.ok(fake.maxConcurrentParts <= 2);
    assert.equal(fake.uploads.size, 0);
  });
});

test('an existing key is detected before any part is sent', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.from('earlier'));
    assert.equal(await createLarge(fake, uploadOf(CONTENT)), 'already-exists');
    assert.deepEqual(requestSummaries(fake), ['HEAD ']);
  });
});

test('a transient part failure is retried and the upload still completes', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({
      method: 'PUT',
      queryIncludes: 'partNumber=3',
      status: 503,
      s3Code: 'SlowDown',
    });
    assert.equal(await createLarge(fake, uploadOf(CONTENT)), 'created');
    assert.deepEqual(fake.objects.get(KEY), CONTENT);
  });
});

test('a part that keeps failing aborts the upload; nothing is completed', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({
      method: 'PUT',
      queryIncludes: 'partNumber=2',
      status: 503,
      s3Code: 'SlowDown',
      times: 3,
    });
    const error = await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    assert.equal(error.code, 'TRANSIENT_TRANSFER');
    assertCleanedUp(fake);
    assert.ok(requestSummaries(fake).includes('DELETE uploadId=*'));
    assert.ok(!requestSummaries(fake).includes('POST uploadId=*'));
  });
});

test('an authentication failure is not retried and aborts the upload', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({
      method: 'PUT',
      queryIncludes: 'partNumber=2',
      status: 403,
      s3Code: 'AccessDenied',
      times: 3,
    });
    const error = await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    assert.equal(error.code, 'AUTH_FAILED');
    assert.equal(attemptsOfPart(fake, 2), 1);
    assertCleanedUp(fake);
  });
});

test('a failed completion is not retried blindly and aborts the upload', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({
      method: 'POST',
      queryIncludes: 'uploadId=',
      status: 500,
      s3Code: 'InternalError',
    });
    const error = await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    assert.equal(error.code, 'TRANSIENT_TRANSFER');
    assertCleanedUp(fake);
  });
});

test('a source that no longer matches never completes', async () => {
  await withFakeS3(async (fake) => {
    const shorter = CONTENT.subarray(0, 4900);
    const error = await rejectionOf(createLarge(fake, uploadOf(shorter, CONTENT)));
    assert.equal(error.code, 'INTEGRITY_MISMATCH');
    assertCleanedUp(fake);
  });
});

/** An upload whose body cancels the transfer once the first part has been read. */
function uploadCancellingAfterFirstPart(controller: AbortController): BlobUpload {
  const upload = uploadOf(CONTENT);
  return {
    ...upload,
    openBody: async function* () {
      let sentBytes = 0;
      for await (const chunk of upload.openBody()) {
        if (sentBytes > SMALL_PARTS.multipartPartBytes) controller.abort();
        sentBytes += chunk.length;
        yield chunk;
      }
    },
  };
}

test('cancelling midway aborts the started upload and reports CANCELLED', async () => {
  await withFakeS3(async (fake) => {
    const controller = new AbortController();
    const upload = uploadCancellingAfterFirstPart(controller);
    const error = await rejectionOf(createLarge(fake, upload, controller.signal));
    assert.equal(error.code, 'CANCELLED');
    const summaries = requestSummaries(fake);
    assert.ok(summaries.includes('POST uploads=') && summaries.includes('DELETE uploadId=*'));
    assertCleanedUp(fake);
  });
});

test('when even the abort fails, the error names the upload left behind', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({
      method: 'PUT',
      queryIncludes: 'partNumber=1',
      status: 403,
      s3Code: 'AccessDenied',
    });
    fake.failNext({ method: 'DELETE', status: 500, s3Code: 'InternalError', times: 3 });
    const error = await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    assert.equal(error.code, 'AUTH_FAILED');
    assert.equal(fake.uploads.size, 1);
    assert.equal(error.details.abandonedUploadId, [...fake.uploads.keys()][0]);
  });
});

test('a transient abort failure is retried, so nothing is left behind', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({
      method: 'PUT',
      queryIncludes: 'partNumber=1',
      status: 403,
      s3Code: 'AccessDenied',
    });
    fake.failNext({ method: 'DELETE', status: 500, s3Code: 'InternalError' });
    const error = await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    assert.equal(error.details.abandonedUploadId, undefined);
    assertCleanedUp(fake);
  });
});

test('the first failing part cancels the parts still running', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({
      method: 'PUT',
      queryIncludes: 'partNumber=1',
      status: 403,
      s3Code: 'AccessDenied',
    });
    fake.simulate({ slowQuery: { queryIncludes: 'partNumber=2', delayMs: 5000 } });
    const startedAt = performance.now();
    const error = await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    assert.equal(error.code, 'AUTH_FAILED');
    assert.ok(performance.now() - startedAt < 2500, 'part 2 must not be waited for');
  });
});

test('a body of the declared length but other bytes is never completed', async () => {
  await withFakeS3(async (fake) => {
    const changed = Buffer.from(CONTENT);
    changed[2500] = (changed[2500] ?? 0) ^ 0xff;
    const error = await rejectionOf(createLarge(fake, uploadOf(changed, CONTENT)));
    assert.equal(error.code, 'INTEGRITY_MISMATCH');
    assert.ok(!requestSummaries(fake).includes('POST uploadId=*'));
    assertCleanedUp(fake);
  });
});

test('a cancelled upload whose abort fails still names the upload left behind', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({ method: 'DELETE', status: 500, s3Code: 'InternalError', times: 3 });
    const controller = new AbortController();
    const error = await rejectionOf(
      createLarge(fake, uploadCancellingAfterFirstPart(controller), controller.signal),
    );
    assert.equal(error.code, 'CANCELLED');
    assert.equal(fake.uploads.size, 1);
    assert.equal(error.details.abandonedUploadId, [...fake.uploads.keys()][0]);
  });
});

test('a completion answered without its result document is aborted, not trusted', async () => {
  await withFakeS3(async (fake) => {
    fake.simulate({ omitsCompletionResult: true });
    const error = await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    assert.equal(error.code, 'TRANSIENT_TRANSFER');
    assertCleanedUp(fake);
  });
});

test('no part is sent after the abort', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({
      method: 'PUT',
      queryIncludes: 'partNumber=1',
      status: 403,
      s3Code: 'AccessDenied',
    });
    await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    const summaries = requestSummaries(fake);
    const abortAt = summaries.indexOf('DELETE uploadId=*');
    assert.ok(abortAt > 0);
    assert.deepEqual(summaries.slice(abortAt), ['DELETE uploadId=*']);
  });
});

test('an original exactly at the threshold goes up in parts', async () => {
  await withFakeS3(async (fake) => {
    const atThreshold = CONTENT.subarray(0, SMALL_PARTS.multipartThresholdBytes);
    assert.equal(await createLarge(fake, uploadOf(atThreshold)), 'created');
    assert.ok(requestSummaries(fake).includes('POST uploads='));
  });
});

test('part ETags with XML characters are escaped in the completion', async () => {
  await withFakeS3(async (fake) => {
    fake.simulate({ partEtagOf: etagWithXmlCharacters });
    assert.equal(await createLarge(fake, uploadOf(CONTENT)), 'created');
    assert.deepEqual(fake.objects.get(KEY), CONTENT);
  });
});

test('a body that fails while a slow part runs cancels that part too', async () => {
  await withFakeS3(async (fake) => {
    fake.simulate({ slowQuery: { queryIncludes: 'partNumber=1', delayMs: 5000 } });
    const upload = { ...uploadOf(CONTENT), openBody: failingAfterTwoParts };
    const startedAt = performance.now();
    const error = await rejectionOf(createLarge(fake, upload));
    assert.equal(error.code, 'INTEGRITY_MISMATCH');
    assert.ok(performance.now() - startedAt < 2500, 'the slow part must not be waited for');
  });
});

test('a read-only key cannot start a multipart upload: nothing is stored or left open', async () => {
  await withFakeS3(async (fake) => {
    const writer = createR2BlobWriter(fake.readOnlyConnection, SMALL_PARTS);
    const refused = await rejectionOf(writer.createBlobIfAbsent(uploadOf(CONTENT)));
    assert.equal(refused.code, 'AUTH_FAILED');
    assert.equal(fake.objects.size, 0);
    assert.equal(fake.uploads.size, 0);
  });
});

/** Lets another writer create KEY with `content` right before the upload completes. */
function plantBeforeStore(fake: FakeS3, content: Buffer): void {
  fake.beforeNextStore(KEY, () => fake.objects.set(KEY, content));
}

function isAbort({ method }: FakeS3Request): boolean {
  return method === 'DELETE';
}

function isCompletion({ method, query }: FakeS3Request): boolean {
  return method === 'POST' && query.startsWith('uploadId');
}

test('a key another writer created during the upload is never replaced; the upload is aborted', async () => {
  await withFakeS3(async (fake) => {
    const winner = Buffer.from('the other writer was first');
    plantBeforeStore(fake, winner);
    assert.equal(await createLarge(fake, uploadOf(CONTENT)), 'already-exists');
    assert.ok(fake.objects.get(KEY)?.equals(winner), 'the first writer keeps its bytes');
    assert.equal(fake.uploads.size, 0, 'the refused upload was aborted');
  });
});

test('a refused completion whose abort keeps failing names the upload left open', async () => {
  await withFakeS3(async (fake) => {
    plantBeforeStore(fake, Buffer.from('first'));
    fake.failNext({ method: 'DELETE', status: 500, s3Code: 'InternalError', times: 3 });
    const error = await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    assert.equal(error.code, 'TRANSIENT_TRANSFER');
    assert.equal(error.details.abandonedUploadId, [...fake.uploads.keys()][0]);
    assert.equal(fake.requests.filter(isAbort).length, 3, 'one abort round, never repeated');
  });
});

test('a refused completion whose abort recovers after a transient failure is already-exists', async () => {
  await withFakeS3(async (fake) => {
    plantBeforeStore(fake, Buffer.from('first'));
    fake.failNext({ method: 'DELETE', status: 500, s3Code: 'InternalError' });
    assert.equal(await createLarge(fake, uploadOf(CONTENT)), 'already-exists');
    assert.equal(fake.uploads.size, 0);
  });
});

test('a 404 other than NoSuchUpload never counts as aborted: the upload is named as left open', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({
      method: 'PUT',
      queryIncludes: 'partNumber=1',
      status: 403,
      s3Code: 'AccessDenied',
    });
    fake.failNext({ method: 'DELETE', status: 404, s3Code: 'NoSuchBucket' });
    const error = await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    assert.equal(error.details.abandonedUploadId, [...fake.uploads.keys()][0]);
  });
});

test('an upload storage no longer knows counts as aborted: no upload ID is reported left open', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({
      method: 'PUT',
      queryIncludes: 'partNumber=1',
      status: 403,
      s3Code: 'AccessDenied',
    });
    fake.failNext({ method: 'DELETE', status: 404, s3Code: 'NoSuchUpload' });
    const error = await rejectionOf(createLarge(fake, uploadOf(CONTENT)));
    assert.equal(error.code, 'AUTH_FAILED');
    assert.equal(error.details.abandonedUploadId, undefined);
  });
});

test('a completion is sent create-only, so storage can refuse it for an existing key', async () => {
  await withFakeS3(async (fake) => {
    assert.equal(await createLarge(fake, uploadOf(CONTENT)), 'created');
    const completion = fake.requests.find(isCompletion);
    assert.equal(completion?.ifNoneMatch, '*');
  });
});

test('two multipart writers of one key at once: one creates it, the other is refused and aborts', async () => {
  await withFakeS3(async (fake) => {
    const outcomes = await Promise.all([
      createLarge(fake, uploadOf(CONTENT)),
      createLarge(fake, uploadOf(CONTENT)),
    ]);
    assert.deepEqual(outcomes.toSorted(), ['already-exists', 'created']);
    assert.ok(fake.objects.get(KEY)?.equals(CONTENT));
    assert.equal(fake.uploads.size, 0, 'the refused upload was aborted');
    assert.equal(fake.requests.filter(isCompletion).length, 2, 'both reached their completion');
  });
});
