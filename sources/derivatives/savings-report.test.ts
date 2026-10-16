import assert from 'node:assert/strict';
import test from 'node:test';

import type { CachedConversion } from './cached-conversion.ts';
import { savingsReportOf } from './savings-report.ts';

function conversion(changes: Partial<CachedConversion>): CachedConversion {
  const sourceBytes = changes.sourceBytes ?? 100;
  const outputBytes = changes.outputBytes ?? 100;
  return {
    bytes: new Uint8Array(outputBytes),
    mediaType: 'image/png',
    choice: 'converted',
    outputSha256: 'a'.repeat(64),
    outputFile: '/cache/derivatives/output',
    derivativeUse: 'made',
    notices: [],
    ...changes,
    sourceBytes,
    outputBytes,
    savedBytes: sourceBytes - outputBytes,
  };
}

const CONVERTED = [
  {
    id: 'scenes/forest/sky',
    source: 'scenes/forest/sky.png',
    profile: 'background-webp',
    conversion: conversion({
      mediaType: 'image/webp',
      sourceBytes: 50_000,
      outputBytes: 4_000,
      dimensions: { width: 512, height: 256 },
      derivativeUse: 'reused',
    }),
  },
  {
    id: 'app/ui/button',
    source: 'app/ui/button.png',
    profile: 'ui-lossless',
    conversion: conversion({
      mediaType: 'image/webp',
      sourceBytes: 300,
      outputBytes: 340,
      dimensions: { width: 7, height: 5 },
      sourceDimensions: { width: 14, height: 10 },
      notices: [{ code: 'SIZE_GREW', message: 'larger' }],
    }),
  },
  {
    id: 'voice/hu/hello',
    source: 'voice/hu/hello.mp3',
    profile: 'copy',
    conversion: conversion({
      mediaType: 'audio/mpeg',
      choice: 'copied',
      sourceBytes: 2_000,
      outputBytes: 2_000,
      derivativeUse: 'copied',
    }),
  },
];

test('every asset reports its real sizes, format, profile and dimensions, by logical ID', () => {
  const { assets } = savingsReportOf(CONVERTED);
  assert.deepEqual(
    assets.map(({ id }) => id),
    ['app/ui/button', 'scenes/forest/sky', 'voice/hu/hello'],
  );
  assert.deepEqual(assets[0], {
    id: 'app/ui/button',
    source: 'app/ui/button.png',
    profile: 'ui-lossless',
    choice: 'converted',
    mediaType: 'image/webp',
    sourceBytes: 300,
    outputBytes: 340,
    savedBytes: -40,
    width: 7,
    height: 5,
    sourceWidth: 14,
    sourceHeight: 10,
    derivativeUse: 'made',
    notices: ['SIZE_GREW'],
  });
  const voice = assets.find(({ id }) => id === 'voice/hu/hello');
  assert.equal(voice?.savedBytes, 0, 'a copy saves nothing');
  assert.equal(voice.width, undefined, 'a copy is never decoded');
});

test('totals are exact sums, and negative or zero savings are reported as measured', () => {
  const { totals } = savingsReportOf(CONVERTED);
  assert.deepEqual(totals, {
    assetCount: 3,
    sourceBytes: 52_300,
    outputBytes: 6_340,
    savedBytes: 45_960,
    grewCount: 1,
    derivativeUses: { copied: 1, reused: 1, made: 1, remade: 0 },
  });
  const grown = savingsReportOf(CONVERTED.slice(1, 2));
  assert.equal(grown.totals.savedBytes, -40);
  assert.deepEqual(savingsReportOf([]).totals.savedBytes, 0);
});
