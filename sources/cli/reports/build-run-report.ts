import type { BuiltAsset } from '../../building/assembly/asset-outputs.ts';
import type { BuildResult } from '../../building/build-run.ts';
import { extensionChangesOf } from '../../building/planning/output-changes.ts';
import { sortedByPath } from '../../catalog/ordering.ts';
import { savingsReportOf } from '../../derivatives/savings-report.ts';
import type { PipelineError } from '../../errors.ts';
import { failedReport, succeededReport } from '../../report.ts';
import type { OperationReport, ReportFacts, ReportIssue } from '../../report.ts';
import { extensionNotices, refusedAssetsError } from './build-issues.ts';
import type { BuildInputs } from './build-issues.ts';
import { configuredOutputFacts, planProblemsReport } from './build-report.ts';
import { recordOutcomes } from './pull-issues.ts';
import { retrievalFacts, retrievalFailureOf, retrievalIssuesOf } from './pull-report.ts';

const COMMAND = 'build';

function removedFileCountOf({ recovery, publication }: BuildResult): number {
  return (recovery?.removedFileCount ?? 0) + (publication?.removedFileCount ?? 0);
}

/** In generation mode, the generation the replaced manifest named, which was kept. */
function generationModeFacts({ publication }: BuildResult): ReportFacts {
  const previousGeneration = publication?.previousGeneration;
  return previousGeneration === undefined ? {} : { previousGeneration };
}

function publicationFacts(result: BuildResult): ReportFacts {
  const { recovery, publication, assembled } = result;
  return {
    publication: publication?.outcome ?? 'not-published',
    recovery: recovery?.outcome ?? 'none',
    removedFileCount: removedFileCountOf(result),
    ...(assembled === undefined ? {} : { generation: assembled.generation }),
    ...generationModeFacts(result),
  };
}

/** Real sizes per asset and in total, as measured; savings may be zero or negative. */
function savingsFacts(built: readonly BuiltAsset[]): ReportFacts {
  const { assets, totals } = savingsReportOf(
    built.map(({ record, profileName, conversion }) => ({
      id: record.id,
      source: record.source,
      profile: profileName,
      conversion,
    })),
  );
  const { derivativeUses } = totals;
  return {
    assetCount: totals.assetCount,
    sourceBytes: totals.sourceBytes,
    outputBytes: totals.outputBytes,
    savedBytes: totals.savedBytes,
    grewCount: totals.grewCount,
    copiedCount: derivativeUses.copied,
    reusedCount: derivativeUses.reused,
    madeCount: derivativeUses.made,
    remadeCount: derivativeUses.remade,
    assets: assets.map((asset) => ({ ...asset })),
  };
}

/** What the conversions said about each asset, such as SIZE_GREW, at its source. */
function conversionNotices(built: readonly BuiltAsset[]): ReportIssue[] {
  return built.flatMap(({ record, conversion }) =>
    conversion.notices.map(({ code, message }) => ({ path: record.source, code, message })),
  );
}

/** Sizes are facts only once every asset was built; a build stopped earlier measured none. */
function isEveryAssetBuilt({ built }: BuildResult): boolean {
  return built?.issues.length === 0;
}

function builtOf(result: BuildResult): readonly BuiltAsset[] {
  return result.built?.issues.length === 0 ? result.built.built : [];
}

/** Notices of what the build found and did around its outputs: recovery and publication. */
function workNotices({ recovery, publication }: BuildResult): ReportIssue[] {
  return [...(recovery?.notices ?? []), ...(publication?.notices ?? [])];
}

function issuesOf(settings: BuildInputs, result: BuildResult): ReportIssue[] {
  const built = builtOf(result);
  return sortedByPath([
    ...workNotices(result),
    ...retrievalIssuesOf(settings.lock, result.originals ?? []),
    ...(result.built?.issues ?? []),
    ...extensionNotices(extensionChangesOf(built)),
    ...conversionNotices(built),
  ]);
}

/** Why a build stopped before converting or publishing: originals it could not get, or refusals. */
function inputStopOf(settings: BuildInputs, result: BuildResult): PipelineError | undefined {
  const originals = result.originals ?? [];
  const retrievalFailure = retrievalFailureOf(recordOutcomes(settings.lock, originals), originals);
  if (retrievalFailure !== undefined) return retrievalFailure;
  const refusedCount = result.built?.issues.length ?? 0;
  return refusedCount > 0 ? refusedAssetsError(refusedCount) : undefined;
}

/** Why a build that did not publish stopped: a failure after recovery, else its inputs. */
function stopOf(settings: BuildInputs, result: BuildResult): PipelineError | undefined {
  return result.failure ?? inputStopOf(settings, result);
}

/**
 * The report of a real build: whether it published (or found the output unchanged), what it
 * recovered and removed, the originals it read, every asset's real sizes and the totals, and
 * every extension change. A build that stopped early fails with its reason and publishes nothing.
 */
export function buildRunReport(settings: BuildInputs, result: BuildResult): OperationReport {
  if (result.plan.issues.length > 0)
    return planProblemsReport(settings, result.plan, { isDryRun: false });
  const facts = {
    ...configuredOutputFacts(settings),
    dryRun: false,
    ...publicationFacts(result),
    ...(result.originals === undefined ? {} : retrievalFacts(result.originals)),
    ...(isEveryAssetBuilt(result) ? savingsFacts(builtOf(result)) : {}),
  };
  const issues = issuesOf(settings, result);
  const stop = stopOf(settings, result);
  return stop === undefined
    ? succeededReport(COMMAND, facts, issues)
    : failedReport(COMMAND, stop, { facts, issues });
}
