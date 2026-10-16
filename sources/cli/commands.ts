import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { Invocation } from './arguments.ts';
import { runWithCheckedProject } from './checked-project-run.ts';
import type { CommandRuntime } from './command-runtime.ts';
import { runCachePrune } from './commands/cache-prune-command.ts';
import { buildOutput, previewBuildOutput } from './commands/build-command.ts';
import { verifyPublishedOutput } from './commands/verify-command.ts';
import { diagnoseProject } from './commands/doctor-command.ts';
import { pullSources } from './commands/pull-command.ts';
import { pushSources } from './commands/push-command.ts';
import { scanSources } from './commands/scan-command.ts';
import { defaultConfig } from '../config/pipeline-config.ts';
import { PipelineError } from '../errors.ts';
import type { ErrorDetails } from '../errors.ts';
import { hashFile } from '../hash.ts';
import { entryKindAt } from '../paths/path-containment.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { failedReport, succeededReport } from '../report.ts';
import type { OperationReport, ReportValue } from '../report.ts';

type CommandRunner = (invocation: Invocation, runtime: CommandRuntime) => Promise<OperationReport>;

/** A dry run predicts the same failures the real write would hit: missing directory or conflict. */
async function assertConfigFileCanBeCreated(configFile: string): Promise<void> {
  if ((await entryKindAt(dirname(resolve(configFile)))) !== 'directory') {
    throw new PipelineError('NOT_FOUND', 'The directory for the config file does not exist.', {
      configFilePath: resolve(configFile),
    });
  }
  if ((await entryKindAt(configFile)) === 'absent') return;
  throw new PipelineError(
    'OUTPUT_CONFLICT',
    'The config file already exists; init never overwrites.',
    {
      configFilePath: resolve(configFile),
    },
  );
}

/**
 * The default config as `init` writes it: every default spelled out except `outputUrlPath`,
 * which follows `outputDir` (a written copy would go stale when `outputDir` changes).
 */
function defaultConfigText(): string {
  const leaveDerivedOut = (key: string, value: unknown): unknown =>
    key === 'outputUrlPath' ? undefined : value;
  return `${JSON.stringify(defaultConfig(), leaveDerivedOut, 2)}\n`;
}

async function writeDefaultConfig({ policy }: Invocation): Promise<OperationReport> {
  const configText = defaultConfigText();
  const facts = {
    configFilePath: resolve(policy.configFile),
    bytes: Buffer.byteLength(configText),
  };
  await assertConfigFileCanBeCreated(policy.configFile);
  if (policy.isDryRun) return succeededReport('init', { ...facts, written: false });
  await writeFile(policy.configFile, configText, { flag: 'wx' });
  return succeededReport('init', { ...facts, written: true });
}

function projectFacts({ config, paths }: CheckedProject): Readonly<Record<string, ReportValue>> {
  return {
    projectId: config.projectId,
    configFilePath: paths.configFilePath,
    sourceRoot: paths.sourceRoot,
    cacheRoot: paths.cacheRoot,
    lockFilePath: paths.lockFilePath,
    outputRoot: paths.outputRoot,
    outputMode: config.outputMode,
    outputUrlPath: config.outputUrlPath,
    readTransport: config.r2.read.transport,
    profiles: Object.keys(config.profiles),
  };
}

/** Validates the file's schema, then the real directory layout it describes; writes nothing. */
function validateConfigFile({ policy }: Invocation): Promise<OperationReport> {
  return runWithCheckedProject('validate', policy.configFile, (project) =>
    Promise.resolve(succeededReport('validate', projectFacts(project))),
  );
}

async function reportFileDigest({ positionals }: Invocation): Promise<OperationReport> {
  const [file = ''] = positionals;
  const digest = await hashFile(file);
  return succeededReport('hash', { file, sha256: digest.sha256, bytes: digest.bytes });
}

/** The policies this command accepts, with the values the user chose; nothing else. */
function acceptedPolicyDetails({ policy, acceptedFlags }: Invocation): ErrorDetails {
  return {
    ...(acceptedFlags.includes('dry-run') ? { dryRun: policy.isDryRun } : {}),
    ...(acceptedFlags.includes('offline') ? { offline: policy.isOffline } : {}),
    ...(policy.concurrency === undefined ? {} : { concurrency: policy.concurrency }),
  };
}

function reportPlannedCommand(invocation: Invocation): Promise<OperationReport> {
  const notImplemented = new PipelineError(
    'NOT_IMPLEMENTED',
    `"${invocation.command}" is planned; nothing was read, written or transferred.`,
    acceptedPolicyDetails(invocation),
  );
  return Promise.resolve(failedReport(invocation.command, notImplemented));
}

/** `build --dry-run` previews; a real build publishes. */
function previewOrBuild(invocation: Invocation, runtime: CommandRuntime): Promise<OperationReport> {
  return invocation.policy.isDryRun
    ? previewBuildOutput(invocation)
    : buildOutput(invocation, runtime);
}

const IMPLEMENTED_COMMAND_RUNNERS = new Map<string, CommandRunner>([
  ['init', writeDefaultConfig],
  ['validate', validateConfigFile],
  ['hash', reportFileDigest],
  ['scan', scanSources],
  ['push', pushSources],
  ['pull', pullSources],
  ['build', previewOrBuild],
  ['verify', verifyPublishedOutput],
  ['doctor', diagnoseProject],
  ['cache prune', runCachePrune],
]);

/** Runs a parsed invocation; planned commands report NOT_IMPLEMENTED with the policy they got. */
export function runInvocation(
  invocation: Invocation,
  runtime: CommandRuntime,
): Promise<OperationReport> {
  const runner = IMPLEMENTED_COMMAND_RUNNERS.get(invocation.command) ?? reportPlannedCommand;
  return runner(invocation, runtime);
}
