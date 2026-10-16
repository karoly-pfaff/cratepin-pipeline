import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { compareCodeUnits } from '../catalog/ordering.ts';
import { pngOf, transparentArtwork } from '../media/testing/media-fixtures.test-support.ts';
import type { PublicationFileSystem } from '../output/publication/publication-files.ts';
import { lockOfOriginals } from './build-fixtures.test-support.ts';
import type { BuildFixture, FixtureOriginal } from './build-fixtures.test-support.ts';
import { runBuild } from './build-run.ts';
import type { BuildResult } from './build-run.ts';

/** A config with one strict lossless WebP profile, in path-preserving mode. */
export const BUILD_CONFIG = {
  profiles: { 'ui-strict': { kind: 'image', webp: { lossless: true, keepSmaller: false } } },
};

/** The same config in generation mode. */
export const GENERATION_CONFIG = { ...BUILD_CONFIG, outputMode: 'generation' };

/** An image converted to WebP and a voice file copied as it is. */
export async function buildOriginals(): Promise<FixtureOriginal[]> {
  return [
    {
      source: 'app/ui/button.png',
      bytes: await pngOf(transparentArtwork(9, 9)),
      profile: 'ui-strict',
    },
    {
      source: 'voice/hu/hello.mp3',
      bytes: Buffer.from('ID3 hello'),
      category: 'voice',
      locale: 'hu',
    },
  ];
}

function noReader(): never {
  throw new Error('a warm cache needs no read transport');
}

/** What a test changes about a build: its file operations, cancellation or concurrency. */
export interface BuildChanges {
  readonly fileSystem?: PublicationFileSystem;
  readonly signal?: AbortSignal;
  readonly concurrency?: number;
}

/** Builds the fixture's lock offline from its warm cache. */
export function buildOf(fixture: BuildFixture, changes: BuildChanges = {}): Promise<BuildResult> {
  return runBuild({
    project: fixture.project,
    lock: fixture.lock,
    isOffline: true,
    concurrency: 2,
    openReader: noReader,
    ...changes,
  });
}

/** The fixture with only its last locked original: one asset fewer than the first build. */
export async function withoutFirstAsset(fixture: BuildFixture): Promise<BuildFixture> {
  return { ...fixture, lock: lockOfOriginals((await buildOriginals()).slice(1)) };
}

async function hashedEntry(directory: string, entry: Dirent): Promise<[string, string]> {
  const path = join(entry.parentPath, entry.name);
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  return [relative(directory, path).split(sep).join('/'), sha256];
}

/** Every file below `directory`, by forward-slash path, with its SHA-256; `{}` when missing. */
export async function snapshotOf(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
    (): Dirent[] => [],
  );
  const files = entries.filter((entry) => entry.isFile());
  const hashed = await Promise.all(files.map((entry) => hashedEntry(directory, entry)));
  return Object.fromEntries(hashed.toSorted(([left], [right]) => compareCodeUnits(left, right)));
}

export function sameTree(left: Record<string, string>, right: Record<string, string>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
