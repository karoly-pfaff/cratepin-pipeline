import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const SUBPROCESS_TIMEOUT_MS = 120_000;

/** npm's JavaScript entry avoids shell quoting and Windows command shims. */
export function locateNpmCli() {
  const fromNpmScript = process.env.npm_execpath;
  if (fromNpmScript && basename(fromNpmScript).startsWith('npm-cli')) return fromNpmScript;
  const nodeDirectory = dirname(process.execPath);
  const candidates = [
    join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  return npmCli ?? failPackageCheck('npm-cli.js not found; run "npm run check:package"');
}

export function failPackageCheck(message) {
  throw new Error(`Package check failed: ${message}`);
}

export function runAndCaptureOutput(command, args, spawnOptions) {
  const run = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: SUBPROCESS_TIMEOUT_MS,
    ...spawnOptions,
  });
  const spawnFailure = run.error ? `spawn failed: ${run.error.code ?? run.error.message}\n` : '';
  const stdout = run.stdout ?? '';
  return { status: run.status, stdout, diagnostics: `${spawnFailure}${stdout}${run.stderr ?? ''}` };
}

export function runAndRequireSuccess(command, args, spawnOptions) {
  const run = runAndCaptureOutput(command, args, spawnOptions);
  if (run.status !== 0)
    failPackageCheck(`${basename(command)} ${args.join(' ')}\n${run.diagnostics}`);
  return run;
}

export function runNpm(args, spawnOptions) {
  return runAndCaptureOutput(
    process.execPath,
    [locateNpmCli(), '--no-update-notifier', ...args],
    spawnOptions,
  );
}

export function runNpmAndRequireSuccess(args, spawnOptions) {
  return runAndRequireSuccess(
    process.execPath,
    [locateNpmCli(), '--no-update-notifier', ...args],
    spawnOptions,
  );
}
