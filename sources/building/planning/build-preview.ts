import { cacheLayoutOf } from '../../cache/cache-layout.ts';
import type { CacheLayout } from '../../cache/cache-layout.ts';
import { existingCache } from '../../cache/cache-root.ts';
import type { SourceLock } from '../../lock/source-lock.ts';
import { lockedObjectsOf } from '../../lock/upload-plan.ts';
import { encoderFingerprint } from '../../media/encoding/encoder-fingerprint.ts';
import { readPublishedManifest } from '../../output/manifest/manifest-reading.ts';
import type { PublishedManifest } from '../../output/manifest/manifest-reading.ts';
import type { PipelineError } from '../../errors.ts';
import { classifyOutputRoot } from '../../output/ownership/output-marker.ts';
import { outputPublisherOf } from '../publication/output-publishers.ts';
import type { OutputRootState } from '../../output/ownership/output-marker.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { inspectCachedOriginals } from '../../pull/locked-originals.ts';
import type { CacheInspection } from '../../pull/locked-originals.ts';
import { mapBounded } from '../../storage/transfer/bounded-tasks.ts';
import { inspectAssetOutput, knownOutputsOf } from './asset-inspection.ts';
import type { AssetInspection } from './asset-inspection.ts';
import type { AssetBuilding, BuiltAsset } from '../assembly/asset-outputs.ts';
import type { BuildPlan, PlannedAsset } from './build-plan.ts';
import { assembleOutput } from '../assembly/output-assembly.ts';
import type { AssembledOutput } from '../assembly/output-assembly.ts';
import { imageGateFor } from '../assembly/asset-outputs.ts';

/** What a dry run looks at: the preflighted project, its committed lock and how it would run. */
export interface BuildPreviewRequest {
  readonly project: CheckedProject;
  readonly lock: SourceLock;
  /** The build plan, without issues: a build stops at its problems before any I/O. */
  readonly plan: BuildPlan;
  readonly concurrency: number;
}

/** What a build would do; nothing was written, downloaded, converted or resolved. */
export interface BuildPreview {
  readonly plan: BuildPlan;
  readonly rootState: OutputRootState;
  /** Why a root its marker allows may still not be published into, as the output mode checks it. */
  readonly rootRefusal?: PipelineError;
  /** An earlier build left unfinished work, which a build recovers before anything else. */
  readonly hasLeftovers: boolean;
  /** Each locked original's cache entry, hashed. */
  readonly inspections: readonly CacheInspection[];
  /** One per planned asset, in plan order. */
  readonly outputs: readonly AssetInspection[];
  /** The complete output, when every asset's output is already known and none is refused. */
  readonly assembled?: AssembledOutput;
  readonly published: PublishedManifest;
}

function previewOne(
  building: AssetBuilding,
  verified: ReadonlySet<string>,
  asset: PlannedAsset,
): Promise<AssetInspection> {
  const isWaitingForOriginal =
    asset.profile.policy.kind === 'image' && !verified.has(asset.record.sha256);
  if (isWaitingForOriginal) return Promise.resolve({ wouldConvert: asset });
  return inspectAssetOutput(building, asset);
}

/** Every output, when all of them are already known; `undefined` while any is not. */
function allKnownOutputsOf(outputs: readonly AssetInspection[]): BuiltAsset[] | undefined {
  const known = knownOutputsOf(outputs);
  return known.length === outputs.length ? known : undefined;
}

/** The cache a build would use and each locked original's entry in it, hashed. */
interface CachedOriginals {
  readonly layout: CacheLayout;
  readonly inspections: readonly CacheInspection[];
}

async function previewOriginals(request: BuildPreviewRequest): Promise<CachedOriginals> {
  const { project, lock, concurrency } = request;
  const layout = (await existingCache(project)) ?? cacheLayoutOf(project.paths.cacheRoot);
  return {
    layout,
    inspections: await inspectCachedOriginals(layout, lockedObjectsOf(lock), concurrency),
  };
}

async function previewOutputs(
  request: BuildPreviewRequest,
  plan: BuildPlan,
  { layout, inspections }: CachedOriginals,
): Promise<AssetInspection[]> {
  const { project, concurrency } = request;
  const verified = new Set(
    inspections.flatMap(({ object, state }) => (state === 'verified' ? [object.sha256] : [])),
  );
  const building: AssetBuilding = {
    layout,
    assets: plan.assets,
    fingerprint: encoderFingerprint(),
    maxImagePixels: project.config.limits.maxImagePixels,
    concurrency,
    imageGate: imageGateFor(project.config.limits.imageConcurrency, concurrency),
  };
  return mapBounded(plan.assets, concurrency, (asset) => previewOne(building, verified, asset));
}

function publishedManifestOf(
  project: CheckedProject,
  rootState: OutputRootState,
): Promise<PublishedManifest> {
  if (rootState.state !== 'owned') return Promise.resolve({ state: 'absent' });
  return readPublishedManifest(project.paths.outputRoot);
}

/** The complete output, when every output is already known. */
function assembledOf(
  project: CheckedProject,
  outputs: readonly AssetInspection[],
): Pick<BuildPreview, 'assembled'> {
  const known = allKnownOutputsOf(outputs);
  return known === undefined ? {} : { assembled: assembleOutput(project.config, known) };
}

/** The output root as a build would meet it, read only. */
async function previewRoot(
  project: CheckedProject,
): Promise<Pick<BuildPreview, 'rootState' | 'rootRefusal' | 'hasLeftovers'>> {
  const publisher = outputPublisherOf(project);
  const rootState = await classifyOutputRoot(project.paths.outputRoot, project.config);
  const rootRefusal = await publisher.rootRefusal(rootState);
  const hasLeftovers = await publisher.hasLeftovers();
  return { rootState, hasLeftovers, ...(rootRefusal ? { rootRefusal } : {}) };
}

/**
 * Looks at everything a build of a clean plan would use and says what it would do, changing
 * nothing: the output root's state, which originals are cached, which outputs are copies or
 * reusable derivatives and which would be converted, and, when every output is known, the
 * complete manifest and generation. No claim, download, conversion, credential or write.
 */
export async function previewBuild(request: BuildPreviewRequest): Promise<BuildPreview> {
  const { project, plan } = request;
  if (plan.issues.length > 0) throw new Error('A preview needs a plan without issues');
  const root = await previewRoot(project);
  const originals = await previewOriginals(request);
  const outputs = await previewOutputs(request, plan, originals);
  const { rootState } = root;
  return {
    plan,
    ...root,
    inspections: originals.inspections,
    outputs,
    published: await publishedManifestOf(project, rootState),
    ...assembledOf(project, outputs),
  };
}
