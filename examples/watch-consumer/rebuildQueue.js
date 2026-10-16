/** Experimental host-side lifecycle; callbacks own their I/O and cooperative cancellation. */
export class RebuildQueue {
  #build;
  #debounceMs;
  #timer;
  #isRunning = false;
  #isPending = false;
  #isClosed = false;
  #activeRun = Promise.resolve();
  #controller;
  #lastFailure;

  constructor({ build, debounceMs = 25 }) {
    if (typeof build !== 'function') throw new TypeError('Expected a build callback');
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 1000)
      throw new RangeError('debounceMs must be an integer from 0 to 1000');
    this.#build = build;
    this.#debounceMs = debounceMs;
  }

  get snapshot() {
    return {
      isRunning: this.#isRunning,
      hasPending: this.#isPending,
      isClosed: this.#isClosed,
      lastFailure: this.#lastFailure,
    };
  }

  request() {
    if (this.#isClosed) return false;
    this.#isPending = true;
    if (this.#isRunning) return true;
    this.#scheduleRebuild();
    return true;
  }

  #scheduleRebuild() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#activeRun = Promise.resolve().then(() => this.#runBuild());
    }, this.#debounceMs);
  }

  async #runBuild() {
    if (this.#isClosed) return;
    this.#isRunning = true;
    this.#isPending = false;
    this.#controller = new AbortController();
    await this.#attemptBuild();
    this.#finishRun();
  }

  async #attemptBuild() {
    try {
      await this.#build(this.#controller.signal);
      this.#lastFailure = undefined;
    } catch (failure) {
      this.#lastFailure = failure;
    }
  }

  #finishRun() {
    this.#isRunning = false;
    this.#controller = undefined;
    if (this.#isPending && !this.#isClosed) this.#scheduleRebuild();
  }

  async close() {
    this.#isClosed = true;
    this.#isPending = false;
    clearTimeout(this.#timer);
    this.#controller?.abort();
    await this.#activeRun;
    return this.snapshot;
  }
}
