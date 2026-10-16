import { watch } from 'node:fs';

const PINNED_INPUTS = new Set(['cratepin.config.json', 'cratepin-lock.json']);

function watchPinnedInputs(projectRoot, queue) {
  return watch(projectRoot, (_eventType, filename) => {
    if (filename === null || PINNED_INPUTS.has(filename.toString())) queue.request();
  });
}

/** Watches the parent directory so atomic replacement does not detach a file watcher. */
export function watchProjectInputs({ projectRoot, queue }) {
  const watcher = watchPinnedInputs(projectRoot, queue);
  const watcherClosed = new Promise((resolve) => watcher.once('close', resolve));
  let watchFailure;
  const lifecycle = {
    async close() {
      watcher.close();
      const snapshot = await queue.close();
      await watcherClosed;
      return { ...snapshot, watchFailure };
    },
  };
  watcher.once('error', (failure) => {
    watchFailure = failure;
    void lifecycle.close();
  });
  return lifecycle;
}
