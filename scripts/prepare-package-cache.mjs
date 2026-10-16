import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNpmAndRequireSuccess } from './package-process.mjs';

/** npm ci caches locked archives, but a fresh offline consumer also needs registry metadata. */
async function cacheRuntimeDependencies(cacheDirectory) {
  const packageManifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const cacheManifest = {
    name: 'cratepin-package-cache',
    private: true,
    dependencies: packageManifest.dependencies,
  };
  await writeFile(join(cacheDirectory, 'package.json'), JSON.stringify(cacheManifest));
  runNpmAndRequireSuccess(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org/',
    ],
    { cwd: cacheDirectory },
  );
}

const bootstrapDirectory = await mkdtemp(join(tmpdir(), 'cratepin-package-cache-'));
try {
  await cacheRuntimeDependencies(bootstrapDirectory);
  console.log('Runtime dependency cache prepared; package consumer installs remain offline.');
} finally {
  await rm(bootstrapDirectory, { recursive: true, force: true });
}
