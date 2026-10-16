import { installProcessLivenessProbe } from '../../sources/cache/claim-processes.test-support.ts';

// This preload belongs only to the explicit liveness-fixture CLI run, never production startup.
const fixture = installProcessLivenessProbe(Number(process.env.CLAIM_FIXTURE_PID));
fixture.setLive(process.env.CLAIM_FIXTURE_IS_LIVE === 'true');
process.on('exit', () => {
  process.stderr.write(`CLAIM_PROBE_COUNT=${String(fixture.probeCount())}\n`);
  fixture.restore();
});
