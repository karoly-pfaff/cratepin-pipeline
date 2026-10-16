import type { PipelineConfig } from '../../config/pipeline-config.ts';
import { PipelineError } from '../../errors.ts';
import type { SourceLock, SourceRecord } from '../../lock/source-lock.ts';
import { profileSelectorFor } from '../../media/policies/profile-selection.ts';
import type { SelectedProfile } from '../../media/policies/profile-selection.ts';
import { possibleOutputPathsOf } from '../../output/layout/output-paths.ts';
import { outputPathConflicts } from '../../output/layout/path-collisions.ts';
import type { ReportIssue } from '../../report.ts';

/** One locked original, the profile it gets, and every output path that profile may give it. */
export interface PlannedAsset {
  readonly record: SourceRecord;
  readonly profile: SelectedProfile;
  readonly possiblePaths: readonly string[];
}

/** What a build will make, decided from the config and the lock alone; nothing is read yet. */
export interface BuildPlan {
  readonly assets: readonly PlannedAsset[];
  /** Blocking: undefined profiles and output paths that would clash. Empty for a buildable plan. */
  readonly issues: readonly ReportIssue[];
}

type Planning =
  | { readonly asset: PlannedAsset; readonly issue?: never }
  | { readonly asset?: never; readonly issue: ReportIssue };

function planned(record: SourceRecord, select: ReturnType<typeof profileSelectorFor>): Planning {
  try {
    const profile = select(record);
    return {
      asset: { record, profile, possiblePaths: possibleOutputPathsOf(record, profile.policy) },
    };
  } catch (error) {
    if (!(error instanceof PipelineError) || error.details.reason !== 'PROFILE_UNKNOWN')
      throw error;
    return { issue: { path: record.source, code: 'PROFILE_UNKNOWN', message: error.message } };
  }
}

function conflictIssues(assets: readonly PlannedAsset[]): ReportIssue[] {
  const planned = assets.map(({ record, possiblePaths }) => ({
    id: record.id,
    paths: possiblePaths,
  }));
  return outputPathConflicts(planned).map(({ code, path, ids, message }) => ({
    path,
    code,
    message: `${message} (IDs ${ids.map((id) => JSON.stringify(id)).join(', ')})`,
  }));
}

/**
 * Plans the build of every locked original: its profile (assets entry, then rule, then default)
 * and the output paths it may get. An undefined profile or a clash of output paths (ignoring
 * letter case, a file where a directory must be, the reserved manifest name) is found here,
 * before any original is read or anything is written.
 */
export function planBuild(config: PipelineConfig, lock: SourceLock): BuildPlan {
  const select = profileSelectorFor(config);
  const plannings = lock.assets.map((record) => planned(record, select));
  const assets = plannings.flatMap(({ asset }) => (asset === undefined ? [] : [asset]));
  const profileIssues = plannings.flatMap(({ issue }) => (issue === undefined ? [] : [issue]));
  return { assets, issues: [...profileIssues, ...conflictIssues(assets)] };
}
