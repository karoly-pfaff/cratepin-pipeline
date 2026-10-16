import {
  couldContainOnAnyPlatform,
  couldOverlapOnAnyPlatform,
} from '../../paths/path-containment.ts';
import { hasWorkDirectorySegment } from '../../paths/layout/output-work-directory.ts';
import { hasProtectedDirectorySegment } from '../../paths/portable-path.ts';
import {
  insideRootMessage,
  overlapMessage,
  PROTECTED_DIRECTORY_MESSAGE,
  WORK_DIRECTORY_MESSAGE,
} from '../../paths/layout/root-messages.ts';
import { assetRelationIssues } from './asset-rules.ts';
import { limitRelationIssues } from './limit-rules.ts';
import { configIssue } from './field-rules.ts';
import { findProfile } from '../pipeline-config.ts';
import type { ConfigIssue, PipelineConfig } from '../pipeline-config.ts';

interface NamedValue {
  readonly path: string;
  readonly value: string;
}

function unknownProfileIssues(config: PipelineConfig): ConfigIssue[] {
  const references: readonly NamedValue[] = [
    { path: '/defaultProfile', value: config.defaultProfile },
    ...config.profileRules.map((rule, index) => ({
      path: `/profileRules/${String(index)}/profile`,
      value: rule.profile,
    })),
  ];
  return references
    .filter((reference) => findProfile(config, reference.value) === undefined)
    .map((reference) => configIssue(reference.path, `Unknown profile "${reference.value}"`));
}

function environmentVariableUses({ r2 }: PipelineConfig): NamedValue[] {
  const readCredentials =
    r2.read.transport === 's3-readonly'
      ? [
          { path: '/r2/read/accessKeyIdEnv', value: r2.read.accessKeyIdEnv },
          { path: '/r2/read/secretAccessKeyEnv', value: r2.read.secretAccessKeyEnv },
        ]
      : [];
  return [
    { path: '/r2/endpointEnv', value: r2.endpointEnv },
    { path: '/r2/bucketEnv', value: r2.bucketEnv },
    { path: '/r2/writer/accessKeyIdEnv', value: r2.writer.accessKeyIdEnv },
    { path: '/r2/writer/secretAccessKeyEnv', value: r2.writer.secretAccessKeyEnv },
    ...readCredentials,
  ];
}

/** One variable per purpose: a shared name would hand the writer key to readers, or a key to logs. */
function reusedVariableIssues(config: PipelineConfig): ConfigIssue[] {
  const uses = environmentVariableUses(config);
  return uses.flatMap((use, index) => {
    const earlierUse = uses.slice(0, index).find((candidate) => candidate.value === use.value);
    if (!earlierUse) return [];
    return [
      configIssue(
        use.path,
        `${use.value} is already used by ${earlierUse.path}; use one variable per purpose`,
      ),
    ];
  });
}

/** The lexical part of root separation; the real file system is checked before any write. */
function overlappingRootIssues(config: PipelineConfig): ConfigIssue[] {
  const directoryRoots: readonly NamedValue[] = [
    { path: '/sourceDir', value: config.sourceDir },
    { path: '/cacheDir', value: config.cacheDir },
    { path: '/outputDir', value: config.outputDir },
  ];
  const nestedRoots = directoryRoots.flatMap((root, index) =>
    directoryRoots
      .slice(0, index)
      .filter((earlierRoot) => couldOverlapOnAnyPlatform(earlierRoot.value, root.value))
      .map((earlierRoot) => configIssue(root.path, overlapMessage(earlierRoot.path))),
  );
  return [
    ...nestedRoots,
    ...directoryRoots.flatMap((root) => lockVersusRootIssues(config.lockFile, root)),
  ];
}

/**
 * No root and no lock may be or lie in a work directory, the project's own next to its output
 * root or that of a sibling root another config publishes into: builds there move and remove
 * whatever their recovery finds under the tool's names.
 */
function workDirectoryIssues(config: PipelineConfig): ConfigIssue[] {
  const locations: readonly NamedValue[] = [
    { path: '/sourceDir', value: config.sourceDir },
    { path: '/cacheDir', value: config.cacheDir },
    { path: '/outputDir', value: config.outputDir },
    { path: '/lockFile', value: config.lockFile },
  ];
  return locations
    .filter((location) => hasWorkDirectorySegment(location.value))
    .map((location) => configIssue(location.path, WORK_DIRECTORY_MESSAGE));
}

/** Direction matters for the message: a lock inside a root, or a lock path that contains one. */
function lockVersusRootIssues(lockFile: string, root: NamedValue): ConfigIssue[] {
  if (couldContainOnAnyPlatform(root.value, lockFile))
    return [configIssue('/lockFile', insideRootMessage(root.path))];
  if (couldContainOnAnyPlatform(lockFile, root.value))
    return [configIssue('/lockFile', overlapMessage(root.path))];
  return [];
}

/** Version-control and dependency directories belong to other tools and are never roots. */
function protectedDirectoryIssues(config: PipelineConfig): ConfigIssue[] {
  const roots: readonly NamedValue[] = [
    { path: '/sourceDir', value: config.sourceDir },
    { path: '/cacheDir', value: config.cacheDir },
    { path: '/outputDir', value: config.outputDir },
  ];
  return roots
    .filter((root) => hasProtectedDirectorySegment(root.value))
    .map((root) => configIssue(root.path, PROTECTED_DIRECTORY_MESSAGE));
}

/** Issues that only appear when fields are compared with each other. */
export function relationIssues(config: PipelineConfig): ConfigIssue[] {
  return [
    ...unknownProfileIssues(config),
    ...reusedVariableIssues(config),
    ...overlappingRootIssues(config),
    ...workDirectoryIssues(config),
    ...protectedDirectoryIssues(config),
    ...assetRelationIssues(config),
    ...limitRelationIssues(config),
  ];
}
