import { spawn } from 'node:child_process';

function settleCommandExit(commandExit, resolve, reject) {
  if (commandExit.failure) reject(commandExit.failure);
  else if (commandExit.status !== 0)
    reject(new Error(`Offline asset command failed (${String(commandExit.status)})`));
  else resolve();
}

function awaitCommandExit(child) {
  return new Promise((resolve, reject) => {
    let failure;
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (status) => settleCommandExit({ failure, status }, resolve, reject));
  });
}

async function runOfflineCliCommand(settings, cliArguments, signal) {
  signal.throwIfAborted();
  const child = spawn(
    process.execPath,
    [...settings.nodeOptions, settings.cliFile, ...cliArguments],
    {
      cwd: settings.projectRoot,
      signal,
      killSignal: 'SIGINT',
      stdio: 'ignore',
      shell: false,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    },
  );
  await awaitCommandExit(child);
}

/** cliFile is the explicitly selected public CLI bin; no discovery, shell or credential inheritance. */
export function offlineRebuilder({ projectRoot, cliFile, nodeOptions = [] }) {
  const settings = { projectRoot, cliFile, nodeOptions };
  return async (signal) => {
    await runOfflineCliCommand(settings, ['build', '--offline', '--json'], signal);
    await runOfflineCliCommand(settings, ['verify', '--json'], signal);
  };
}
