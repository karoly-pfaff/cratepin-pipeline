import { PipelineError } from '../errors.ts';
import { serializeLock } from './source-lock.ts';
import type { SourceLock, SourceRecord } from './source-lock.ts';

/**
 * What the code that streamed an object's bytes to or from storage measured: the key, and the
 * SHA-256 and length of the bytes it actually hashed.
 */
export interface VerifiedObject {
  readonly objectKey: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Not exported: code outside this module cannot name it, so it cannot fake the brand below. */
const VERIFIED_IN_STORAGE: unique symbol = Symbol('every object verified in storage');

type Evidence = ReadonlyMap<string, readonly VerifiedObject[]>;

function isEvidenceFor(record: SourceRecord, { sha256, bytes }: VerifiedObject): boolean {
  return sha256 === record.sha256 && bytes === record.bytes;
}

function recordsWithoutEvidence(staged: SourceLock, evidence: Evidence): SourceRecord[] {
  return staged.assets.filter((record) => (evidence.get(record.objectKey) ?? []).length === 0);
}

function recordsWithContradictingEvidence(staged: SourceLock, evidence: Evidence): SourceRecord[] {
  return staged.assets.filter((record) =>
    (evidence.get(record.objectKey) ?? []).some((object) => !isEvidenceFor(record, object)),
  );
}

function unverifiedError(
  code: 'NOT_FOUND' | 'INTEGRITY_MISMATCH',
  records: SourceRecord[],
): PipelineError {
  const message =
    code === 'NOT_FOUND'
      ? 'Some referenced originals are not verified in storage.'
      : 'Stored bytes differ from the staged lock.';
  return new PipelineError(code, message, {
    unverifiedCount: records.length,
    firstUnverifiedId: records[0]?.id ?? '',
  });
}

/** Deep-freezes a copy, so neither TypeScript nor plain JavaScript callers can change it. */
function frozenCopy(lock: SourceLock): SourceLock {
  const assets = Object.freeze(lock.assets.map((record) => Object.freeze({ ...record })));
  return Object.freeze({ ...lock, assets });
}

/**
 * A staged lock whose every referenced object was verified in storage with its exact hash and
 * size. `fromVerifiedObjects` is the only way to create one; it cross-checks the evidence the
 * caller supplies, so it is only as trustworthy as the code that measured that evidence (the
 * transfer code). The committed lock text comes only from here.
 */
export class FinalizedLock {
  /** Makes the type nominal: a plain `{ lock }` object is not a FinalizedLock. */
  readonly [VERIFIED_IN_STORAGE] = true;
  readonly lock: SourceLock;

  private constructor(lock: SourceLock) {
    this.lock = frozenCopy(lock);
    Object.freeze(this);
  }

  /**
   * Every referenced object needs evidence measured in storage by this push, also objects an
   * earlier lock already pinned: storage or the lock may have changed since. Fails with
   * INTEGRITY_MISMATCH naming the first record whose evidence disagrees, else with NOT_FOUND
   * naming the first record without any evidence.
   */
  static fromVerifiedObjects(
    staged: SourceLock,
    measured: readonly VerifiedObject[],
  ): FinalizedLock {
    const evidence = Map.groupBy(measured, (object) => object.objectKey);
    const contradicted = recordsWithContradictingEvidence(staged, evidence);
    if (contradicted.length > 0) throw unverifiedError('INTEGRITY_MISMATCH', contradicted);
    const missing = recordsWithoutEvidence(staged, evidence);
    if (missing.length > 0) throw unverifiedError('NOT_FOUND', missing);
    return new FinalizedLock(staged);
  }

  /** The text to commit as the lock file. */
  committedText(): string {
    return serializeLock(this.lock);
  }
}
