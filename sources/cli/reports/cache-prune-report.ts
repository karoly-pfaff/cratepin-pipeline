import { basename } from 'node:path';

import { ownerDetailsOf } from '../../cache/cache-claims.ts';
import type { FoundClaim } from '../../cache/cache-claims.ts';
import type { CacheFile } from '../../cache/cache-inventory.ts';
import type { PruneResult } from '../../cache/cache-prune-run.ts';
import { sortedByPath } from '../../catalog/ordering.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { failedReport, succeededReport } from '../../report.ts';
import type { OperationReport, ReportFacts, ReportIssue, ReportRecord } from '../../report.ts';

const COMMAND = 'cache prune';

function rowsOf(files: readonly CacheFile[]): ReportRecord[] {
  return files.map(({ kind, name, bytes }) => ({ kind, name, bytes }));
}

function bytesOf(files: readonly CacheFile[]): number {
  return files.reduce((total, file) => total + file.bytes, 0);
}

/** Claims by file name (they all sit in the cache's claims directory) and their checked owner. */
function claimRowsOf(claims: readonly FoundClaim[]): ReportRecord[] {
  return claims.map((found) => ({ claimFile: basename(found.file), ...ownerDetailsOf(found) }));
}

/** What the cache holds for the lock, whatever the prune then did. */
function keptFacts(result: PruneResult): ReportFacts {
  const { plan } = result;
  if (plan === undefined) return { cacheExists: result.cacheExists };
  return {
    cacheExists: true,
    referencedCount: plan.referenced.length,
    referencedBytes: bytesOf(plan.referenced),
    missingReferencedCount: plan.missingReferencedCount,
    referencedDerivativeFileCount: plan.referencedDerivatives.length,
    referencedDerivativeFileBytes: bytesOf(plan.referencedDerivatives),
    unknownNames: plan.unknownNames,
  };
}

function removalFacts(result: PruneResult, isDryRun: boolean): ReportFacts {
  const removable = result.plan?.removable ?? [];
  if (isDryRun) {
    return {
      wouldRemove: rowsOf(removable),
      wouldRemoveBytes: bytesOf(removable),
      deadClaimFiles: result.deadClaimFiles.map((file) => basename(file)),
      liveClaims: claimRowsOf(result.liveClaims),
    };
  }
  const removed = result.removal?.removed ?? [];
  return {
    removed: rowsOf(removed),
    removedBytes: bytesOf(removed),
    removedDeadClaimCount: result.deadClaimFiles.length,
  };
}

function noticesOf(result: PruneResult): ReportIssue[] {
  const corrupt = (result.plan?.corruptReferenced ?? []).map((file) => ({
    path: file.name,
    code: 'CACHE_CORRUPT',
    message: 'This referenced entry does not hold the locked bytes; the next pull quarantines it.',
  }));
  const unknown = (result.plan?.unknownNames ?? []).map((name) => ({
    path: name,
    code: 'UNKNOWN_CACHE_NAME',
    message: 'Not part of the cache layout; left untouched.',
  }));
  const inUse = result.liveClaims.map(({ file }) => ({
    path: basename(file),
    code: 'CACHE_IN_USE',
    message: 'A run holds this claim; a real prune refuses until it ends or the file is removed.',
  }));
  return sortedByPath([...corrupt, ...unknown, ...inUse]);
}

/** The report of `cache prune`: kept, removed (or removable) and unknown files, by name. */
export function cachePruneReport(
  project: CheckedProject,
  result: PruneResult,
  isDryRun: boolean,
): OperationReport {
  const facts = {
    projectId: project.config.projectId,
    cacheRoot: project.paths.cacheRoot,
    lockFilePath: project.paths.lockFilePath,
    ...keptFacts(result),
    ...removalFacts(result, isDryRun),
  };
  const error = result.removal?.error;
  const issues = noticesOf(result);
  return error === undefined
    ? succeededReport(COMMAND, facts, issues)
    : failedReport(COMMAND, error, { facts, issues });
}
