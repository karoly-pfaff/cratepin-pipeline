import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ConcurrencyGate } from '../storage/transfer/bounded-tasks.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import { originalPathOf } from '../cache/cache-layout.ts';
import { prepareCache } from '../cache/cache-root.ts';
import { mediaTypeOf } from '../catalog/media-types.ts';
import { checkedProjectIn, sha256Of } from '../catalog/source-fixtures.test-support.ts';
import type { MediaCategory } from '../config/pipeline-config.ts';
import { objectKeyFor } from '../lock/source-lock.ts';
import type { SourceLock, SourceRecord } from '../lock/source-lock.ts';
import { PipelineError } from '../errors.ts';
import { encoderFingerprint } from '../media/encoding/encoder-fingerprint.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { buildAssetOutputs, imageGateFor } from './assembly/asset-outputs.ts';
import type { BuiltAssets } from './assembly/asset-outputs.ts';
import { planBuild } from './planning/build-plan.ts';

/** One original of a test project: its path, bytes and the metadata the lock records. */
export interface FixtureOriginal {
  readonly source: string;
  readonly bytes: Uint8Array;
  readonly id?: string;
  readonly category?: MediaCategory;
  readonly role?: string;
  readonly locale?: string;
  readonly profile?: string;
}

/** A preflighted project, its prepared cache holding every original, and the lock pinning them. */
export interface BuildFixture {
  readonly workspace: string;
  readonly project: CheckedProject;
  readonly layout: CacheLayout;
  readonly lock: SourceLock;
}

const NAMESPACE = { objectPrefix: 'cratepin/v1', projectId: 'demo' };

function authoredFieldsOf({ locale, role, profile }: FixtureOriginal): Partial<SourceRecord> {
  return {
    ...(locale === undefined ? {} : { locale }),
    ...(role === undefined ? {} : { role }),
    ...(profile === undefined ? {} : { profile }),
  };
}

function recordOf(original: FixtureOriginal): SourceRecord {
  const { source, bytes, id, category } = original;
  const sha256 = sha256Of(bytes);
  return {
    id: id ?? source.replace(/\.[^./]+$/u, ''),
    source,
    sha256,
    bytes: bytes.length,
    mediaType: mediaTypeOf(source) ?? 'application/octet-stream',
    category: category ?? 'image',
    objectKey: objectKeyFor(NAMESPACE, sha256),
    ...authoredFieldsOf(original),
  };
}

/** The lock of project demo pinning these originals, in the given order. */
export function lockOfOriginals(originals: readonly FixtureOriginal[]): SourceLock {
  return { schemaVersion: 1, projectId: 'demo', assets: originals.map(recordOf) };
}

/**
 * Runs `use` with a fresh project (config fields from `config`) whose `public` directory exists,
 * its prepared cache already holding every original as a verified entry, and the lock pinning
 * them.
 */
export async function withBuildFixture(
  originals: readonly FixtureOriginal[],
  config: object,
  use: (fixture: BuildFixture) => Promise<void>,
): Promise<void> {
  await withWorkspace(async (workspace) => {
    // A game's public directory exists; the tool only ever creates the output root inside it.
    await mkdir(join(workspace, 'public'));
    const project = await checkedProjectIn(workspace, config);
    const layout = await prepareCache(project);
    for (const original of originals) {
      await writeFile(originalPathOf(layout, sha256Of(original.bytes)), original.bytes);
    }
    await use({ workspace, project, layout, lock: lockOfOriginals(originals) });
  });
}

/** Plans the fixture's lock and makes every output in its cache, two at a time. */
/** How a test overrides the build's parallelism. */
interface BuildOverrides {
  readonly concurrency?: number;
  readonly imageGate?: ConcurrencyGate;
}

export function buildAllOutputs(
  fixture: BuildFixture,
  overrides: BuildOverrides = {},
): Promise<BuiltAssets> {
  const plan = planBuild(fixture.project.config, fixture.lock);
  return buildAssetOutputs({
    layout: fixture.layout,
    assets: plan.assets,
    fingerprint: encoderFingerprint(),
    maxImagePixels: fixture.project.config.limits.maxImagePixels,
    concurrency: overrides.concurrency ?? 2,
    imageGate:
      overrides.imageGate ?? imageGateFor(fixture.project.config.limits.imageConcurrency, 2),
  });
}

/** `code path` of each issue, in code-unit order. */
export function issueSummaries(
  issues: readonly { readonly code: string; readonly path: string }[],
): string[] {
  return issues
    .map(({ code, path }) => `${code} ${path}`)
    .toSorted((left, right) => (left < right ? -1 : 1));
}

/** A predicate for `assert.rejects`: a PipelineError with `code` and, when given, `reason`. */
export function failsBecause(code: string, reason?: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof PipelineError &&
    error.code === code &&
    (reason === undefined || error.details.reason === reason);
}

/** Profiles the failure tests use: flexible lossless and lossy WebP and an 8×8 box. */
export const FAILURE_PROFILES = {
  profiles: {
    flexible: { kind: 'image', webp: { lossless: true } },
    'lossy-flexible': { kind: 'image', webp: { lossless: false, quality: 80 } },
    box: { kind: 'image', resize: { width: 8, height: 8, fit: 'contain' } },
  },
};
