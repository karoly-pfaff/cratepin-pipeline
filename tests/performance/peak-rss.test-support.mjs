// Loaded with `node --import` before the CLI: on exit, writes the process's peak resident memory
// to stderr as `PEAK_RSS_KIB <kibibytes>`, so a test can compare runs over inputs of other sizes.
import { readFileSync } from 'node:fs';

function peakResidentKiB() {
  if (process.platform !== 'linux') return process.resourceUsage().maxRSS;
  // Linux rusage can include the spawning fake server's pre-exec peak; VmHWM belongs to this image.
  const status = readFileSync('/proc/self/status', 'utf8');
  const measured = /^VmHWM:\s+(\d+)\s+kB$/mu.exec(status);
  if (!measured) throw new Error('Linux process peak RSS is unavailable');
  return Number(measured[1]);
}

process.on('exit', () => {
  process.stderr.write(`\nPEAK_RSS_KIB ${String(peakResidentKiB())}\n`);
});
