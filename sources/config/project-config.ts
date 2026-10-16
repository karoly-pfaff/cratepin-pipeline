import { dirname, resolve } from 'node:path';
import { readTextWithin } from '../paths/files/bounded-text.ts';

import type { ConfigIssue, PipelineConfig } from './pipeline-config.ts';
import { configIssue } from './rules/field-rules.ts';
import { validateConfig } from './validation.ts';
import { parseStrictJson } from '../json/strict-json.ts';

/** Absolute locations, resolved from the config file's directory, never the working directory. */
export interface ProjectPaths {
  readonly configFilePath: string;
  readonly configDirectory: string;
  readonly sourceRoot: string;
  readonly cacheRoot: string;
  readonly lockFilePath: string;
  readonly outputRoot: string;
}

export interface ProjectConfig {
  readonly config: PipelineConfig;
  readonly paths: ProjectPaths;
}

export type ProjectConfigLoad =
  | { readonly ok: true; readonly project: ProjectConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export function resolveProjectPaths(config: PipelineConfig, configFile: string): ProjectPaths {
  const absoluteConfigFile = resolve(configFile);
  const configDirectory = dirname(absoluteConfigFile);
  const fromConfigDirectory = (relativePath: string): string =>
    resolve(configDirectory, relativePath);
  return {
    configFilePath: absoluteConfigFile,
    configDirectory,
    sourceRoot: fromConfigDirectory(config.sourceDir),
    cacheRoot: fromConfigDirectory(config.cacheDir),
    lockFilePath: fromConfigDirectory(config.lockFile),
    outputRoot: fromConfigDirectory(config.outputDir),
  };
}

/** A config larger than this is not a hand-written project config. */
const MAX_CONFIG_BYTES = 1024 * 1024;
const OVERSIZED_CONFIG = 'Larger than 1 MiB; not a project config';

/** Parses, validates and resolves config text read from `configFile`. */
function projectConfigOf(text: string, configFile: string): ProjectConfigLoad {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.problems.map(({ path, message }) => configIssue(path, message)),
    };
  }
  const validation = validateConfig(parsed.value);
  if (!validation.ok) return validation;
  const paths = resolveProjectPaths(validation.config, configFile);
  return { ok: true, project: { config: validation.config, paths } };
}

/** Reads, validates and resolves a config file; read failures propagate as filesystem errors. */
export async function loadProjectConfig(configFile: string): Promise<ProjectConfigLoad> {
  const text = await readTextWithin(configFile, MAX_CONFIG_BYTES);
  if (text === undefined) return { ok: false, issues: [configIssue('', OVERSIZED_CONFIG)] };
  return projectConfigOf(text, configFile);
}
