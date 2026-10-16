import { compareCodeUnits } from '../catalog/ordering.ts';
import { retentionRootsOf } from './release-roots.ts';
import { inventoryBlockers, preflightBlockers } from './snapshot-validation.ts';
import type {
  RemoteRetentionPlan,
  RemoteRetentionRequest,
  RetentionBlocker,
  RetentionRoots,
} from './types.ts';

function blockedPlan(blockers: readonly RetentionBlocker[]): RemoteRetentionPlan {
  return {
    schemaVersion: 1,
    isReadOnly: true,
    status: 'blocked',
    blockers,
    candidates: [],
    candidateBytes: 0,
    referencedCount: 0,
    graceRetainedCount: 0,
  };
}

function readyPlan(request: RemoteRetentionRequest, roots: RetentionRoots): RemoteRetentionPlan {
  const unreferenced = request.objects.filter((object) => !roots.referencedBytes.has(object.key));
  const graceMs = request.gracePeriodSeconds * 1000;
  const candidates = unreferenced
    .filter((object) => request.capturedAtMs - object.lastModifiedMs >= graceMs)
    .toSorted((left, right) => compareCodeUnits(left.key, right.key));
  return {
    schemaVersion: 1,
    isReadOnly: true,
    status: 'ready',
    blockers: [],
    candidates: candidates.map((object) => ({ ...object })),
    candidateBytes: candidates.reduce((bytes, object) => bytes + object.bytes, 0),
    referencedCount: request.objects.length - unreferenced.length,
    graceRetainedCount: unreferenced.length - candidates.length,
  };
}

/** Pure dry-run design aid. Never lists, reads or deletes remote objects; ready is not delete authority. */
export function planRemoteRetention(request: RemoteRetentionRequest): RemoteRetentionPlan {
  const preflight = preflightBlockers(request);
  if (preflight.length > 0) return blockedPlan(preflight);
  const roots = retentionRootsOf(request.releases);
  if (roots.blockers.length > 0) return blockedPlan(roots.blockers);
  const inventory = inventoryBlockers(request, roots);
  return inventory.length > 0 ? blockedPlan(inventory) : readyPlan(request, roots);
}
