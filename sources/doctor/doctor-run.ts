import type { ConfigIssue } from '../config/pipeline-config.ts';
import { PipelineError, toPipelineError } from '../errors.ts';
import { loadCheckedProject } from '../paths/layout/checked-project.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import type { RunEnvironment } from '../storage/r2/r2-connection.ts';
import { checkReadAccess, checkWriterAccess } from './access-checks.ts';
import type { AccessRequest } from './access-checks.ts';
import { failed, guarded, passed, skipped } from './doctor-check.ts';
import type { CheckName, DoctorCheck } from './doctor-check.ts';
import { checkCache, checkLock, checkOutput } from './project-checks.ts';
import type { LockCheck } from './project-checks.ts';

export interface DoctorRequest {
  readonly configFile: string;
  /** No credential is resolved and no request is sent. */
  readonly isOffline: boolean;
  readonly environment: RunEnvironment;
}

export interface DoctorResult {
  /** The loaded project, absent when the config itself failed. */
  readonly project?: CheckedProject;
  /** Every check in the order they ran, failed ones included. */
  readonly checks: readonly DoctorCheck[];
}

const AFTER_CONFIG: readonly CheckName[] = [
  'lock',
  'cache',
  'output',
  'read-access',
  'writer-access',
];
const OFFLINE_REASON = '--offline: no credential is resolved and no request is sent.';

async function accessChecks(request: AccessRequest, isOffline: boolean): Promise<DoctorCheck[]> {
  if (isOffline)
    return [skipped('read-access', OFFLINE_REASON), skipped('writer-access', OFFLINE_REASON)];
  return [
    await guarded('read-access', () => checkReadAccess(request)),
    await guarded('writer-access', () => checkWriterAccess(request)),
  ];
}

/** The lock check; a lock file that cannot be read fails it like an invalid one. */
async function lockCheckOf(project: CheckedProject): Promise<LockCheck> {
  try {
    return await checkLock(project);
  } catch (error) {
    return { check: failed('lock', toPipelineError(error)) };
  }
}

async function projectChecks(
  project: CheckedProject,
  request: DoctorRequest,
): Promise<DoctorCheck[]> {
  const { check: lockCheck, lock } = await lockCheckOf(project);
  const concurrency = project.config.limits.concurrency;
  const cache =
    lock === undefined
      ? skipped('cache', 'There is no valid committed lock to check the cache against.')
      : await guarded('cache', () => checkCache(project, lock, concurrency));
  const output = await guarded('output', () => checkOutput(project));
  const access = await accessChecks(
    { project, lock, environment: request.environment },
    request.isOffline,
  );
  return [lockCheck, cache, output, ...access];
}

/**
 * Looks at a project the way its commands would meet it and reports what it finds, read only:
 * it never writes, never takes a claim, and with `isOffline` resolves no credential and sends no
 * request. A failing check never stops the later ones, except that nothing runs without a valid
 * config and the cache check needs a valid lock.
 */
export async function runDoctor(request: DoctorRequest): Promise<DoctorResult> {
  const load = await loadCheckedProject(request.configFile).catch(toPipelineError);
  if (load instanceof PipelineError) return configFailure(failed('config', load));
  if (!load.ok) return invalidConfigResult(load.issues);
  const { project } = load;
  const { projectId, outputMode } = project.config;
  const config = passed('config', `Project "${projectId}" with ${outputMode} output.`);
  return { project, checks: [config, ...(await projectChecks(project, request))] };
}

/** Without a valid config nothing else can be looked at. */
function invalidConfigResult(issues: readonly ConfigIssue[]): DoctorResult {
  const invalid = new PipelineError('CONFIG_INVALID', 'Configuration is invalid; see the issues.', {
    issueCount: issues.length,
  });
  return configFailure(failed('config', invalid, { issues }));
}

/** A config that cannot be loaded or is invalid: every later check is skipped. */
function configFailure(configCheck: DoctorCheck): DoctorResult {
  const rest = AFTER_CONFIG.map((check) => skipped(check, 'There is no valid configuration.'));
  return { checks: [configCheck, ...rest] };
}
