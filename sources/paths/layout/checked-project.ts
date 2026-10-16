import type { ConfigIssue, PipelineConfig } from '../../config/pipeline-config.ts';
import { loadProjectConfig } from '../../config/project-config.ts';
import { PipelineError } from '../../errors.ts';
import type { ProjectConfig, ProjectPaths } from '../../config/project-config.ts';
import { projectLayoutIssues } from './project-layout.ts';

export type CheckedProjectLoad =
  | { readonly ok: true; readonly project: CheckedProject }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/** Not exported: code outside this module cannot name it, so it cannot fake the brand below. */
const PASSED_PREFLIGHT: unique symbol = Symbol('passed layout preflight');

/**
 * A project whose configuration validated and whose real directory layout passed the preflight.
 * Only the preflight (`loadCheckedProject` or `CheckedProject.fromValidatedProject`) can create
 * one, so every API that writes must take this type and cannot be handed unchecked paths. The
 * preflight does not freeze the file system: writers still re-verify the parent chain of each
 * path they mutate (see docs/guides/safety.md).
 */
export class CheckedProject {
  /** Makes the type nominal: a plain `{ config, paths }` object is not a CheckedProject. */
  readonly [PASSED_PREFLIGHT] = true;
  readonly config: PipelineConfig;
  readonly paths: ProjectPaths;

  private constructor(project: ProjectConfig) {
    this.config = project.config;
    this.paths = project.paths;
  }

  /** Runs the layout preflight on an already validated project. */
  static async fromValidatedProject(project: ProjectConfig): Promise<CheckedProjectLoad> {
    const issues = await projectLayoutIssues(project.paths);
    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, project: new CheckedProject(project) };
  }
}

/**
 * Runs the layout preflight again right before a write: the first one described the file system
 * at load time, so a directory or link swapped in since then is caught (a narrow race remains).
 * `consequence` tells the user what therefore did not happen, e.g. "the lock was not written".
 */
export async function assertLayoutStillSafe(
  project: CheckedProject,
  consequence: string,
): Promise<void> {
  const issues = await projectLayoutIssues(project.paths);
  if (issues.length === 0) return;
  throw new PipelineError('OUTPUT_CONFLICT', `The project layout changed; ${consequence}.`, {
    issues: issues.map((issue) => issue.path).join(', '),
  });
}

/** Loads, validates and preflights a project; the only way to obtain a CheckedProject. */
export async function loadCheckedProject(configFile: string): Promise<CheckedProjectLoad> {
  const load = await loadProjectConfig(configFile);
  if (!load.ok) return load;
  return CheckedProject.fromValidatedProject(load.project);
}
