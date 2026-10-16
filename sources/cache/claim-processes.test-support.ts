/** A selected external PID's simulated liveness; every other probe reaches the operating system. */
interface ProcessLivenessFixture {
  readonly pid: number;
  readonly setLive: (isLive: boolean) => void;
  readonly probeCount: () => number;
  readonly restore: () => void;
}

/** Uses a still-live parent PID deliberately: its state must come from the fixture, never PID reuse. */
export function installProcessLivenessProbe(pid: number): ProcessLivenessFixture {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error('A liveness fixture needs one external positive PID.');
  }
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'kill');
  if (originalDescriptor === undefined) throw new Error('The process liveness probe is missing.');
  const originalKill = process.kill.bind(process);
  const state = { isLive: false, probes: 0 };
  process.kill = (candidate, signal) => {
    if (candidate !== pid || signal !== 0) return originalKill(candidate, signal);
    state.probes += 1;
    if (state.isLive) return true;
    throw Object.assign(new Error('Simulated missing process'), { code: 'ESRCH' });
  };
  return {
    pid,
    setLive: (isLive) => {
      state.isLive = isLive;
    },
    probeCount: () => state.probes,
    restore: () => {
      Object.defineProperty(process, 'kill', originalDescriptor);
    },
  };
}
