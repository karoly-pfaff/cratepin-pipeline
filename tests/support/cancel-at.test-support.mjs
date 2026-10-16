// Loaded with `node --import` before the CLI: delivers SIGINT, as a first Ctrl+C would, at one
// step named by CANCEL_AT, so the command's own cancellation runs (a real Ctrl+C cannot be sent
// to a child process on Windows). `mkdir:<suffix>` right after a directory ending with <suffix>
// is created; `createWriteStream:<suffix>` right after a file ending with <suffix> is opened for
// writing; `rm:<suffix>` right after a path ending with <suffix> is removed. Only the first
// match counts.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const [operation, target] = (process.env.CANCEL_AT ?? '').split(':');
let isDelivered = false;

function cancelAt(path) {
  if (isDelivered || !String(path).endsWith(target)) return;
  isDelivered = true;
  process.emit('SIGINT');
}

function afterAsync(original) {
  return async (path, ...rest) => {
    const result = await original(path, ...rest);
    cancelAt(path);
    return result;
  };
}

function afterSync(original) {
  return (path, ...rest) => {
    const result = original(path, ...rest);
    cancelAt(path);
    return result;
  };
}

if (operation === 'mkdir') fsPromises.mkdir = afterAsync(fsPromises.mkdir);
if (operation === 'rm') fsPromises.rm = afterAsync(fsPromises.rm);
if (operation === 'createWriteStream') fs.createWriteStream = afterSync(fs.createWriteStream);
syncBuiltinESMExports();
