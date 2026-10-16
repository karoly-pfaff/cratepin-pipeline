import type { BlobReader } from '../blob-store.ts';
import { claimCacheForBuild } from '../cache/cache-claims.ts';
import { claimOutputForBuild } from '../output/ownership/output-claim.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import { prepareCache } from '../cache/cache-root.ts';
import type { PipelineError } from '../errors.ts';
import { toPipelineError } from '../errors.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import { lockedObjectsOf } from '../lock/upload-plan.ts';
import { encoderFingerprint } from '../media/encoding/encoder-fingerprint.ts';
import { unsafeOutputError, unsafeValueContextOf } from '../output/manifest/manifest-safety.ts';
import { assertRootNotRefused } from '../output/ownership/owned-root.ts';
import { NODE_PUBLICATION_FILE_SYSTEM } from '../output/publication/publication-files.ts';
import type { PublicationFileSystem } from '../output/publication/publication-files.ts';
import type { RecoveryResult } from '../output/publication/output-recovery.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { retrieveLockedOriginals } from '../pull/locked-originals.ts';
import type { OriginalOutcome } from '../pull/locked-originals.ts';
import { buildAssetOutputs, imageGateFor } from './assembly/asset-outputs.ts';
import type { BuiltAssets } from './assembly/asset-outputs.ts';
import { planBuild } from './planning/build-plan.ts';
import type { BuildPlan } from './planning/build-plan.ts';
import type { PublicationResult } from './publication/staged-publication.ts';
import { assembleOutput } from './assembly/output-assembly.ts';
import { outputPublisherOf } from './publication/output-publishers.ts';
import type { AssembledOutput } from './assembly/output-assembly.ts';

/** Everything a build needs: the preflighted project, its committed lock and how to read storage. */
export interface BuildRequest {
  readonly project: CheckedProject;
  readonly lock: SourceLock;
  /** Never download; no read transport is created. */
  readonly isOffline: boolean;
  readonly concurrency: number;
  /** Creates the read transport; called only on the first cache miss, never offline. */
  readonly openReader: () => BlobReader;
  readonly signal?: AbortSignal | undefined;
  /** The publication's file operations; tests replace them to fail or stop at any step. */
  readonly fileSystem?: PublicationFileSystem;
}

/**
 * How far a build got, as data: a build that stopped at its plan, its originals or its
 * conversions has only the parts it reached, and publishes nothing. A failure after recovery
 * (an output root it may not publish into, a cancellation, a manifest or listing that must not
 * ship, a failed publication) is its `failure`, so what recovery did is still reported.
 */
export interface BuildResult {
  readonly plan: BuildPlan;
  readonly recovery?: RecoveryResult;
  readonly originals?: readonly OriginalOutcome[];
  readonly built?: BuiltAssets;
  readonly assembled?: AssembledOutput;
  readonly publication?: PublicationResult;
  readonly failure?: PipelineError;
}

/** The parts of a build after recovery. */
type BuildProgress = Omit<BuildResult, 'plan' | 'recovery'>;

function failureOf(error: unknown): BuildProgress {
  return { failure: toPipelineError(error) };
}

function fileSystemOf(request: BuildRequest): PublicationFileSystem {
  return request.fileSystem ?? NODE_PUBLICATION_FILE_SYSTEM;
}

function isInCache(outcome: OriginalOutcome): boolean {
  return outcome.status === 'cached' || outcome.status === 'downloaded';
}

/** The verified originals, then every output made in the cache; stops at the first gap. */
async function makeOutputs(
  request: BuildRequest,
  layout: CacheLayout,
  plan: BuildPlan,
): Promise<Pick<BuildResult, 'originals' | 'built'>> {
  const { project, signal, concurrency } = request;
  const objects = lockedObjectsOf(request.lock);
  const originals = await retrieveLockedOriginals({ ...request, layout, objects });
  if (!originals.every(isInCache)) return { originals };
  const built = await buildAssetOutputs({
    layout,
    assets: plan.assets,
    fingerprint: encoderFingerprint(),
    maxImagePixels: project.config.limits.maxImagePixels,
    concurrency,
    imageGate: imageGateFor(project.config.limits.imageConcurrency, concurrency),
    signal,
  });
  return { originals, built };
}

/**
 * Assembles the built outputs and publishes them unless the manifest or listing holds a value
 * that must not ship; a failed publication is the failure.
 */
async function publishBuilt(request: BuildRequest, built: BuiltAssets): Promise<BuildProgress> {
  const { project, signal } = request;
  const fileSystem = fileSystemOf(request);
  const assembled = assembleOutput(project.config, built.built);
  const unsafe = unsafeOutputError(assembled, unsafeValueContextOf(project));
  if (unsafe !== undefined) return { assembled, failure: unsafe };
  const { publish } = outputPublisherOf(project);
  return publish({ fileSystem, project, built: built.built, assembled, signal }).then(
    (publication) => ({ assembled, publication }),
    (error: unknown) => ({ assembled, ...failureOf(error) }),
  );
}

/** After recovery: the root must be publishable, then originals, conversions, publication. */
async function buildAfterRecovery(
  request: BuildRequest,
  layout: CacheLayout,
  plan: BuildPlan,
): Promise<BuildProgress> {
  await outputPublisherOf(request.project).assertPublishable();
  const made = await makeOutputs(request, layout, plan);
  const { built } = made;
  if (built === undefined || built.issues.length > 0) return made;
  return { ...made, ...(await publishBuilt(request, built)) };
}

/** The parts of a build under its claim: recovery first, then everything else. */
async function buildWithClaim(
  request: BuildRequest,
  layout: CacheLayout,
  plan: BuildPlan,
): Promise<BuildResult> {
  const recovery = await outputPublisherOf(request.project).recover(fileSystemOf(request));
  const progress = await buildAfterRecovery(request, layout, plan).catch(failureOf);
  return { plan, recovery, ...progress };
}

/**
 * Also holds the output root, against builds of another config that publish there with their
 * own cache.
 */
async function buildUnderOutputClaim(
  request: BuildRequest,
  layout: CacheLayout,
  plan: BuildPlan,
): Promise<BuildResult> {
  const outputClaim = await claimOutputForBuild(request.project.paths.outputRoot);
  try {
    return await buildWithClaim(request, layout, plan);
  } finally {
    await outputClaim.release().catch(() => undefined);
  }
}

/**
 * The build of a clean plan under a claim that keeps prunes and other builds out. A root it
 * must refuse is refused from its marker alone before the cache is even created; the full check
 * of its entries runs under the claim, after recovery.
 */
async function buildCleanPlan(request: BuildRequest, plan: BuildPlan): Promise<BuildResult> {
  const { project } = request;
  await assertRootNotRefused(project.paths.outputRoot, project.config);
  const layout = await prepareCache(project);
  const claim = await claimCacheForBuild(layout, 'build');
  try {
    return await buildUnderOutputClaim(request, layout, plan);
  } finally {
    await claim.release().catch(() => undefined);
  }
}

/**
 * Builds the committed lock into the owned output root, in either output mode: the plan first
 * (its problems stop the build before any I/O), a first refusal of a root the tool may not
 * touch, then, under a build claim that keeps prunes and other builds out, recovery of an
 * interrupted earlier build, the full check that the root may be published into, the verified
 * originals (downloaded on a miss unless offline), every output made in the cache, and the
 * publication. A build that stops early publishes nothing and leaves the previous output as it
 * was.
 */
export async function runBuild(request: BuildRequest): Promise<BuildResult> {
  const plan = planBuild(request.project.config, request.lock);
  return plan.issues.length > 0 ? { plan } : buildCleanPlan(request, plan);
}
