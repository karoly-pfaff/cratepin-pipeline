/**
 * Runs at most `limit` tasks at the same time. The first failure is kept: no further task is
 * accepted, and `finish` rethrows it once every running task has settled, so nothing is still
 * transferring when the caller cleans up.
 */
export class BoundedTasks {
  private readonly limit: number;
  private readonly running = new Set<Promise<void>>();
  private firstFailure: { readonly error: unknown } | undefined;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Starts `task`, first waiting while `limit` tasks run; rethrows an earlier failure. */
  async start(task: () => Promise<void>): Promise<void> {
    this.throwIfFailed();
    const settled = task().catch((error: unknown) => {
      this.firstFailure ??= { error };
    });
    const tracked = settled.then(() => {
      this.running.delete(tracked);
    });
    this.running.add(tracked);
    if (this.running.size >= this.limit) await Promise.race(this.running);
    this.throwIfFailed();
  }

  /**
   * Starts every task in order, `limit` at a time, and waits for all of them. After the first
   * failure no further task starts; the running ones settle before the failure is rethrown.
   */
  async runAll(tasks: Iterable<() => Promise<void>>): Promise<void> {
    try {
      for (const task of tasks) await this.start(task);
      await this.finish();
    } catch (error) {
      await this.settle();
      throw error;
    }
  }

  /** Waits for every running task, then rethrows the first failure, if any. */
  async finish(): Promise<void> {
    await this.settle();
    this.throwIfFailed();
  }

  /** Waits for every running task without throwing; for cleanup after an error elsewhere. */
  async settle(): Promise<void> {
    await Promise.all(this.running);
  }

  private throwIfFailed(): void {
    if (this.firstFailure !== undefined) throw this.firstFailure.error;
  }
}

/**
 * Runs `work` for every item, `limit` at a time, and returns the results in item order. The
 * first failure stops further work and is rethrown once the running work has settled.
 */
export async function mapBounded<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  await new BoundedTasks(limit).runAll(
    items.map((item, index) => async () => {
      results[index] = await work(item);
    }),
  );
  return results;
}

/** Runs a task once one of the gate's places is free and frees it when the task settles. */
export type ConcurrencyGate = <Result>(task: () => Promise<Result>) => Promise<Result>;

/**
 * A gate letting at most `limit` tasks run at once; the others wait in the order they came. A
 * freed place passes straight to the next waiting task, so a newcomer never slips past the limit.
 */
export function concurrencyGate(limit: number): ConcurrencyGate {
  let running = 0;
  const waiting: (() => void)[] = [];
  const enter = async (): Promise<void> => {
    if (running < limit) {
      running += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const leave = (): void => {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  };
  return async (task) => {
    await enter();
    try {
      return await task();
    } finally {
      leave();
    }
  };
}
