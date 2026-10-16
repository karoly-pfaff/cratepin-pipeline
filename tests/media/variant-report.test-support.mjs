import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { lossyFixtures } from '../../sources/media/testing/lossy-fixtures.test-support.ts';
import {
  pngOf,
  transparentArtwork,
} from '../../sources/media/testing/media-fixtures.test-support.ts';
import {
  EVALUATION_PROFILES,
  evaluateVariant,
  sha256Of,
} from './variant-evaluation.test-support.mjs';

async function evaluateFixture(directory, source) {
  const metadata = await sharp(source.bytes).metadata();
  const fallbackUrl = `${source.id}.png`;
  await writeFile(join(directory, fallbackUrl), source.bytes);
  const widths = [...new Set([metadata.width, Math.max(1, Math.floor(metadata.width / 2))])];
  const variants = [];
  for (const width of widths)
    for (const profile of EVALUATION_PROFILES)
      variants.push(await writeVariant(directory, source, { width, profile }));
  return {
    fallback: {
      url: fallbackUrl,
      sha256: sha256Of(source.bytes),
      bytes: source.bytes.length,
      width: metadata.width,
      height: metadata.height,
    },
    variants,
  };
}

async function writeVariant(directory, source, selection) {
  const evaluated = await evaluateVariant(source.bytes, selection);
  const url = `${source.id}.${selection.profile.name}.${selection.width}.${selection.profile.format}`;
  await writeFile(join(directory, url), evaluated.output);
  return { url, ...evaluated.measurement };
}

async function writeViewer(directory) {
  for (const filename of ['index.html', 'viewer.js']) {
    const bytes = await readFile(
      new URL(`../../examples/variant-evaluation/src/${filename}`, import.meta.url),
    );
    await writeFile(join(directory, filename), bytes);
  }
}

async function evaluationInputs() {
  return { ...(await lossyFixtures()), 'exact-pixel-ui': await pngOf(transparentArtwork(16, 16)) };
}

/** Writes only into a fresh child of an explicitly selected, real parent directory. */
export async function writeVariantEvaluation(parentDirectory) {
  const parent = resolve(parentDirectory);
  assert.equal(await realpath(parent), parent, 'Evaluation parent must not be a linked path');
  const directory = await mkdtemp(join(parent, 'cratepin-variants-'));
  const assets = Object.create(null);
  for (const [id, bytes] of Object.entries(await evaluationInputs()))
    assets[id] = await evaluateFixture(directory, { id, bytes });
  const report = {
    schemaVersion: 1,
    kind: 'experimental-variant-evaluation',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    encoders: sharp.versions,
    sharpConcurrency: sharp.concurrency(),
    assets,
  };
  await Promise.all([
    writeFile(join(directory, 'variant-evaluation.json'), JSON.stringify(report, null, 2) + '\n'),
    writeViewer(directory),
  ]);
  return directory;
}
