import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { BlobReader } from '../blob-store.ts';
import { collectUntilCancelled } from '../byte-streams.ts';
import { PipelineError } from '../errors.ts';
import type { PlannedObject } from '../lock/upload-plan.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { FakeS3 } from '../storage/testing/fake-s3.test-support.ts';
import { createR2BlobReader, createR2BlobWriter } from '../storage/r2/r2-blob-store.ts';
import { DEFAULT_TRANSFER_SETTINGS } from '../storage/transfer/transfer-settings.ts';
import type { TransferSettings } from '../storage/transfer/transfer-settings.ts';
import { verifyByReadback } from './object-verification.ts';
import { uploadAndVerify } from './source-upload.ts';
import type { PushStorage } from './source-upload.ts';
import { verifiedSourceBody } from './source-upload-body.ts';

function plannedObjectFor(content: Buffer): PlannedObject {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    objectKey: `p/projects/demo/sources/sha256/${sha256}`,
    sha256,
    bytes: content.length,
    ids: ['a'],
  };
}

/** Retries without waiting, so tests stay fast. */
const FAST: TransferSettings = { ...DEFAULT_TRANSFER_SETTINGS, delayBeforeRetry: () => 0 };

function storageOf(fake: FakeS3): PushStorage {
  return {
    writer: createR2BlobWriter(fake.connection, FAST),
    reader: createR2BlobReader(fake.connection, FAST),
  };
}

function failsWith(code: string) {
  return (error: unknown): boolean => error instanceof PipelineError && error.code === code;
}

interface Scene {
  readonly fake: FakeS3;
  readonly sourcePath: string;
  readonly object: PlannedObject;
}

/** A fake bucket and a scanned source file holding `content`. */
async function withScene(
  content: Buffer,
  useScene: (scene: Scene) => Promise<void>,
): Promise<void> {
  await withWorkspace(async (workspace) => {
    const fake = await FakeS3.start();
    try {
      const sourcePath = join(workspace, 'cat.png');
      await writeFile(sourcePath, content);
      await useScene({ fake, sourcePath, object: plannedObjectFor(content) });
    } finally {
      await fake.close();
    }
  });
}

const CONTENT = Buffer.from('original cat bytes');

/** Changes the file's last byte in place, while another handle may be reading it. */
async function rewriteLastByte(path: string, size: number): Promise<void> {
  const file = await open(path, 'r+');
  try {
    await file.write(Buffer.from([9]), 0, 1, size - 1);
  } finally {
    await file.close();
  }
}

/** How many bytes the upload body passed on before it refused the source. */
async function bytesSentBeforeFailure(sourcePath: string, scanned: Buffer): Promise<number> {
  let sentBytes = 0;
  try {
    for await (const chunk of verifiedSourceBody(sourcePath, plannedObjectFor(scanned))) {
      sentBytes += chunk.length;
    }
  } catch (error) {
    if (error instanceof PipelineError && error.code === 'INTEGRITY_MISMATCH') return sentBytes;
    throw error;
  }
  throw new Error('expected the source to be refused');
}

function methodsOf(fake: FakeS3): string[] {
  return fake.requests.map((request) => request.method);
}

/** Another writer stores `content` under `key` while this upload is in flight. */
function storeConcurrently(fake: FakeS3, key: string, content: Buffer | string): void {
  fake.beforeNextStore(key, () => fake.objects.set(key, Buffer.from(content)));
}

test('a new original is created and proven by hashing the stored bytes', async () => {
  await withScene(CONTENT, async ({ fake, sourcePath, object }) => {
    const uploaded = await uploadAndVerify(storageOf(fake), { object, sourcePath });
    assert.equal(uploaded.outcome, 'created');
    assert.deepEqual(uploaded.verified, {
      objectKey: object.objectKey,
      sha256: object.sha256,
      bytes: object.bytes,
    });
    assert.deepEqual(fake.objects.get(object.objectKey), CONTENT);
    assert.deepEqual(methodsOf(fake), ['PUT', 'GET']);
  });
});

test('a source changed after the scan is never stored, whatever its new size', async () => {
  for (const changed of ['ORIGINAL cat bytes', 'original cat bytes, longer', 'short']) {
    await withScene(CONTENT, async ({ fake, sourcePath, object }) => {
      await writeFile(sourcePath, changed);
      await assert.rejects(
        uploadAndVerify(storageOf(fake), { object, sourcePath }),
        failsWith('INTEGRITY_MISMATCH'),
      );
      assert.equal(fake.objects.size, 0, changed);
    });
  }
});

test('the upload body withholds its last chunk when the file no longer matches', async () => {
  await withWorkspace(async (workspace) => {
    const sourcePath = join(workspace, 'large.bin');
    const scanned = Buffer.alloc(300 * 1024, 1);
    await writeFile(sourcePath, Buffer.concat([scanned.subarray(1), Buffer.from([2])]));
    let sentBytes = 0;
    const consume = async (): Promise<void> => {
      for await (const chunk of verifiedSourceBody(sourcePath, plannedObjectFor(scanned))) {
        sentBytes += chunk.length;
      }
    };
    await assert.rejects(consume(), failsWith('INTEGRITY_MISMATCH'));
    assert.ok(sentBytes < scanned.length, `sent ${String(sentBytes)} of ${String(scanned.length)}`);
  });
});

test('a concurrent writer of the same bytes is accepted after readback', async () => {
  await withScene(CONTENT, async ({ fake, sourcePath, object }) => {
    storeConcurrently(fake, object.objectKey, CONTENT);
    const uploaded = await uploadAndVerify(storageOf(fake), { object, sourcePath });
    assert.equal(uploaded.outcome, 'already-exists');
    assert.equal(uploaded.verified.sha256, object.sha256);
  });
});

test('existing or concurrently written wrong bytes fail and are never replaced', async () => {
  await withScene(CONTENT, async ({ fake, sourcePath, object }) => {
    fake.objects.set(object.objectKey, Buffer.from('something else entirely'));
    await assert.rejects(
      uploadAndVerify(storageOf(fake), { object, sourcePath }),
      failsWith('INTEGRITY_MISMATCH'),
    );
    assert.equal(fake.objects.get(object.objectKey)?.toString(), 'something else entirely');
  });
  await withScene(CONTENT, async ({ fake, sourcePath, object }) => {
    storeConcurrently(fake, object.objectKey, 'racer');
    await assert.rejects(
      uploadAndVerify(storageOf(fake), { object, sourcePath }),
      failsWith('INTEGRITY_MISMATCH'),
    );
    assert.equal(fake.objects.get(object.objectKey)?.toString(), 'racer');
  });
});

test('a failed readback is not a success', async () => {
  await withScene(CONTENT, async ({ fake, sourcePath, object }) => {
    fake.failNext({ method: 'GET', status: 500, s3Code: 'InternalError', times: 3 });
    await assert.rejects(
      uploadAndVerify(storageOf(fake), { object, sourcePath }),
      failsWith('TRANSIENT_TRANSFER'),
    );
  });
});

test('same-size wrong bytes, stored before or by a concurrent writer, fail verification', async () => {
  const sameSizeWrong = 'ORIGINAL CAT BYTES';
  assert.equal(sameSizeWrong.length, CONTENT.length);
  await withScene(CONTENT, async ({ fake, sourcePath, object }) => {
    fake.objects.set(object.objectKey, Buffer.from(sameSizeWrong));
    await assert.rejects(
      uploadAndVerify(storageOf(fake), { object, sourcePath }),
      failsWith('INTEGRITY_MISMATCH'),
    );
  });
  await withScene(CONTENT, async ({ fake, sourcePath, object }) => {
    storeConcurrently(fake, object.objectKey, sameSizeWrong);
    await assert.rejects(
      uploadAndVerify(storageOf(fake), { object, sourcePath }),
      failsWith('INTEGRITY_MISMATCH'),
    );
    assert.equal(fake.objects.get(object.objectKey)?.toString(), sameSizeWrong);
  });
});

test('a source that grew with other content never gets all declared bytes sent', async () => {
  await withWorkspace(async (workspace) => {
    const sourcePath = join(workspace, 'grown.bin');
    const scanned = Buffer.alloc(128 * 1024, 1);
    await writeFile(sourcePath, Buffer.alloc(192 * 1024, 2));
    const sentBytes = await bytesSentBeforeFailure(sourcePath, scanned);
    assert.ok(sentBytes < scanned.length, `sent ${String(sentBytes)} of ${String(scanned.length)}`);
  });
});

test('a source rewritten while it streams is refused before its last chunk', async () => {
  await withWorkspace(async (workspace) => {
    const sourcePath = join(workspace, 'live.bin');
    const scanned = Buffer.alloc(1024 * 1024, 3);
    await writeFile(sourcePath, scanned);
    let sentBytes = 0;
    const streaming = async (): Promise<void> => {
      for await (const chunk of verifiedSourceBody(sourcePath, plannedObjectFor(scanned))) {
        if (sentBytes === 0) await rewriteLastByte(sourcePath, scanned.length);
        sentBytes += chunk.length;
      }
    };
    await assert.rejects(streaming(), failsWith('INTEGRITY_MISMATCH'));
    assert.ok(sentBytes < scanned.length);
  });
});

function isNotFoundAt(path: string) {
  return (error: unknown): boolean =>
    error instanceof PipelineError && error.code === 'NOT_FOUND' && error.details.path === path;
}

test('a source deleted after the scan names its path', async () => {
  await withWorkspace(async (workspace) => {
    const sourcePath = join(workspace, 'gone.png');
    const body = verifiedSourceBody(sourcePath, plannedObjectFor(CONTENT));
    await assert.rejects(collectUntilCancelled(body, undefined), isNotFoundAt(sourcePath));
  });
});

test('a readback stops downloading once the object is larger than expected', async () => {
  let pulledChunks = 0;
  const oversized: BlobReader = {
    statBlob: () => Promise.resolve(undefined),
    readBlob: async function* () {
      for (let index = 0; index < 1000; index += 1) {
        pulledChunks += 1;
        yield await Promise.resolve(new Uint8Array(1024));
      }
    },
  };
  const object = plannedObjectFor(Buffer.alloc(1500));
  await assert.rejects(verifyByReadback(oversized, object), failsWith('INTEGRITY_MISMATCH'));
  assert.equal(pulledChunks, 2);
});
