import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';

import { checkedProjectIn } from '../../catalog/source-fixtures.test-support.ts';
import { pngOf, transparentArtwork } from '../../media/testing/media-fixtures.test-support.ts';
import { refusalsOf } from './asset-inspection.ts';
import { buildAllOutputs, withBuildFixture } from '../build-fixtures.test-support.ts';
import type { BuildFixture } from '../build-fixtures.test-support.ts';
import { planBuild } from './build-plan.ts';
import { previewBuild } from './build-preview.ts';
import { buildOf, snapshotOf } from '../build-runs.test-support.ts';

const CONFIG = { profiles: { artwork: { kind: 'image', webp: { lossless: true } } } };

function statesOf(inspections: readonly { readonly state: string }[]): string[] {
  return inspections.map(({ state }) => state);
}

function codesOf(issues: readonly { readonly code: string }[]): string[] {
  return issues.map(({ code }) => code);
}

function previewOf(fixture: BuildFixture) {
  const plan = planBuild(fixture.project.config, fixture.lock);
  return previewBuild({ project: fixture.project, lock: fixture.lock, plan, concurrency: 2 });
}

test('a preview inspects the root and the cache and changes neither', async () => {
  const originals = [
    { source: 'art.png', bytes: await pngOf(transparentArtwork()), profile: 'artwork' },
  ];
  await withBuildFixture(originals, CONFIG, async (fixture) => {
    const derivativesBefore = await readdir(fixture.layout.derivatives);
    const preview = await previewOf(fixture);
    assert.equal(preview.rootState.state, 'absent');
    assert.deepEqual(statesOf(preview.inspections), ['verified']);
    assert.equal(preview.assembled, undefined, 'the conversion is not known yet');
    assert.deepEqual(await readdir(fixture.layout.derivatives), derivativesBefore);
  });
});

test('once every output is known, the preview carries the complete output', async () => {
  const originals = [
    { source: 'art.png', bytes: await pngOf(transparentArtwork()), profile: 'artwork' },
  ];
  await withBuildFixture(originals, CONFIG, async (fixture) => {
    await buildAllOutputs(fixture);
    const preview = await previewOf(fixture);
    assert.match(preview.assembled?.generation ?? '', /^[0-9a-f]{64}$/u);
    assert.equal(preview.published.state, 'absent');
  });
});

test('cold and warm previews and builds refuse an oversized canvas without changing published bytes', async () => {
  const originals = [
    { source: 'art.png', bytes: await pngOf(transparentArtwork(2, 2)), profile: 'artwork' },
  ];
  const config = {
    profiles: { artwork: { kind: 'image', resize: { width: 64, height: 64, fit: 'contain' } } },
    limits: { maxImagePixels: 4096 },
  };
  await withBuildFixture(originals, config, async (fixture) => {
    const sourceBefore = await snapshotOf(fixture.layout.originals);
    const project = await checkedProjectIn(fixture.workspace, {
      ...config,
      limits: { maxImagePixels: 16 },
    });
    const limited = { ...fixture, project };
    const cold = await previewOf(limited);
    assert.deepEqual(codesOf(refusalsOf(cold.outputs)), ['IMAGE_TOO_LARGE']);
    assert.equal(cold.assembled, undefined);
    assert.deepEqual(await readdir(fixture.layout.derivatives), []);
    assert.equal((await buildOf(limited)).publication, undefined);
    assert.deepEqual(await readdir(fixture.layout.derivatives), []);
    assert.equal((await buildOf(fixture)).publication?.outcome, 'published');
    const outputBefore = await snapshotOf(project.paths.outputRoot);
    const cacheBefore = await snapshotOf(fixture.layout.derivatives);
    const warm = await previewOf(limited);
    assert.deepEqual(codesOf(refusalsOf(warm.outputs)), ['IMAGE_TOO_LARGE']);
    const refused = await buildOf(limited);
    assert.deepEqual(codesOf(refused.built?.issues ?? []), ['IMAGE_TOO_LARGE']);
    assert.equal(refused.publication, undefined);
    assert.deepEqual(await snapshotOf(project.paths.outputRoot), outputBefore);
    assert.deepEqual(await snapshotOf(fixture.layout.derivatives), cacheBefore);
    assert.deepEqual(await snapshotOf(fixture.layout.originals), sourceBefore);
  });
});
