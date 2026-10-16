import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  failPackageCheck,
  runAndCaptureOutput,
  runAndRequireSuccess,
  runNpm,
  runNpmAndRequireSuccess,
} from './package-process.mjs';
import { checkPackageRecipes } from './package-recipes.mjs';
const TYPESCRIPT_CLI = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);
// Mirrors the CLI contract in docs/contracts/cli.md; the script cannot import TypeScript sources.
const EXIT_NOT_IMPLEMENTED = 3;
const EXIT_USAGE = 4;
const INSTALL_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

/** Compiled against the published declarations: config, ports, reports and ADR-007 separation. */
const CONSUMER_TYPESCRIPT = `import {
  createMemoryStore, defaultConfig, failedReport, NO_RESOLVED_SECRETS, PipelineError,
  renderReportAsJson, validateConfig, planRemoteRetention, type RemoteRetentionRequest,
  type BlobReader, type BlobWriter, type OperationReport, type PipelineConfig, type StoredBlob,
} from '@karoly-pfaff/cratepin';
const config: PipelineConfig = defaultConfig();
if (!validateConfig(config).ok) throw new Error('default config must validate');
class EmptyAdapter implements BlobReader {
  statBlob(): Promise<StoredBlob | undefined> { return Promise.resolve(undefined); }
  async *readBlob(): AsyncIterable<Uint8Array> { yield* []; }
}
const reader: BlobReader = new EmptyAdapter();
// @ts-expect-error A BlobReader can never write (build-side code only receives readers).
reader.createBlobIfAbsent;
const writer: BlobWriter = createMemoryStore();
const missing = new PipelineError('NOT_FOUND', 'missing original');
const report: OperationReport = failedReport('pull', missing, { facts: { missing: 1 } });
export const rendered: string = renderReportAsJson(report, NO_RESOLVED_SECRETS);
export const writes: BlobWriter['createBlobIfAbsent'] = writer.createBlobIfAbsent.bind(writer);
const retention: RemoteRetentionRequest = { releases: [], objects: [], isInventoryComplete: false,
  isReleaseCatalogComplete: false, hasVerifiedIndependentBackup: false, backupReference: '',
  capturedAtMs: 0, nowMs: 0, gracePeriodSeconds: 1 };
export const retentionStatus: 'blocked' | 'ready' = planRemoteRetention(retention).status;
`;
const CONSUMER_TSCONFIG = {
  compilerOptions: { noEmit: true, strict: true, module: 'nodenext', target: 'es2022', types: [] },
  files: ['consumer.ts'],
};
const CONSUMER_RUNTIME_IMPORT = `import { defaultConfig, validateConfig, hashFile } from '@karoly-pfaff/cratepin';
if (typeof hashFile !== 'function' || !validateConfig(defaultConfig()).ok) process.exit(1);`;
const CONSUMER_DEEP_IMPORT = "await import('@karoly-pfaff/cratepin/build/hash.js');";

async function createConsumerWithInstalledTarball(consumerDirectory, tarballPath) {
  const consumerManifest = { name: 'cratepin-consumer', private: true, type: 'module' };
  await writeFile(join(consumerDirectory, 'package.json'), JSON.stringify(consumerManifest));
  const installArguments = ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'];
  runNpmAndRequireSuccess([...installArguments, tarballPath], { cwd: consumerDirectory });
}

function runInstalledCli(consumerDirectory, cliArguments) {
  return runNpm(['exec', '--offline', '--', 'cratepin', ...cliArguments], {
    cwd: consumerDirectory,
  });
}

function assertCliExit(commandRun, expectedExitCode, expectedText) {
  const isExpected =
    commandRun.status === expectedExitCode && commandRun.diagnostics.includes(expectedText);
  if (!isExpected) {
    failPackageCheck(
      `expected exit ${expectedExitCode} with ${expectedText}:\n${commandRun.diagnostics}`,
    );
  }
}

function assertInstalledCliReportsCommandStatus(consumerDirectory) {
  const helpRun = runInstalledCli(consumerDirectory, ['--help']);
  assertCliExit(helpRun, 0, 'Implemented:');
  assertCliExit(helpRun, 0, 'Planned:');
  assertCliExit(
    runInstalledCli(consumerDirectory, ['remote', 'gc']),
    EXIT_NOT_IMPLEMENTED,
    'NOT_IMPLEMENTED',
  );
  assertCliExit(runInstalledCli(consumerDirectory, ['frobnicate']), EXIT_USAGE, 'USAGE');
}

/** Installing the tool never runs its code: downloads and uploads stay explicit commands. */
async function assertNoInstallScripts(consumerDirectory) {
  const installedManifest = join(
    consumerDirectory,
    'node_modules',
    '@karoly-pfaff/cratepin',
    'package.json',
  );
  const { scripts = {} } = JSON.parse(await readFile(installedManifest, 'utf8'));
  const installScripts = INSTALL_LIFECYCLE_SCRIPTS.filter((name) => Object.hasOwn(scripts, name));
  if (installScripts.length > 0) failPackageCheck(`install-time scripts: ${installScripts}`);
}

function assertPublicApiImports(consumerSpawnOptions) {
  const importArguments = ['--input-type=module', '-e', CONSUMER_RUNTIME_IMPORT];
  runAndRequireSuccess(process.execPath, importArguments, consumerSpawnOptions);
}

function assertDeepImportsRejected(consumerSpawnOptions) {
  const deepImportArguments = ['--input-type=module', '-e', CONSUMER_DEEP_IMPORT];
  const deepImportRun = runAndCaptureOutput(
    process.execPath,
    deepImportArguments,
    consumerSpawnOptions,
  );
  if (!deepImportRun.diagnostics.includes('ERR_PACKAGE_PATH_NOT_EXPORTED')) {
    failPackageCheck('internal build modules are importable from outside the package');
  }
}

async function assertTypeScriptConsumerCompiles(consumerDirectory) {
  await writeFile(join(consumerDirectory, 'consumer.ts'), CONSUMER_TYPESCRIPT);
  await writeFile(join(consumerDirectory, 'tsconfig.json'), JSON.stringify(CONSUMER_TSCONFIG));
  const compilerArguments = [TYPESCRIPT_CLI, '--project', 'tsconfig.json'];
  runAndRequireSuccess(process.execPath, compilerArguments, { cwd: consumerDirectory });
}

export async function checkExternalPackageConsumer(consumerDirectory, tarballPath) {
  await createConsumerWithInstalledTarball(consumerDirectory, tarballPath);
  runAndRequireSuccess(
    process.execPath,
    [
      fileURLToPath(new URL('./check-docs.mjs', import.meta.url)),
      join(consumerDirectory, 'node_modules/@karoly-pfaff/cratepin'),
    ],
    { cwd: consumerDirectory },
  );
  await assertNoInstallScripts(consumerDirectory);
  assertInstalledCliReportsCommandStatus(consumerDirectory);
  assertPublicApiImports({ cwd: consumerDirectory });
  assertDeepImportsRejected({ cwd: consumerDirectory });
  await assertTypeScriptConsumerCompiles(consumerDirectory);
  await checkPackageRecipes(consumerDirectory);
}
