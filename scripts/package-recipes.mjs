import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDocumentationRecipes } from './documentation-recipes.mjs';
import { locateNpmCli, runAndCaptureOutput, runAndRequireSuccess } from './package-process.mjs';

const TYPESCRIPT_CLI = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);
const NETWORK_BLOCK = new URL('../tests/support/network-block.test-support.mjs', import.meta.url)
  .href;
const FIXTURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"></svg>';
const RECIPE_CONFIG = {
  compilerOptions: {
    strict: true,
    module: 'nodenext',
    target: 'es2022',
    types: [],
    outDir: 'compiled',
  },
  files: ['preview.ts', 'memory.ts'],
};
const SEED_TRIAL = `import { seedMemoryTrial } from './compiled/memory.js';
const pull = await seedMemoryTrial('cratepin.config.json');
if (pull.originals.some(({ status }) => status !== 'cached' && status !== 'downloaded'))
  throw new Error('The memory trial did not cache every original');`;
const RECIPE_ENV = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  NODE_OPTIONS: `--import=${NETWORK_BLOCK}`,
};

async function writeRecipeFiles(directory, recipes) {
  await mkdir(join(directory, 'assets/source/ui'), { recursive: true });
  await mkdir(join(directory, 'public'), { recursive: true });
  await writeFile(join(directory, 'assets/source/ui/icon.svg'), FIXTURE_SVG);
  await writeFile(join(directory, 'preview.ts'), recipes.get('preview'));
  await writeFile(join(directory, 'memory.ts'), recipes.get('memory'));
  await writeFile(join(directory, 'recipes.tsconfig.json'), JSON.stringify(RECIPE_CONFIG));
}

function runRecipeCommands(directory, commands, expectedExit = 0) {
  for (const line of commands.trim().split('\n')) {
    assertRecipeReport(runRecipeCommand(directory, line, expectedExit), expectedExit);
  }
}

function runRecipeCommand(directory, line, expectedExit) {
  assert.match(
    line,
    /^npm exec --offline --no-update-notifier -- cratepin [a-zA-Z0-9./ =-]+ --json$/u,
  );
  const args = [locateNpmCli(), ...line.trim().split(/\s+/u).slice(1)];
  const commandRun = runAndCaptureOutput(process.execPath, args, {
    cwd: directory,
    env: RECIPE_ENV,
  });
  assert.equal(commandRun.status, expectedExit, commandRun.diagnostics);
  assert.ok(!commandRun.diagnostics.includes('NETWORK_ATTEMPT'), commandRun.diagnostics);
  return JSON.parse(commandRun.status === 0 ? commandRun.stdout : commandRun.diagnostics);
}

function assertRecipeReport(report, expectedExit) {
  assert.equal(report.status, expectedExit === 0 ? 'succeeded' : 'failed');
  if (expectedExit === 9) assert.equal(report.error.code, 'OUTPUT_CONFLICT');
  if (expectedExit === 3) assert.equal(report.error.code, 'NOT_IMPLEMENTED');
}

async function assertCopiedRecipeOutput(directory) {
  const output = join(directory, 'public/assets');
  const manifest = JSON.parse(await readFile(join(output, 'cratepin-manifest.json'), 'utf8'));
  const entry = manifest.assets['ui/icon'];
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(entry.url, 'assets/ui/icon.svg');
  assert.equal(entry.bytes, Buffer.byteLength(FIXTURE_SVG));
  assert.equal(entry.sha256, createHash('sha256').update(FIXTURE_SVG).digest('hex'));
  assert.equal(await readFile(join(output, 'ui/icon.svg'), 'utf8'), FIXTURE_SVG);
}

/** Installs are covered by the caller; every recipe uses that external package's public entry. */
export async function checkPackageRecipes(directory) {
  const recipes = await loadDocumentationRecipes();
  await writeRecipeFiles(directory, recipes);
  runRecipeCommands(directory, recipes.get('inspect'));
  runAndRequireSuccess(process.execPath, [TYPESCRIPT_CLI, '--project', 'recipes.tsconfig.json'], {
    cwd: directory,
  });
  runAndRequireSuccess(
    process.execPath,
    ['--import', NETWORK_BLOCK, '--input-type=module', '-e', SEED_TRIAL],
    { cwd: directory, env: RECIPE_ENV },
  );
  runRecipeCommands(directory, recipes.get('build'));
  await assertCopiedRecipeOutput(directory);
  assertRecipeFailures(directory, recipes);
}

function assertRecipeFailures(directory, recipes) {
  runRecipeCommands(directory, recipes.get('conflict'), 9);
  runRecipeCommands(directory, recipes.get('planned'), 3);
}
