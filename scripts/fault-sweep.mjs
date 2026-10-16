// Runs the push and pull fault matrices over seeds 1 to 200 instead of the default three, to find
// a seed whose parameters break an invariant; a failing run prints the command replaying it.
import { spawnSync } from 'node:child_process';

const MATRICES = [
  'sources/push/push-fault-matrix.test.ts',
  'sources/pull/pull-fault-matrix.test.ts',
];
const run = spawnSync(process.execPath, ['--test', ...MATRICES], {
  stdio: 'inherit',
  // A seed left from a replay command would turn the sweep into a single run.
  env: {
    ...process.env,
    CRATEPIN_FAULT_SEED: '',
    CRATEPIN_FAULT_SWEEP: process.env.CRATEPIN_FAULT_SWEEP ?? '200',
  },
});
process.exit(run.status ?? 1);
