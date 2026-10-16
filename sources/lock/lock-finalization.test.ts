import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Of } from '../catalog/source-fixtures.test-support.ts';
import { PipelineError } from '../errors.ts';
import { FinalizedLock } from './lock-finalization.ts';
import type { VerifiedObject } from './lock-finalization.ts';
import { objectKeyFor, serializeLock } from './source-lock.ts';
import type { SourceLock, SourceRecord } from './source-lock.ts';

const NAMESPACE = { objectPrefix: 'cratepin/v1', projectId: 'demo' };

function record(id: string): SourceRecord {
  const sha256 = sha256Of(id);
  return {
    id,
    source: `${id}.png`,
    sha256,
    bytes: id.length,
    mediaType: 'image/png',
    category: 'image',
    objectKey: objectKeyFor(NAMESPACE, sha256),
  };
}

function stagedLock(): SourceLock {
  return { schemaVersion: 1, projectId: 'demo', assets: [record('a'), record('b')] };
}

function measured({ objectKey, sha256, bytes }: SourceRecord): VerifiedObject {
  return { objectKey, sha256, bytes };
}

function failure(code: string, firstUnverifiedId: string, unverifiedCount: number) {
  return (error: unknown): boolean =>
    error instanceof PipelineError &&
    error.code === code &&
    error.details.firstUnverifiedId === firstUnverifiedId &&
    error.details.unverifiedCount === unverifiedCount;
}

test('a staged lock is finalized when every referenced object is verified, in any order', () => {
  const staged = stagedLock();
  const [first, second] = staged.assets;
  assert.ok(first && second);
  const finalized = FinalizedLock.fromVerifiedObjects(staged, [measured(second), measured(first)]);
  assert.deepEqual(finalized.lock, staged);
  assert.equal(finalized.committedText(), serializeLock(staged));
});

test('objects without evidence are NOT_FOUND; nothing is finalized', () => {
  const staged = stagedLock();
  const [, second] = staged.assets;
  assert.ok(second);
  assert.throws(
    () => FinalizedLock.fromVerifiedObjects(staged, [measured(second)]),
    failure('NOT_FOUND', 'a', 1),
  );
  assert.throws(() => FinalizedLock.fromVerifiedObjects(staged, []), failure('NOT_FOUND', 'a', 2));
});

test('evidence with other bytes, another size or a contradiction is INTEGRITY_MISMATCH', () => {
  const staged = stagedLock();
  const [first, second] = staged.assets;
  assert.ok(first && second);
  const wrongHash = { ...measured(first), sha256: sha256Of('tampered') };
  const wrongSize = { ...measured(second), bytes: second.bytes + 1 };
  assert.throws(
    () => FinalizedLock.fromVerifiedObjects(staged, [wrongHash, wrongSize]),
    failure('INTEGRITY_MISMATCH', 'a', 2),
  );
  assert.throws(
    () => FinalizedLock.fromVerifiedObjects(staged, [wrongSize]),
    failure('INTEGRITY_MISMATCH', 'b', 1),
  );
  assert.throws(
    () => FinalizedLock.fromVerifiedObjects(staged, [measured(first), wrongHash, measured(second)]),
    failure('INTEGRITY_MISMATCH', 'a', 1),
  );
});

test('the finalized lock is a frozen copy: neither the staged lock nor callers can change it', () => {
  const staged = stagedLock();
  const finalized = FinalizedLock.fromVerifiedObjects(staged, staged.assets.map(measured));
  (staged.assets as SourceRecord[]).push(record('unverified'));
  assert.equal(finalized.lock.assets.length, 2);
  assert.throws(() => (finalized.lock.assets as SourceRecord[]).push(record('evil')), TypeError);
  assert.ok(Object.isFrozen(finalized.lock) && Object.isFrozen(finalized.lock.assets[0]));
  assert.ok(!Object.isFrozen(staged.assets[0]), 'the caller keeps its own, unfrozen records');
  assert.throws(() => {
    Object.assign(finalized, { lock: stagedLock() });
  }, TypeError);
});

function committedTextOf(finalized: FinalizedLock): string {
  return finalized.committedText();
}

test('a plain object with a lock is not accepted where a FinalizedLock is required', () => {
  const lookalike = { lock: stagedLock(), committedText: () => '' };
  // @ts-expect-error Only verification can produce a FinalizedLock; typecheck fails if this compiles.
  assert.equal(committedTextOf(lookalike), '');
});
