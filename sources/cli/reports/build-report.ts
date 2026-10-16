import { join } from 'node:path';

import { knownOutputsOf, refusalsOf } from '../../building/planning/asset-inspection.ts';
import type { AssetInspection } from '../../building/planning/asset-inspection.ts';
import type { BuildPlan } from '../../building/planning/build-plan.ts';
import type { BuildPreview } from '../../building/planning/build-preview.ts';
import {
  certainOutputsOf,
  extensionChangesOf,
  outputChangesOf,
} from '../../building/planning/output-changes.ts';
import type { ExtensionChange } from '../../building/planning/output-changes.ts';
import { sortedByPath } from '../../catalog/ordering.ts';
import { totalBytes } from '../../lock/upload-plan.ts';
import { RUNTIME_MANIFEST_NAME } from '../../output/layout/output-paths.ts';
import { failedReport, succeededReport } from '../../report.ts';
import type { OperationReport, ReportFacts, ReportRecord } from '../../report.ts';
import {
  blockingError,
  blockingIssues,
  corruptEntryNotices,
  extensionNotices,
  leftoverNotices,
  planProblemsError,
} from './build-issues.ts';
import type { BuildInputs } from './build-issues.ts';

const COMMAND = 'build';

/** Where the output goes and what it is called; known without reading anything. */
export function configuredOutputFacts({ project }: BuildInputs): ReportFacts {
  const { config, paths } = project;
  return {
    projectId: config.projectId,
    outputRoot: paths.outputRoot,
    outputMode: config.outputMode,
    outputUrlPath: config.outputUrlPath,
    manifestFile: join(paths.outputRoot, RUNTIME_MANIFEST_NAME),
  };
}

function outputFacts(settings: BuildInputs, preview: BuildPreview): ReportFacts {
  return {
    ...configuredOutputFacts(settings),
    outputRootState: preview.rootState.state,
    publishedManifest: preview.published.state,
  };
}

/** Offline nothing is downloaded, so misses are reported as missing, not as would-be downloads. */
function originalFacts({ isOffline }: BuildInputs, preview: BuildPreview): ReportFacts {
  const unverified = preview.inspections.filter(({ state }) => state !== 'verified');
  const counts = {
    objectCount: preview.inspections.length,
    cachedCount: preview.inspections.length - unverified.length,
  };
  if (isOffline) return { ...counts, missingCount: unverified.length };
  return {
    ...counts,
    wouldDownloadCount: unverified.length,
    wouldDownloadBytes: totalBytes(unverified.map(({ object }) => object)),
  };
}

function assetFacts(preview: BuildPreview): ReportFacts {
  const known = knownOutputsOf(preview.outputs);
  const { assembled } = preview;
  return {
    assetCount: preview.plan.assets.length,
    copiedCount: known.filter(({ conversion }) => conversion.derivativeUse === 'copied').length,
    reusedCount: known.filter(({ conversion }) => conversion.derivativeUse === 'reused').length,
    wouldConvertCount: preview.outputs.filter((output) => 'wouldConvert' in output).length,
    refusedCount: refusalsOf(preview.outputs).length,
    isPlanComplete: assembled !== undefined,
    ...(assembled === undefined ? {} : { generation: assembled.generation }),
  };
}

/** What a build would do with one asset: copy, reuse, convert, or refuse it. */
function assetRowOf(output: AssetInspection): ReportRecord {
  if ('known' in output) {
    const { record, profileName, outputPath, conversion } = output.known;
    return { id: record.id, profile: profileName, output: conversion.derivativeUse, outputPath };
  }
  if ('wouldConvert' in output) {
    const { record, profile } = output.wouldConvert;
    return { id: record.id, profile: profile.name, output: 'wouldConvert' };
  }
  return { source: output.issue.path, output: 'refused' };
}

function extensionRows(changes: readonly ExtensionChange[]): ReportRecord[] {
  return changes.map(({ id, source, outputPath, fromExtension, toExtension }) => ({
    id,
    source,
    outputPath,
    fromExtension,
    toExtension,
  }));
}

/** Extension changes already certain for the assets a build could make. */
function extensionChangesOfPreview(preview: BuildPreview): ExtensionChange[] {
  const refused = new Set(refusalsOf(preview.outputs).map(({ path }) => path));
  const buildable = preview.plan.assets.filter(({ record }) => !refused.has(record.source));
  return extensionChangesOf(certainOutputsOf(buildable, knownOutputsOf(preview.outputs)));
}

function changeFacts({ lock }: BuildInputs, preview: BuildPreview): ReportFacts {
  const lockIds = lock.assets.map(({ id }) => id);
  const changes = outputChangesOf(lockIds, knownOutputsOf(preview.outputs), preview);
  const pendingIds = preview.outputs.flatMap((output) =>
    'wouldConvert' in output ? [output.wouldConvert.record.id] : [],
  );
  return {
    ...changes,
    pendingIds,
    extensionChanges: extensionRows(extensionChangesOfPreview(preview)),
    assets: preview.outputs.map(assetRowOf),
  };
}

/**
 * The report of a build or its dry run when the plan has problems (clashing output paths,
 * undefined profiles): both stop there before reading anything (exit 8).
 */
export function planProblemsReport(
  settings: BuildInputs,
  plan: BuildPlan,
  { isDryRun }: { readonly isDryRun: boolean },
): OperationReport {
  const facts = {
    ...configuredOutputFacts(settings),
    dryRun: isDryRun,
    lockedAssetCount: settings.lock.assets.length,
    plannedAssetCount: plan.assets.length,
  };
  const error = planProblemsError(plan.issues.length);
  return failedReport(COMMAND, error, { facts, issues: sortedByPath(plan.issues) });
}

/**
 * The report of `build --dry-run` for a clean plan: what a build would read, convert and publish,
 * and what would change. It fails for what the dry run can see would stop that build, in the
 * order the build meets it (an output root it must not touch, originals missing offline, assets
 * it would refuse while converting); nothing was written or transferred.
 */
export function buildPreviewReport(settings: BuildInputs, preview: BuildPreview): OperationReport {
  const facts = {
    ...outputFacts(settings, preview),
    dryRun: true,
    ...originalFacts(settings, preview),
    ...assetFacts(preview),
    ...changeFacts(settings, preview),
  };
  const issues = sortedByPath([
    ...blockingIssues(settings, preview),
    ...leftoverNotices(settings, preview),
    ...corruptEntryNotices(settings, preview),
    ...extensionNotices(extensionChangesOfPreview(preview)),
  ]);
  const error = blockingError(settings, preview);
  return error === undefined
    ? succeededReport(COMMAND, facts, issues)
    : failedReport(COMMAND, error, { facts, issues });
}
