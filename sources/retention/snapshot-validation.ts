import { isSha256Hex } from '../lock/lock-validation.ts';
import { isPlainObject } from '../config/rules/field-rules.ts';
import type {
  RemoteRetentionRequest,
  RetentionBlocker,
  RetentionObject,
  RetentionRoots,
} from './types.ts';

function hasValidTimeline(request: RemoteRetentionRequest): boolean {
  const hasValidCapture = Number.isSafeInteger(request.capturedAtMs) && request.capturedAtMs >= 0;
  const hasValidNow = Number.isSafeInteger(request.nowMs) && request.nowMs >= request.capturedAtMs;
  return hasValidCapture && hasValidNow;
}

function releaseAssetCount(lock: unknown): number {
  if (!isPlainObject(lock) || !Array.isArray(lock.assets)) return 0;
  return lock.assets.length;
}

function isWithinSnapshotLimits(request: RemoteRetentionRequest): boolean {
  const assetCount = request.releases.reduce(
    (count, release) => count + releaseAssetCount(release.lock),
    0,
  );
  return (
    request.objects.length <= 100_000 && request.releases.length <= 1024 && assetCount <= 100_000
  );
}

export function preflightBlockers(request: RemoteRetentionRequest): RetentionBlocker[] {
  const hasBackup =
    request.hasVerifiedIndependentBackup && request.backupReference.trim().length > 0;
  const hasValidGrace =
    Number.isSafeInteger(request.gracePeriodSeconds) &&
    request.gracePeriodSeconds > 0 &&
    request.gracePeriodSeconds <= 31_536_000;
  const rules: readonly { readonly isValid: boolean; readonly blocker: RetentionBlocker }[] = [
    { isValid: request.isInventoryComplete, blocker: 'INVENTORY_INCOMPLETE' },
    {
      isValid: request.isReleaseCatalogComplete && request.releases.length > 0,
      blocker: 'RELEASE_CATALOG_INCOMPLETE',
    },
    { isValid: hasBackup, blocker: 'BACKUP_UNVERIFIED' },
    { isValid: hasValidTimeline(request), blocker: 'INVALID_TIMELINE' },
    { isValid: request.nowMs - request.capturedAtMs <= 86_400_000, blocker: 'SNAPSHOT_TOO_OLD' },
    { isValid: hasValidGrace, blocker: 'INVALID_GRACE_PERIOD' },
    { isValid: isWithinSnapshotLimits(request), blocker: 'SNAPSHOT_LIMIT_EXCEEDED' },
  ];
  return rules.filter((rule) => !rule.isValid).map((rule) => rule.blocker);
}

function hasKnownObjectKey(key: string, roots: RetentionRoots): boolean {
  return (
    typeof key === 'string' &&
    key.length <= 2048 &&
    roots.prefixes.has(key.slice(0, -64)) &&
    isSha256Hex(key.slice(-64))
  );
}

function hasValidObject(
  object: RetentionObject,
  roots: RetentionRoots,
  capturedAtMs: number,
): boolean {
  const hasValidBytes = Number.isSafeInteger(object.bytes) && object.bytes >= 0;
  const hasValidTime =
    Number.isSafeInteger(object.lastModifiedMs) &&
    object.lastModifiedMs >= 0 &&
    object.lastModifiedMs <= capturedAtMs;
  return hasValidBytes && hasValidTime && hasKnownObjectKey(object.key, roots);
}

function hasUnverifiedReference(
  objects: readonly RetentionObject[],
  roots: RetentionRoots,
): boolean {
  const byKey = new Map(objects.map((object) => [object.key, object.bytes]));
  return [...roots.referencedBytes].some(([key, bytes]) => byKey.get(key) !== bytes);
}

export function inventoryBlockers(
  request: RemoteRetentionRequest,
  roots: RetentionRoots,
): RetentionBlocker[] {
  if (request.objects.some((object) => !hasValidObject(object, roots, request.capturedAtMs)))
    return ['INVALID_INVENTORY_OBJECT'];
  const rules: readonly { readonly isValid: boolean; readonly blocker: RetentionBlocker }[] = [
    {
      isValid: new Set(request.objects.map((object) => object.key)).size === request.objects.length,
      blocker: 'DUPLICATE_INVENTORY_KEY',
    },
    {
      isValid: !hasUnverifiedReference(request.objects, roots),
      blocker: 'REFERENCED_OBJECT_UNVERIFIED',
    },
    {
      isValid: Number.isSafeInteger(
        request.objects.reduce((bytes, object) => bytes + object.bytes, 0),
      ),
      blocker: 'BYTE_TOTAL_UNSAFE',
    },
  ];
  return rules.filter((rule) => !rule.isValid).map((rule) => rule.blocker);
}
