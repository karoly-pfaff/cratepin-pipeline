import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogSources, inventorySources, loadCheckedProject } from '../../sources/index.ts';
import { serializeLock, stageLock } from '../../sources/lock/source-lock.ts';
import {
  FAKE_CREDENTIALS,
  FAKE_READ_ONLY_CREDENTIALS,
} from '../../sources/storage/testing/fake-s3.test-support.ts';

// Runs the TypeScript entry point directly (Node strips types); check:package covers the built bin.
const CLI = fileURLToPath(new URL('../../sources/cli/main.ts', import.meta.url));
export const DEFAULT_CONFIG_FILE = 'cratepin.config.json';

/** Windows temp roots may use 8.3 aliases; strict path guards need the canonical directory. */
export async function withTempDirectory(runInDirectory) {
  const directory = await mkdtemp(join(tmpdir(), 'cratepin-cli-'));
  try {
    await runInDirectory(await realpath(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Node's own start-up needs; nothing else of this process's environment reaches the CLI. */
const STARTUP_VARIABLES = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };

/** Runs the CLI with no variables of its own, so no real credential can ever reach it. */
export function runCliIn(directory, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: STARTUP_VARIABLES,
  });
}

/** Runs the CLI without blocking this process, so an in-process fake server can answer it. */
export function runCliAsync(directory, variables, ...args) {
  return runCliWith({ directory, variables, nodeOptions: [] }, ...args);
}

/**
 * Starts the CLI. Only `variables` reach its environment, plus PATH and SystemRoot that Node
 * needs to start; `nodeOptions` go before the entry point, e.g. `--import` of a preload. Returns
 * the child, to end it early, and the promise of its exit status and output.
 */
export function startCli({ directory, variables, nodeOptions = [] }, ...args) {
  const child = spawn(process.execPath, [...nodeOptions, CLI, ...args], {
    cwd: directory,
    env: { ...STARTUP_VARIABLES, ...variables },
  });
  const finished = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
  return { child, finished };
}

/** Runs the CLI asynchronously, as `startCli` starts it, to its end. */
export function runCliWith(start, ...args) {
  return startCli(start, ...args).finished;
}

export async function writeSourceTree(directory, files) {
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(directory, 'assets', 'source', ...path.split('/'));
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content);
  }
}

/** Writes the lock the current sources produce, as a finished push would. */
export async function commitCurrentLock(directory) {
  const load = await loadCheckedProject(join(directory, DEFAULT_CONFIG_FILE));
  const catalog = catalogSources(await inventorySources(load.project), load.project.config.assets);
  const staged = stageLock(load.project.config, catalog);
  await writeFile(join(directory, 'cratepin-lock.json'), serializeLock(staged));
}

/** The object key the default config gives the content `text` in project demo. */
export function objectKeyOf(text) {
  return `cratepin/v1/projects/demo/sources/sha256/${createHash('sha256').update(text).digest('hex')}`;
}

export function writerVariablesFor(fake) {
  return {
    R2_ENDPOINT: fake.connection.endpoint.href,
    R2_BUCKET: fake.connection.bucket,
    R2_WRITE_ACCESS_KEY_ID: FAKE_CREDENTIALS.accessKeyId,
    R2_WRITE_SECRET_ACCESS_KEY: FAKE_CREDENTIALS.secretAccessKey,
  };
}

/** The read variables, holding the fake's read-only key as CI would: storage refuses its writes. */
export function readerVariablesFor(fake) {
  return {
    R2_ENDPOINT: fake.connection.endpoint.href,
    R2_BUCKET: fake.connection.bucket,
    R2_READ_ACCESS_KEY_ID: FAKE_READ_ONLY_CREDENTIALS.accessKeyId,
    R2_READ_SECRET_ACCESS_KEY: FAKE_READ_ONLY_CREDENTIALS.secretAccessKey,
  };
}
