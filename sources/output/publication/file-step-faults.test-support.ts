// Fails, freezes or tears the file system steps a build takes under one directory, in this
// process: the `fs/promises` functions that create, move and remove files and `fs`
// createWriteStream are replaced once, on import, and `syncBuiltinESMExports` makes every module's
// named imports see the replacements (node --test runs each test file in its own process). A
// step outside every armed directory, or taken while nothing is armed, runs untouched, so the
// cache and the test's own fixture I/O are never faulted.
import fs from 'node:fs';
import type { PathLike, WriteStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** The file system functions a publication changes the disk with. */
type FileStepOperation =
  'mkdir' | 'rename' | 'link' | 'unlink' | 'rmdir' | 'rm' | 'writeFile' | 'createWriteStream';

/**
 * Names one step the same way in every run: its key (its operation and its path(s) relative to
 * the armed directory, with random names and digests replaced) and how many steps of that key
 * came before it. Two trees in a trash can trade places between runs, so a step is never named
 * by its position alone.
 */
export interface StepMark {
  readonly key: string;
  readonly occurrence: number;
}

/** One step as recorded: its mark, its operation and its position in the run. */
export interface FileStep extends StepMark {
  readonly operation: FileStepOperation;
  readonly index: number;
}

/**
 * What happens to a step: it runs, fails with EIO, fails with ENOENT as if its directory vanished,
 * or (a file write) writes half and fails.
 */
type StepFate = 'run' | 'fail' | 'tear' | 'vanish';

/** Decides the fate of each step in an armed directory, in the order they come. */
export type FaultPlan = (step: FileStep) => StepFate;

/** The steps taken in an armed directory, and the ones that were failed or torn. */
export interface FaultedRun {
  readonly steps: readonly FileStep[];
  readonly faults: readonly FileStep[];
}

interface ArmedDirectory {
  readonly directory: string;
  readonly plan: FaultPlan;
  readonly steps: FileStep[];
  readonly faults: FileStep[];
}

const armedDirectories: ArmedDirectory[] = [];

function isMarked(step: StepMark, mark: StepMark): boolean {
  return step.key === mark.key && step.occurrence === mark.occurrence;
}

/** Every step runs; the run is only recorded. */
export const recordOnly: FaultPlan = () => 'run';

/** The marked step fails once with EIO; every other step runs. */
export function failAt(mark: StepMark): FaultPlan {
  return (step) => (isMarked(step, mark) ? 'fail' : 'run');
}

/**
 * The marked step and every later one fail with EIO, as if the process had stopped there:
 * nothing more changes on disk, and every cleanup and recovery step fails too.
 */
export function freezeFrom(mark: StepMark): FaultPlan {
  let isFrozen = false;
  return (step) => {
    isFrozen ||= isMarked(step, mark);
    return isFrozen ? 'fail' : 'run';
  };
}

/**
 * The marked step fails once with ENOENT, as when another process removed a directory on its way
 * just before; every other step runs.
 */
export function vanishedAt(mark: StepMark): FaultPlan {
  return (step) => (isMarked(step, mark) ? 'vanish' : 'run');
}

/** The marked file write puts half its first chunk on disk, then fails with EIO. */
export function tornWriteAt(mark: StepMark): FaultPlan {
  return (step) => (isMarked(step, mark) ? 'tear' : 'run');
}

function injectedError(): Error {
  return Object.assign(new Error('EIO: injected i/o error'), { code: 'EIO' });
}

function vanishedError(): Error {
  return Object.assign(new Error('ENOENT: injected missing directory'), { code: 'ENOENT' });
}

const RANDOM_NAMES: readonly (readonly [RegExp, string])[] = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<uuid>'],
  [/[0-9a-f]{64}/gu, '<sha256>'],
  [/(?<=generations\/)[0-9a-f]{16}/gu, '<generation>'],
];

function normalizedPath(directory: string, path: string): string {
  const forward = relative(directory, path).split(sep).join('/');
  return RANDOM_NAMES.reduce((text, [pattern, name]) => text.replaceAll(pattern, name), forward);
}

function isInside(directory: string, path: string): boolean {
  const rest = relative(directory, path);
  return !rest.startsWith('..') && !isAbsolute(rest);
}

/** The armed directory holding any of the paths, if one does. */
function armedDirectoryOf(paths: readonly string[]): ArmedDirectory | undefined {
  return armedDirectories.find(({ directory }) => paths.some((path) => isInside(directory, path)));
}

/** Records the step in the armed directory it touches and returns its fate. */
function fateOf(operation: FileStepOperation, pathLikes: readonly unknown[]): StepFate {
  const paths = pathLikes.map((path) => resolve(String(path)));
  const armed = armedDirectoryOf(paths);
  if (armed === undefined) return 'run';
  const key = `${operation} ${paths.map((path) => normalizedPath(armed.directory, path)).join(' > ')}`;
  const occurrence = armed.steps.filter((earlier) => earlier.key === key).length;
  const step = { key, occurrence, operation, index: armed.steps.length };
  const fate = armed.plan(step);
  armed.steps.push(step);
  if (fate !== 'run') armed.faults.push(step);
  return fate;
}

type AsyncFileFunction = (...args: unknown[]) => Promise<unknown>;

/** `original`, unless the step's plan fails it; a torn write of a whole file fails before it starts. */
function faultingAsync(
  operation: FileStepOperation,
  original: AsyncFileFunction,
  pathCount: number,
): AsyncFileFunction {
  return async (...args) => {
    const fate = fateOf(operation, args.slice(0, pathCount));
    if (fate === 'vanish') throw vanishedError();
    if (fate !== 'run') throw injectedError();
    return original(...args);
  };
}

type WriteCallback = (error: Error | null, written?: number) => void;
type WriteArguments = [number, Uint8Array, number, number, number | null, WriteCallback];

/** File functions for a write stream whose open fails with `error`, so nothing reaches the disk. */
function failingOpen(error: () => Error): object {
  return {
    open: (...args: unknown[]) => {
      const callback = args.at(-1) as (failure: Error) => void;
      queueMicrotask(() => {
        callback(error());
      });
    },
    write: fs.write,
    close: fs.close,
    fsync: fs.fsync,
  };
}

/** File functions for a write stream whose first write puts half its bytes on disk, then fails. */
const TEARING_WRITE = {
  open: fs.open,
  write: (...args: WriteArguments) => {
    const [fd, buffer, offset, length, position, callback] = args;
    fs.write(fd, buffer, offset, Math.floor(length / 2), position, (error) => {
      callback(error ?? injectedError());
    });
  },
  close: fs.close,
  fsync: fs.fsync,
};

const STREAM_FILE_FUNCTIONS = {
  fail: failingOpen(injectedError),
  vanish: failingOpen(vanishedError),
  tear: TEARING_WRITE,
} as const;

type CreateWriteStream = (path: PathLike, options?: object) => WriteStream;

function faultingCreateWriteStream(original: CreateWriteStream): CreateWriteStream {
  return (path, options) => {
    const fate = fateOf('createWriteStream', [path]);
    if (fate === 'run') return original(path, options);
    return original(path, { ...options, fs: STREAM_FILE_FUNCTIONS[fate] });
  };
}

const ONE_PATH_OPERATIONS = ['mkdir', 'unlink', 'rmdir', 'rm', 'writeFile'] as const;
const TWO_PATH_OPERATIONS = ['rename', 'link'] as const;

/** Replaces the functions once, for the whole process; they pass through until a directory is armed. */
function installFaultingFunctions(): void {
  const promises = fsPromises as unknown as Record<FileStepOperation, AsyncFileFunction>;
  for (const operation of ONE_PATH_OPERATIONS) {
    promises[operation] = faultingAsync(operation, promises[operation], 1);
  }
  for (const operation of TWO_PATH_OPERATIONS) {
    promises[operation] = faultingAsync(operation, promises[operation], 2);
  }
  const streams = fs as unknown as { createWriteStream: CreateWriteStream };
  streams.createWriteStream = faultingCreateWriteStream(streams.createWriteStream);
  syncBuiltinESMExports();
}

installFaultingFunctions();

/**
 * Runs `run` with every file step under `directory` recorded and faulted as `plan` says; what
 * `run` returned or threw is passed on with the steps. Several directories may be armed at once.
 */
export async function withFileStepFaults<Result>(
  directory: string,
  plan: FaultPlan,
  run: () => Promise<Result>,
): Promise<FaultedRun & { readonly result: Result | undefined; readonly error?: unknown }> {
  const armed: ArmedDirectory = { directory: resolve(directory), plan, steps: [], faults: [] };
  armedDirectories.push(armed);
  try {
    return { result: await run(), steps: armed.steps, faults: armed.faults };
  } catch (error) {
    return { result: undefined, error, steps: armed.steps, faults: armed.faults };
  } finally {
    armedDirectories.splice(armedDirectories.indexOf(armed), 1);
  }
}

/**
 * The steps worth faulting, in run order: the first and the last occurrence of each key. A key
 * names one operation on one normalized path, so only a step repeated on that same path (such as
 * a directory created again) has middle occurrences to drop.
 */
export function firstAndLastOfEachKey(steps: readonly FileStep[]): FileStep[] {
  const lastOccurrences = new Map(steps.map(({ key, occurrence }) => [key, occurrence]));
  return steps.filter(
    ({ key, occurrence }) => occurrence === 0 || occurrence === lastOccurrences.get(key),
  );
}
