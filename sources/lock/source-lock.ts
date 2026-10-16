import { createHash } from 'node:crypto';

import type { SourceCatalog } from '../catalog/asset-catalog.ts';
import { compareCodeUnits } from '../catalog/ordering.ts';
import { isBlockingIssue } from '../catalog/source-issues.ts';
import type { MediaCategory, PipelineConfig } from '../config/pipeline-config.ts';
import { PipelineError } from '../errors.ts';

export const LOCK_SCHEMA_VERSION = 1;

/** One pinned original: its identity, its exact bytes and where they are stored. */
export interface SourceRecord {
  readonly id: string;
  readonly source: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly category: MediaCategory;
  readonly objectKey: string;
  readonly locale?: string;
  readonly role?: string;
  readonly profile?: string;
  readonly licence?: string;
}

/** The committed, reviewable list of every original a project's builds may use. */
export interface SourceLock {
  readonly schemaVersion: typeof LOCK_SCHEMA_VERSION;
  readonly projectId: string;
  readonly assets: readonly SourceRecord[];
}

export type LockNamespace = Pick<PipelineConfig, 'objectPrefix' | 'projectId'>;

/** The content-addressed key of an original inside its project's own namespace. */
export function objectKeyFor({ objectPrefix, projectId }: LockNamespace, sha256: string): string {
  return `${objectPrefix}/projects/${projectId}/sources/sha256/${sha256}`;
}

/**
 * The lock a catalog would produce. It is only staged: nothing writes it until every object it
 * references has been verified in storage (see `FinalizedLock`).
 */
export function stageLock(namespace: LockNamespace, catalog: SourceCatalog): SourceLock {
  const blockingCount = catalog.issues.filter(isBlockingIssue).length;
  if (blockingCount > 0) {
    throw new PipelineError('INVALID_DATA', 'A catalog with blocking issues cannot be locked.', {
      issueCount: blockingCount,
    });
  }
  const assets = catalog.assets.map(({ path, ...asset }) => ({
    ...asset,
    source: path,
    objectKey: objectKeyFor(namespace, asset.sha256),
  }));
  return { schemaVersion: LOCK_SCHEMA_VERSION, projectId: namespace.projectId, assets };
}

/** Field order of a serialized record; optional fields appear only when set. */
export const SOURCE_RECORD_FIELDS = [
  'id',
  'source',
  'sha256',
  'bytes',
  'mediaType',
  'category',
  'objectKey',
  'locale',
  'role',
  'profile',
  'licence',
] as const;

export type SourceRecordField = (typeof SOURCE_RECORD_FIELDS)[number];

function canonicalRecord(record: SourceRecord): Readonly<Record<string, unknown>> {
  const presentFields = SOURCE_RECORD_FIELDS.flatMap((field) =>
    record[field] === undefined ? [] : [[field, record[field]]],
  );
  return Object.fromEntries(presentFields) as Readonly<Record<string, unknown>>;
}

/**
 * The lock as committed text: records sorted by ID, fields in a fixed order, two-space
 * indentation and a final newline. It holds no time, machine or absolute path, so the same
 * sources produce the same bytes everywhere.
 */
export function serializeLock(lock: SourceLock): string {
  const assets = lock.assets
    .toSorted((left, right) => compareCodeUnits(left.id, right.id))
    .map(canonicalRecord);
  const document = { schemaVersion: lock.schemaVersion, projectId: lock.projectId, assets };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** SHA-256 of the serialized lock: equal for equal content, whatever order it was built in. */
export function lockDigest(lock: SourceLock): string {
  return createHash('sha256').update(serializeLock(lock)).digest('hex');
}
