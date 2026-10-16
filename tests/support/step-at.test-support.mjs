// Loaded with `node --import` before the CLI: stops the process at one file system step named by
// STEP_AT="<crash|pause>:<operation>:<pattern>:<before|after>[:<n>]".
//
// - <operation> is mkdir, rmdir, rm, unlink, readdir, writeFile, createWriteStream, rename or
//   link.
// - <pattern> is a regular expression tested against the step's path with forward slashes; a
//   rename or link is `<from> -> <to>`, so `\.part -> .*/originals/` names a part file linked as
//   an entry. Only the <n>-th matching step (default the first) stops.
// - `crash` ends the process abruptly there, as a crash or power cut would: nothing is cleaned up
//   and no handler runs.
// - `pause` writes <PAUSE_DIR>/<PAUSE_LABEL>.reached and waits until <PAUSE_LABEL>.go exists, then
//   goes on; it calls none of the functions it replaces. createWriteStream returns its stream at
//   once, so its pause blocks the whole process; a stream opens its file asynchronously, so
//   `after` there means only that the call returned.
import fs, { existsSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ASYNC_OPERATIONS = [
  'mkdir',
  'rmdir',
  'rm',
  'unlink',
  'readdir',
  'writeFile',
  'rename',
  'link',
];
const TWO_PATH_OPERATIONS = new Set(['rename', 'link']);
const PAUSE_POLL_MS = 20;

/** The step STEP_AT names; the pattern may itself hold colons. */
function parseStep(text) {
  const parts = text.split(':');
  const occurrence = /^\d+$/u.test(parts.at(-1)) ? Number(parts.pop()) : 1;
  const timing = parts.pop();
  const [action, operation, ...pattern] = parts;
  return { action, operation, pattern: new RegExp(pattern.join(':'), 'u'), timing, occurrence };
}

const step = parseStep(process.env.STEP_AT ?? '');
let matchedCount = 0;

/** The text the pattern is tested against: the step's path or paths, with forward slashes. */
function targetOf(args) {
  const pathCount = TWO_PATH_OPERATIONS.has(step.operation) ? 2 : 1;
  return args
    .slice(0, pathCount)
    .map((path) => String(path).replaceAll('\\', '/'))
    .join(' -> ');
}

/** Whether this call is the step to stop at; counts every matching call. */
function isStepAt(args) {
  if (!step.pattern.test(targetOf(args))) return false;
  matchedCount += 1;
  return matchedCount === step.occurrence;
}

function crash() {
  process.kill(process.pid, 'SIGKILL');
}

/** Says the step is reached; returns the file whose appearance lets the process go on. */
function announcePause() {
  const base = join(process.env.PAUSE_DIR ?? '.', process.env.PAUSE_LABEL ?? 'step');
  writeFileSync(`${base}.reached`, String(process.pid));
  return `${base}.go`;
}

async function pauseAsync() {
  const go = announcePause();
  while (!existsSync(go)) await delay(PAUSE_POLL_MS);
}

const SLEEPER = new Int32Array(new SharedArrayBuffer(4));

/** Blocks the whole process: a synchronous call cannot return before it goes on. */
function pauseSync() {
  const go = announcePause();
  while (!existsSync(go)) Atomics.wait(SLEEPER, 0, 0, PAUSE_POLL_MS);
}

const stopAsync = step.action === 'crash' ? async () => crash() : pauseAsync;
const stopSync = step.action === 'crash' ? crash : pauseSync;

function steppedAsync(original) {
  return async (...args) => {
    const isTarget = isStepAt(args);
    if (isTarget && step.timing === 'before') await stopAsync();
    const result = await original(...args);
    if (isTarget && step.timing === 'after') await stopAsync();
    return result;
  };
}

function steppedSync(original) {
  return (...args) => {
    const isTarget = isStepAt(args);
    if (isTarget && step.timing === 'before') stopSync();
    const result = original(...args);
    if (isTarget && step.timing === 'after') stopSync();
    return result;
  };
}

if (ASYNC_OPERATIONS.includes(step.operation)) {
  fsPromises[step.operation] = steppedAsync(fsPromises[step.operation]);
}
if (step.operation === 'createWriteStream')
  fs.createWriteStream = steppedSync(fs.createWriteStream);
syncBuiltinESMExports();
