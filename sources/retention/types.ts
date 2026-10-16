import type { LockRules } from '../lock/lock-validation.ts';
import type { SourceLock } from '../lock/source-lock.ts';

/** Caller-supplied committed release; the planner validates the lock and namespace. */
export interface RetainedRelease {
  readonly reference: string;
  readonly namespace: LockRules;
  readonly lock: unknown;
}

export interface RetentionObject {
  readonly key: string;
  readonly bytes: number;
  readonly lastModifiedMs: number;
}

/** Completeness/backup assertions belong to the administrator, not to a remote reader. */
export interface RemoteRetentionRequest {
  readonly releases: readonly RetainedRelease[];
  readonly objects: readonly RetentionObject[];
  readonly isInventoryComplete: boolean;
  readonly isReleaseCatalogComplete: boolean;
  readonly hasVerifiedIndependentBackup: boolean;
  readonly backupReference: string;
  readonly capturedAtMs: number;
  readonly nowMs: number;
  readonly gracePeriodSeconds: number;
}

export type RetentionBlocker =
  | 'INVENTORY_INCOMPLETE'
  | 'RELEASE_CATALOG_INCOMPLETE'
  | 'BACKUP_UNVERIFIED'
  | 'INVALID_TIMELINE'
  | 'INVALID_GRACE_PERIOD'
  | 'SNAPSHOT_TOO_OLD'
  | 'SNAPSHOT_LIMIT_EXCEEDED'
  | 'INVALID_RELEASE_LOCK'
  | 'CONFLICTING_RELEASE_BYTES'
  | 'INVALID_INVENTORY_OBJECT'
  | 'DUPLICATE_INVENTORY_KEY'
  | 'REFERENCED_OBJECT_UNVERIFIED'
  | 'BYTE_TOTAL_UNSAFE';

export interface RemoteRetentionPlan {
  readonly schemaVersion: 1;
  readonly isReadOnly: true;
  readonly status: 'blocked' | 'ready';
  readonly blockers: readonly RetentionBlocker[];
  readonly candidates: readonly RetentionObject[];
  readonly candidateBytes: number;
  readonly referencedCount: number;
  readonly graceRetainedCount: number;
}

export interface CheckedRetentionRelease {
  readonly namespace: LockRules;
  readonly lock: SourceLock;
}

export interface RetentionRoots {
  readonly blockers: readonly RetentionBlocker[];
  readonly prefixes: ReadonlySet<string>;
  readonly referencedBytes: ReadonlyMap<string, number>;
}
