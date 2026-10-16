import assert from 'node:assert/strict';
import test from 'node:test';

import { validateConfig } from '../../config/validation.ts';
import {
  FAILURE_PROFILES,
  issueSummaries,
  lockOfOriginals,
} from '../build-fixtures.test-support.ts';
import { planBuild } from './build-plan.ts';

test('clashing output paths and undefined profiles are found before anything is read', () => {
  const validation = validateConfig({ schemaVersion: 1, projectId: 'demo', ...FAILURE_PROFILES });
  assert.ok(validation.ok);
  const { config } = validation;
  const png = Buffer.from('png');
  const lock = lockOfOriginals([
    { source: 'images/cat.png', bytes: png, profile: 'flexible' },
    { source: 'images/cat.webp', bytes: Buffer.from('webp'), id: 'cat-webp' },
    { source: 'images/dog.png', bytes: png, profile: 'gone' },
  ]);
  const plan = planBuild(config, lock);
  assert.deepEqual(issueSummaries(plan.issues), [
    'OUTPUT_PATH_COLLISION images/cat.webp',
    'PROFILE_UNKNOWN images/dog.png',
  ]);
  assert.equal(plan.assets.length, 2, 'the asset with an undefined profile is not planned');
  assert.match(
    plan.issues.find(({ code }) => code === 'OUTPUT_PATH_COLLISION')?.message ?? '',
    /IDs "cat-webp", "images\/cat"/u,
  );
});
