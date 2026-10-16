import { defaultConfig } from '../config/pipeline-config.ts';
import { validateConfig } from '../config/validation.ts';
import { validateLock } from '../lock/lock-validation.ts';
import type { CheckedRetentionRelease, RetainedRelease, RetentionRoots } from './types.ts';

function hasValidNamespace(release: RetainedRelease): boolean {
  const defaults = defaultConfig();
  const { namespace } = release;
  return validateConfig({
    ...defaults,
    projectId: namespace.projectId,
    objectPrefix: namespace.objectPrefix,
    limits: { ...defaults.limits, maxSourceBytes: namespace.limits.maxSourceBytes },
  }).ok;
}

function checkedRelease(release: RetainedRelease): CheckedRetentionRelease | undefined {
  if (!hasValidNamespace(release) || release.reference.trim().length === 0) return undefined;
  const validation = validateLock(release.lock, release.namespace);
  return validation.ok ? { namespace: release.namespace, lock: validation.lock } : undefined;
}

function referencedBytesOf(
  releases: readonly CheckedRetentionRelease[],
): Map<string, number> | undefined {
  const assets = releases.flatMap((release) => release.lock.assets);
  const referenced = new Map<string, number>();
  for (const asset of assets) {
    const previousBytes = referenced.get(asset.objectKey);
    if (previousBytes !== undefined && previousBytes !== asset.bytes) return undefined;
    referenced.set(asset.objectKey, asset.bytes);
  }
  return referenced;
}

function emptyRetentionRoots(blockers: RetentionRoots['blockers']): RetentionRoots {
  return { blockers, prefixes: new Set(), referencedBytes: new Map() };
}

function rootsOfCheckedReleases(releases: readonly CheckedRetentionRelease[]): RetentionRoots {
  const referencedBytes = referencedBytesOf(releases);
  if (!referencedBytes) return emptyRetentionRoots(['CONFLICTING_RELEASE_BYTES']);
  const prefixes = releases.map(
    ({ namespace }) => `${namespace.objectPrefix}/projects/${namespace.projectId}/sources/sha256/`,
  );
  return { blockers: [], prefixes: new Set(prefixes), referencedBytes };
}

export function retentionRootsOf(releases: readonly RetainedRelease[]): RetentionRoots {
  const checked = releases.map(checkedRelease);
  if (checked.some((release) => release === undefined))
    return emptyRetentionRoots(['INVALID_RELEASE_LOCK']);
  return rootsOfCheckedReleases(checked.filter((release) => release !== undefined));
}
