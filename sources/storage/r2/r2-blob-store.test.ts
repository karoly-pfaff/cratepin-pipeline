import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { BlobUpload } from '../../blob-store.ts';
import { collectUntilCancelled } from '../../byte-streams.ts';
import { PipelineError } from '../../errors.ts';
import { FakeS3 } from '../testing/fake-s3.test-support.ts';
import { createR2BlobReader, createR2BlobWriter } from './r2-blob-store.ts';
import { sendS3Request } from './s3-requests.ts';
import { DEFAULT_TRANSFER_SETTINGS } from '../transfer/transfer-settings.ts';
import type { TransferSettings } from '../transfer/transfer-settings.ts';

const KEY = 'cratepin/v1/projects/demo/sources/sha256/abc';
/** Retries without waiting, so tests stay fast. */
const FAST: TransferSettings = { ...DEFAULT_TRANSFER_SETTINGS, delayBeforeRetry: () => 0 };

function uploadOf(content: string, key = KEY): BlobUpload {
  const bytes = Buffer.from(content);
  return {
    key,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    openBody: async function* () {
      yield await Promise.resolve(bytes);
    },
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

/** The reason `promise` rejects with; fails the test if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PipelineError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function readAll(fake: FakeS3, key: string, signal?: AbortSignal): Promise<Buffer> {
  const reader = createR2BlobReader(fake.connection, FAST);
  return collectUntilCancelled(reader.readBlob(key, { signal }), undefined);
}

/** Aborts once the current work has started, i.e. midway through a transfer. */
function abortOnNextTurn(controller: AbortController): void {
  setImmediate(() => {
    controller.abort();
  });
}

function methodsOf(fake: FakeS3): string[] {
  return fake.requests.map((request) => request.method);
}

test('a signed create-only PUT stores the bytes; stat and read return them', async () => {
  await withFakeS3(async (fake) => {
    const writer = createR2BlobWriter(fake.connection, FAST);
    const reader = createR2BlobReader(fake.connection, FAST);
    assert.equal(await reader.statBlob(KEY), undefined);
    assert.equal(await writer.createBlobIfAbsent(uploadOf('original bytes')), 'created');
    assert.deepEqual(await reader.statBlob(KEY), { key: KEY, bytes: 14 });
    assert.equal((await readAll(fake, KEY)).toString(), 'original bytes');
  });
});

test('an existing key is never overwritten: the PUT reports already-exists', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.from('first writer'));
    const writer = createR2BlobWriter(fake.connection, FAST);
    assert.equal(await writer.createBlobIfAbsent(uploadOf('second')), 'already-exists');
    assert.equal(fake.objects.get(KEY)?.toString(), 'first writer');
  });
});

test('bytes that do not match the signed payload hash are refused by the server', async () => {
  await withFakeS3(async (fake) => {
    const lying: BlobUpload = { ...uploadOf('declared'), openBody: uploadOf('actual!!').openBody };
    const writer = createR2BlobWriter(fake.connection, FAST);
    const error = await rejectionOf(writer.createBlobIfAbsent(lying));
    assert.equal(error.code, 'INTEGRITY_MISMATCH');
    assert.equal(fake.objects.size, 0);
  });
});

test('a body longer or shorter than declared is an integrity failure, never retried', async () => {
  await withFakeS3(async (fake) => {
    const writer = createR2BlobWriter(fake.connection, FAST);
    for (const actual of ['declared plus more', 'short']) {
      const lying: BlobUpload = { ...uploadOf('declared'), openBody: uploadOf(actual).openBody };
      const error = await rejectionOf(writer.createBlobIfAbsent(lying));
      assert.equal(error.code, 'INTEGRITY_MISMATCH', actual);
    }
    assert.equal(fake.objects.size, 0);
    assert.ok(fake.requests.length <= 2, 'one attempt each at most');
  });
});

const STATUS_CASES: readonly (readonly [status: number, s3Code: string, code: string])[] = [
  [400, 'InvalidArgument', 'INVALID_DATA'],
  [400, 'RequestTimeout', 'TRANSIENT_TRANSFER'],
  [400, 'BadDigest', 'INTEGRITY_MISMATCH'],
  [401, 'Unauthorized', 'AUTH_FAILED'],
  [403, 'AccessDenied', 'AUTH_FAILED'],
  [408, 'RequestTimeout', 'TRANSIENT_TRANSFER'],
  [404, 'NoSuchKey', 'NOT_FOUND'],
  [409, 'ConditionalRequestConflict', 'TRANSIENT_TRANSFER'],
  [429, 'TooManyRequests', 'TRANSIENT_TRANSFER'],
  [500, 'SomethingNew', 'TRANSIENT_TRANSFER'],
  [499, 'SomethingNew', 'IO_FAILED'],
  [503, 'SlowDown', 'TRANSIENT_TRANSFER'],
  [418, 'Teapot', 'IO_FAILED'],
];

test('statuses and S3 codes map to the error model; details hold no body', async () => {
  await withFakeS3(async (fake) => {
    const reader = createR2BlobReader(fake.connection, { ...FAST, transferAttempts: 1 });
    for (const [status, s3Code, code] of STATUS_CASES) {
      fake.failNext({ method: 'GET', status, s3Code });
      const error = await rejectionOf(collectUntilCancelled(reader.readBlob(KEY), undefined));
      assert.equal(error.code, code, `${String(status)} ${s3Code}`);
      assert.deepEqual(error.details, { status, s3Code, key: KEY });
    }
  });
});

test('transient failures are retried up to the attempt budget; others are not', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.from('content'));
    fake.failNext({ method: 'GET', status: 503, s3Code: 'SlowDown', times: 2 });
    assert.equal((await readAll(fake, KEY)).toString(), 'content');
    fake.failNext({ method: 'HEAD', status: 503, s3Code: 'SlowDown', times: 3 });
    const exhausted = await rejectionOf(createR2BlobReader(fake.connection, FAST).statBlob(KEY));
    assert.equal(exhausted.code, 'TRANSIENT_TRANSFER');
    fake.requests.splice(0);
    fake.failNext({ method: 'HEAD', status: 403, s3Code: 'AccessDenied', times: 3 });
    await rejectionOf(createR2BlobReader(fake.connection, FAST).statBlob(KEY));
    assert.deepEqual(methodsOf(fake), ['HEAD']);
  });
});

test('wrong credentials are an authentication failure whose report holds no signature', async () => {
  await withFakeS3(async (fake) => {
    const forged = {
      ...fake.connection,
      credentials: { accessKeyId: 'someone-else', secretAccessKey: 'wrong-secret-value' },
    };
    const error = await rejectionOf(createR2BlobReader(forged, FAST).statBlob(KEY));
    assert.equal(error.code, 'AUTH_FAILED');
    assert.ok(!JSON.stringify(error.details).includes('wrong-secret'));
  });
});

test('keys with spaces, unicode and reserved characters survive encoding and signing', async () => {
  await withFakeS3(async (fake) => {
    const key = 'prefix/projects/demo/odd name ünnep+&=.png';
    await createR2BlobWriter(fake.connection, FAST).createBlobIfAbsent(uploadOf('odd', key));
    assert.equal(fake.objects.get(key)?.toString(), 'odd');
  });
});

test('keys that URL parsing would rewrite are refused before sending', async () => {
  await withFakeS3(async (fake) => {
    const writer = createR2BlobWriter(fake.connection, FAST);
    for (const key of ['', 'p/a/../b', '../other-bucket/k', 'p/./k', 'p//k', 'p/']) {
      const error = await rejectionOf(writer.createBlobIfAbsent(uploadOf('x', key)));
      assert.equal(error.code, 'INVALID_DATA', key);
    }
    assert.deepEqual(fake.requests, []);
  });
});

test('a HEAD without a usable size is invalid data, not an empty object', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.from('content'));
    fake.objectsWithoutReportedSize.add(KEY);
    const error = await rejectionOf(createR2BlobReader(fake.connection, FAST).statBlob(KEY));
    assert.equal(error.code, 'INVALID_DATA');
  });
});

test('redirects are not followed', async () => {
  await withFakeS3(async (fake) => {
    const elsewhere = await FakeS3.start();
    try {
      elsewhere.objects.set(KEY, Buffer.from('elsewhere'));
      const location = new URL(`/fake-bucket/${KEY}`, elsewhere.connection.endpoint).href;
      fake.failNext({ method: 'HEAD', status: 307, s3Code: 'TemporaryRedirect', location });
      const reader = createR2BlobReader(fake.connection, { ...FAST, transferAttempts: 1 });
      const redirected = await rejectionOf(reader.statBlob(KEY));
      assert.equal(redirected.code, 'CONFIG_INVALID');
      assert.equal(redirected.details.status, 307);
      assert.deepEqual(elsewhere.requests, []);
    } finally {
      await elsewhere.close();
    }
  });
});

test('cancelling a read, also with a custom reason or midway, is CANCELLED', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.alloc(8 * 1024 * 1024));
    const customReason = AbortSignal.abort(new Error('custom reason'));
    assert.equal((await rejectionOf(readAll(fake, KEY, customReason))).code, 'CANCELLED');
    const controller = new AbortController();
    const reading = readAll(fake, KEY, controller.signal);
    abortOnNextTurn(controller);
    assert.equal((await rejectionOf(reading)).code, 'CANCELLED');
  });
});

test('an unreachable endpoint is a transient transfer failure', async () => {
  const closed = await FakeS3.start();
  const unreachable = closed.connection;
  await closed.close();
  const error = await rejectionOf(createR2BlobReader(unreachable, FAST).statBlob(KEY));
  assert.equal(error.code, 'TRANSIENT_TRANSFER');
});

test('a request whose answer does not start in time is a transient failure', async () => {
  await withFakeS3(async (fake) => {
    fake.simulate({ responseDelayMs: 300 });
    const impatient = { ...FAST, transferAttempts: 1, requestTimeoutMs: 50 };
    const error = await rejectionOf(createR2BlobReader(fake.connection, impatient).statBlob(KEY));
    assert.equal(error.code, 'TRANSIENT_TRANSFER');
  });
});

test('a download may take long while it moves, but not stall', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.alloc(10 * 1024, 7));
    fake.simulate({ getBodyPacing: { chunkBytes: 1024, pauseMs: 30 } });
    const patient = { ...FAST, requestTimeoutMs: 150 };
    const reader = createR2BlobReader(fake.connection, patient);
    assert.equal((await collectUntilCancelled(reader.readBlob(KEY), undefined)).length, 10 * 1024);
    fake.simulate({ getBodyPacing: { chunkBytes: 1024, pauseMs: 30, stallAfterBytes: 2048 } });
    const stalled = await rejectionOf(collectUntilCancelled(reader.readBlob(KEY), undefined));
    assert.equal(stalled.code, 'TRANSIENT_TRANSFER');
  });
});

test('only the first 16 KiB of an error body are read for its code', async () => {
  await withFakeS3(async (fake) => {
    fake.failNext({ method: 'GET', status: 503, s3Code: 'SlowDown', paddingBytes: 20_000 });
    const reader = createR2BlobReader(fake.connection, { ...FAST, transferAttempts: 1 });
    const error = await rejectionOf(collectUntilCancelled(reader.readBlob(KEY), undefined));
    assert.deepEqual(error.details, { status: 503, key: KEY });
  });
});

test('query values are sent exactly as they are signed', async () => {
  await withFakeS3(async (fake) => {
    const response = await sendS3Request(fake.connection, {
      method: 'GET',
      query: { prefix: 'a b+c/ü', 'max-keys': '2' },
    });
    await response.arrayBuffer();
    assert.notEqual(response.status, 403);
  });
});

test('a read cancelled after its first chunk ends as CANCELLED', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.alloc(64 * 1024));
    fake.simulate({ getBodyPacing: { chunkBytes: 1024, pauseMs: 5 } });
    const controller = new AbortController();
    const chunks = createR2BlobReader(fake.connection, FAST).readBlob(KEY, {
      signal: controller.signal,
    });
    const iterator = chunks[Symbol.asyncIterator]();
    assert.ok((await iterator.next()).done !== true);
    controller.abort();
    assert.equal((await rejectionOf(iterator.next())).code, 'CANCELLED');
  });
});

function putCountOf(fake: FakeS3): number {
  return methodsOf(fake).filter((method) => method === 'PUT').length;
}

test('a transient PUT failure is sent again with a fresh body; one attempt means one PUT', async () => {
  await withFakeS3(async (fake) => {
    let bodiesOpened = 0;
    const upload = {
      ...uploadOf('content'),
      openBody: async function* opened() {
        bodiesOpened += 1;
        yield await Promise.resolve(Buffer.from('content'));
      },
    };
    fake.failNext({ method: 'PUT', status: 503, s3Code: 'SlowDown' });
    assert.equal(
      await createR2BlobWriter(fake.connection, FAST).createBlobIfAbsent(upload),
      'created',
    );
    assert.equal(bodiesOpened, 2);
    assert.equal(putCountOf(fake), 2);
    fake.requests.splice(0);
    fake.failNext({ method: 'PUT', status: 503, s3Code: 'SlowDown' });
    const writer = createR2BlobWriter(fake.connection, { ...FAST, transferAttempts: 1 });
    const failure = await rejectionOf(writer.createBlobIfAbsent(uploadOf('content', `${KEY}-2`)));
    assert.equal(failure.code, 'TRANSIENT_TRANSFER');
    assert.equal(putCountOf(fake), 1);
  });
});

test('a read-only key can stat and read but storage refuses its PUT as an authentication failure', async () => {
  await withFakeS3(async (fake) => {
    await createR2BlobWriter(fake.connection, FAST).createBlobIfAbsent(uploadOf('kept'));
    const reader = createR2BlobReader(fake.readOnlyConnection, FAST);
    assert.deepEqual(await reader.statBlob(KEY), { key: KEY, bytes: 4 });
    const read = await collectUntilCancelled(reader.readBlob(KEY), undefined);
    assert.equal(read.toString(), 'kept');
    const writer = createR2BlobWriter(fake.readOnlyConnection, FAST);
    const other = `${KEY}-other`;
    const refused = await rejectionOf(writer.createBlobIfAbsent(uploadOf('new', other)));
    assert.equal(refused.code, 'AUTH_FAILED');
    assert.equal(fake.objects.has(other), false);
  });
});
