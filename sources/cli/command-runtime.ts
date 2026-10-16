import { ResolvedSecrets } from '../redaction.ts';
import type { RunEnvironment } from '../storage/r2/r2-connection.ts';

/**
 * What a command may use besides its arguments: the environment variables (read only when a
 * transfer needs credentials) and the run's resolved secrets for redaction.
 */
export interface CommandRuntime extends RunEnvironment {
  /**
   * From the first call on, Ctrl+C (or SIGTERM, or Ctrl+Break on Windows) aborts the returned
   * signal instead of ending the process; a second one ends it as usual. Only commands that check the signal ask for it, so every
   * other command keeps the default: Ctrl+C ends it at once.
   */
  readonly cancellationSignal: () => AbortSignal;
}

/** Ctrl+C, a termination request, and Ctrl+Break on Windows all ask a command to stop cleanly. */
const CANCELLING_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];

/** Aborts on the first cancelling signal and lets every later one end the process as usual. */
function abortOnFirstSignal(controller: AbortController): void {
  const onSignal = (): void => {
    for (const name of CANCELLING_SIGNALS) process.removeListener(name, onSignal);
    controller.abort();
  };
  for (const name of CANCELLING_SIGNALS) process.on(name, onSignal);
}

/** A runtime for one process run. */
export function processRuntime(): CommandRuntime {
  let cancellation: AbortController | undefined;
  const cancellationSignal = (): AbortSignal => {
    if (cancellation === undefined) {
      const controller = new AbortController();
      abortOnFirstSignal(controller);
      cancellation = controller;
    }
    return cancellation.signal;
  };
  return { variables: process.env, secrets: new ResolvedSecrets(), cancellationSignal };
}
