import { refusalsOf } from '../../building/planning/asset-inspection.ts';
import type { BuildPreview } from '../../building/planning/build-preview.ts';
import type { ExtensionChange } from '../../building/planning/output-changes.ts';
import { PipelineError } from '../../errors.ts';
import type { SourceLock } from '../../lock/source-lock.ts';
import {
  unsafeOutputError,
  unsafeOutputIssues,
  unsafeValueContextOf,
} from '../../output/manifest/manifest-safety.ts';
import { PATH_PRESERVING_WORK_LEFT } from '../../output/generation/generation-recovery.ts';
import { WORK_DIRECTORY_NOT_A_DIRECTORY } from '../../output/ownership/output-claim.ts';
import { outputRootError, outputRootIssue } from '../../output/ownership/root-refusals.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import type { ReportIssue } from '../../report.ts';
import { cacheMissIssue, corruptEntryNotice, recordOutcomes } from './pull-issues.ts';

/** The project, committed lock and offline mode a build or its dry run works on. */
export interface BuildInputs {
  readonly project: CheckedProject;
  readonly lock: SourceLock;
  readonly isOffline: boolean;
}

function unverifiedOriginals({ lock }: BuildInputs, preview: BuildPreview) {
  return recordOutcomes(lock, preview.inspections).filter(
    ({ outcome }) => outcome.state !== 'verified',
  );
}

/** The issue form of the output mode's root refusal, under its reason. */
function rootRefusalIssue(refusal: PipelineError | undefined): ReportIssue | undefined {
  if (refusal === undefined) return undefined;
  return {
    path: String(refusal.details.path),
    code: String(refusal.details.reason),
    message: refusal.message,
  };
}

/** Refusals beyond the root's marker that a build meets before it recovers anything. */
const REFUSED_BEFORE_RECOVERY: readonly unknown[] = [
  WORK_DIRECTORY_NOT_A_DIRECTORY,
  PATH_PRESERVING_WORK_LEFT,
];

/**
 * Whether a build stops before it recovers anything: at the root's marker, at a link or file
 * where the work directory belongs, or at a path-preserving build's work in generation mode.
 */
function isRefusedBeforeRecovery(settings: BuildInputs, preview: BuildPreview): boolean {
  const { outputRoot } = settings.project.paths;
  if (outputRootIssue(preview.rootState, outputRoot) !== undefined) return true;
  return REFUSED_BEFORE_RECOVERY.includes(preview.rootRefusal?.details.reason);
}

/**
 * Notice that a build would first recover what an earlier build left; not when the build is
 * refused before it recovers anything.
 */
export function leftoverNotices(settings: BuildInputs, preview: BuildPreview): ReportIssue[] {
  if (!preview.hasLeftovers || isRefusedBeforeRecovery(settings, preview)) return [];
  const notice = {
    path: settings.project.paths.outputRoot,
    code: 'BUILD_LEFTOVERS_PENDING',
    message:
      'An earlier build left unfinished work; a build first recovers it (in path-preserving mode that may put a previous output back), so this dry run compared with the output as it is now.',
  };
  return [notice];
}

/**
 * Issues that keep a real build of a clean plan from running: the output root it must not
 * touch, originals missing offline, assets it would refuse while converting and, once every
 * output is known, values the scan before publishing would refuse. The report sorts them by
 * path; its error follows the order a build meets them.
 */
export function blockingIssues(settings: BuildInputs, preview: BuildPreview): ReportIssue[] {
  const rootIssue =
    outputRootIssue(preview.rootState, settings.project.paths.outputRoot) ??
    rootRefusalIssue(preview.rootRefusal);
  const offlineMisses = settings.isOffline
    ? unverifiedOriginals(settings, preview).map(({ record }) => cacheMissIssue(record))
    : [];
  return [
    ...(rootIssue ? [rootIssue] : []),
    ...offlineMisses,
    ...refusalsOf(preview.outputs),
    ...unsafeIssuesOf(settings, preview),
  ];
}

/** What the scan a build runs before publishing would flag in the previewed output. */
function unsafeIssuesOf({ project }: BuildInputs, { assembled }: BuildPreview): ReportIssue[] {
  if (assembled === undefined) return [];
  return unsafeOutputIssues(assembled, unsafeValueContextOf(project));
}

/** The refusal of a build's last check before publishing, when the previewed output trips it. */
function unsafeOutputErrorOf({ project }: BuildInputs, { assembled }: BuildPreview) {
  if (assembled === undefined) return undefined;
  return unsafeOutputError(assembled, unsafeValueContextOf(project));
}

/** Corrupt cache entries a build would quarantine (online) or miss (offline). */
export function corruptEntryNotices(settings: BuildInputs, preview: BuildPreview): ReportIssue[] {
  const consequence = settings.isOffline
    ? 'would be quarantined, and offline it cannot be replaced'
    : 'would be quarantined and downloaded again';
  return unverifiedOriginals(settings, preview)
    .filter(({ outcome }) => outcome.state === 'corrupt')
    .map(({ record }) => corruptEntryNotice(record, consequence));
}

export function extensionNotices(changes: readonly ExtensionChange[]): ReportIssue[] {
  return changes.map(({ id, source, outputPath }) => ({
    path: source,
    code: 'EXTENSION_CHANGED',
    message: `"${id}" is published as ${outputPath}; hosts must look this ID up through the manifest.`,
  }));
}

function offlineMissError(missingCount: number): PipelineError {
  return new PipelineError(
    'NOT_FOUND',
    `${String(missingCount)} locked originals are not in the cache; offline mode downloads nothing.`,
    { missingCount },
  );
}

export function refusedAssetsError(failedCount: number): PipelineError {
  return new PipelineError(
    'INVALID_DATA',
    `${String(failedCount)} locked assets cannot be built as configured; see the issues.`,
    { failedCount },
  );
}

/** The plan's problems stop a build before any I/O, as its dry run does. */
export function planProblemsError(problemCount: number): PipelineError {
  return new PipelineError(
    'INVALID_DATA',
    `${String(problemCount)} problems in the build plan keep locked assets from being built; see the issues.`,
    { problemCount },
  );
}

/**
 * The error a real build of a clean plan would fail with, in the order it would meet it: the
 * output root, originals missing offline (counted per stored object, as pull counts them),
 * assets refused while converting, then a manifest or listing that must not ship.
 */
export function blockingError(
  settings: BuildInputs,
  preview: BuildPreview,
): PipelineError | undefined {
  const rootError =
    outputRootError(preview.rootState, settings.project.paths.outputRoot) ?? preview.rootRefusal;
  if (rootError !== undefined) return rootError;
  const missingCount = preview.inspections.filter(({ state }) => state !== 'verified').length;
  if (settings.isOffline && missingCount > 0) return offlineMissError(missingCount);
  const refusalCount = refusalsOf(preview.outputs).length;
  if (refusalCount > 0) return refusedAssetsError(refusalCount);
  return unsafeOutputErrorOf(settings, preview);
}
