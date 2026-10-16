import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { encoderFingerprint } from './encoder-fingerprint.ts';

test('the fingerprint names the encoder this process loaded and where it runs', () => {
  const fingerprint = encoderFingerprint();
  assert.equal(fingerprint.sharp, sharp.versions.sharp);
  assert.equal(fingerprint.libvips, sharp.versions.vips);
  assert.equal(fingerprint.libwebp, sharp.versions.webp);
  assert.match(fingerprint.pngLibrary, /^lib(s)?png \d/u);
  assert.notEqual(fingerprint.zlib, 'unknown', 'the prebuilt binaries report zlib-ng');
  assert.equal(fingerprint.platform, process.platform);
  assert.equal(fingerprint.arch, process.arch);
});
