import assert from 'node:assert/strict';
import test from 'node:test';

import { collectUntilCancelled } from '../../byte-streams.ts';
import { PipelineError } from '../../errors.ts';
import { FakeS3 } from '../testing/fake-s3.test-support.ts';
import { createPublicHttpBlobReader } from './public-http-reader.ts';
import { DEFAULT_TRANSFER_SETTINGS } from '../transfer/transfer-settings.ts';
import type { TransferSettings } from '../transfer/transfer-settings.ts';

const KEY = 'cratepin/v1/projects/demo/sources/sha256/abc';
/** Retries without waiting, so tests stay fast. */
const FAST: TransferSettings = { ...DEFAULT_TRANSFER_SETTINGS, delayBeforeRetry: () => 0 };

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

function isAnyRequestSigned(fake: FakeS3): boolean {
  return fake.requests.some((request) => request.isSigned);
}

function methodsOf(fake: FakeS3): string[] {
  return fake.requests.map((request) => request.method);
}

function abortAfter(controller: AbortController, milliseconds: number): void {
  setTimeout(() => {
    controller.abort();
  }, milliseconds);
}

function readAll(fake: FakeS3, settings = FAST, signal?: AbortSignal): Promise<Buffer> {
  const reader = createPublicHttpBlobReader(fake.publicBaseUrl, settings);
  return collectUntilCancelled(reader.readBlob(KEY, { signal }), undefined);
}

test('objects are read and stat-ed anonymously from the public base URL', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.from('public bytes'));
    const reader = createPublicHttpBlobReader(fake.publicBaseUrl, FAST);
    assert.deepEqual(await reader.statBlob(KEY), { key: KEY, bytes: 12 });
    assert.equal((await readAll(fake)).toString(), 'public bytes');
    assert.equal(await reader.statBlob(`${KEY}-absent`), undefined);
    assert.equal(isAnyRequestSigned(fake), false);
    assert.deepEqual(methodsOf(fake), ['HEAD', 'GET', 'HEAD']);
  });
});

test('a base URL with a path keeps it, with or without a final slash', async () => {
  await withFakeS3(async (fake) => {
    const nestedKey = 'games/demo/a b+c.png';
    fake.objects.set(nestedKey, Buffer.from('nested'));
    const base = new URL(`${fake.publicBaseUrl.href}/games`);
    for (const baseUrl of [base, new URL(`${base.href}/`)]) {
      const reader = createPublicHttpBlobReader(baseUrl, FAST);
      const content = await collectUntilCancelled(reader.readBlob('demo/a b+c.png'), undefined);
      assert.equal(content.toString(), 'nested');
    }
  });
});

test('a missing object is NOT_FOUND and a refused one AUTH_FAILED, neither retried', async () => {
  await withFakeS3(async (fake) => {
    assert.equal((await rejectionOf(readAll(fake))).code, 'NOT_FOUND');
    fake.failNext({ method: 'GET', status: 403, s3Code: 'AccessDenied', times: 5 });
    const refused = await rejectionOf(readAll(fake));
    assert.equal(refused.code, 'AUTH_FAILED');
    assert.deepEqual(refused.details, { status: 403, key: KEY });
    assert.equal(fake.requests.length, 2);
  });
});

test('throttling and server errors are retried; other statuses are not', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.from('eventually'));
    fake.failNext({ method: 'GET', status: 503, s3Code: 'Unavailable' });
    fake.failNext({ method: 'GET', status: 429, s3Code: 'TooMany' });
    assert.equal((await readAll(fake)).toString(), 'eventually');
    fake.failNext({ method: 'GET', status: 418, s3Code: 'Teapot' });
    const unexpected = await rejectionOf(readAll(fake));
    assert.equal(unexpected.code, 'IO_FAILED');
    assert.equal(fake.requests.length, 4);
  });
});

test('redirects are refused, so nothing is read from elsewhere', async () => {
  await withFakeS3(async (fake) => {
    const elsewhere = await FakeS3.start();
    try {
      elsewhere.objects.set(KEY, Buffer.from('elsewhere'));
      const location = new URL(`public/${KEY}`, elsewhere.connection.endpoint).href;
      fake.failNext({ method: 'GET', status: 302, s3Code: 'Found', location });
      const redirected = await rejectionOf(readAll(fake, { ...FAST, transferAttempts: 1 }));
      assert.equal(redirected.code, 'CONFIG_INVALID');
      assert.deepEqual(redirected.details, { status: 302, key: KEY });
      assert.deepEqual(elsewhere.requests, []);
    } finally {
      await elsewhere.close();
    }
  });
});

test('keys that URL parsing would rewrite are refused before sending', async () => {
  await withFakeS3(async (fake) => {
    const reader = createPublicHttpBlobReader(fake.publicBaseUrl, FAST);
    const error = await rejectionOf(reader.statBlob('a/../b'));
    assert.equal(error.code, 'INVALID_DATA');
    assert.deepEqual(fake.requests, []);
  });
});

test('a cut connection or a stalled body fails as transient', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.alloc(8192, 1));
    fake.simulate({ getBodyPacing: { chunkBytes: 1024, pauseMs: 5, dropAfterBytes: 4096 } });
    assert.equal((await rejectionOf(readAll(fake))).code, 'TRANSIENT_TRANSFER');
    fake.simulate({ getBodyPacing: { chunkBytes: 1024, pauseMs: 5, stallAfterBytes: 2048 } });
    const impatient = { ...FAST, requestTimeoutMs: 100 };
    assert.equal((await rejectionOf(readAll(fake, impatient))).code, 'TRANSIENT_TRANSFER');
  });
});

test('a HEAD without a valid size is invalid data, not an empty object', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.from('content'));
    fake.objectsWithoutReportedSize.add(KEY);
    const reader = createPublicHttpBlobReader(fake.publicBaseUrl, FAST);
    assert.equal((await rejectionOf(reader.statBlob(KEY))).code, 'INVALID_DATA');
  });
});

test('cancelling a read midway is CANCELLED', async () => {
  await withFakeS3(async (fake) => {
    fake.objects.set(KEY, Buffer.alloc(64 * 1024));
    fake.simulate({ getBodyPacing: { chunkBytes: 1024, pauseMs: 5 } });
    const controller = new AbortController();
    const reading = readAll(fake, FAST, controller.signal);
    abortAfter(controller, 30);
    assert.equal((await rejectionOf(reading)).code, 'CANCELLED');
  });
});

test('writes to the public path are refused by the fake, as by a public bucket', async () => {
  await withFakeS3(async (fake) => {
    const response = await fetch(`${fake.publicBaseUrl.href}/${KEY}`, { method: 'PUT', body: 'x' });
    assert.equal(response.status, 403);
    assert.equal(fake.objects.has(KEY), false);
  });
});
