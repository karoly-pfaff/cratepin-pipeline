import { PipelineError } from '../errors.ts';
import { objectKeyFor } from '../lock/source-lock.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import { lockedObjectsOf } from '../lock/upload-plan.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { openReadTransport } from '../pull/read-transport.ts';
import { createR2BlobReader } from '../storage/r2/r2-blob-store.ts';
import { resolveR2Connection } from '../storage/r2/r2-connection.ts';
import { transferSettingsFrom } from '../storage/transfer/transfer-settings.ts';
import type { RunEnvironment } from '../storage/r2/r2-connection.ts';
import { failed, noticed, passed, skipped } from './doctor-check.ts';
import type { DoctorCheck } from './doctor-check.ts';
import type { StoredBlob } from '../blob-store.ts';

/** What the access checks need: the project, its lock if any, and where credentials come from. */
export interface AccessRequest {
  readonly project: CheckedProject;
  readonly lock: SourceLock | undefined;
  readonly environment: RunEnvironment;
}

/** The object storage is asked about: the first locked original, or a key no original can have. */
interface Probe {
  readonly key: string;
  /** The locked original it stands for; absent for the key that cannot exist. */
  readonly original?: {
    readonly ids: readonly string[];
    readonly sha256: string;
    readonly bytes: number;
  };
}

/** A SHA-256 of all zeros: no original has it, so its key only tests that storage answers. */
const UNMATCHED_SHA256 = '0'.repeat(64);

function probeOf({ project, lock }: AccessRequest): Probe {
  const [first] = lock === undefined ? [] : lockedObjectsOf(lock);
  if (first === undefined) return { key: objectKeyFor(project.config, UNMATCHED_SHA256) };
  return { key: first.objectKey, original: first };
}

type LockedOriginal = NonNullable<Probe['original']>;

function sizeOnlyFinding(named: string): string {
  return `Storage answered for the locked original ${named} with its locked size; a HEAD does not read the bytes, which pull and build verify by hash.`;
}

/**
 * What a HEAD of a locked original found: present with its locked size, missing or another
 * size. Only the size can be compared without reading the object; it never proves the bytes.
 */
function judgedOriginal(
  key: string,
  original: LockedOriginal,
  stored: StoredBlob | undefined,
): DoctorCheck {
  const named = `"${original.ids.join(', ')}" (sha256 ${original.sha256})`;
  if (stored === undefined) {
    const message = `The locked original ${named} is not in storage; push it.`;
    return failed('read-access', new PipelineError('NOT_FOUND', message, { key }));
  }
  if (stored.bytes !== original.bytes) {
    const message = `Storage holds ${named} with another size than the lock.`;
    return failed('read-access', new PipelineError('INTEGRITY_MISMATCH', message, { key }));
  }
  return passed('read-access', sizeOnlyFinding(named), { probedKey: key });
}

/**
 * Without a locked original to ask for, a key no original has was asked for: storage answering
 * shows it is reachable and took the request, not that the bucket or base URL is the right one.
 */
const UNCONFIRMED_STORE =
  'Storage answered a read of a key no original has (there is no locked original to ask for); that does not show the bucket or base URL holds the originals.';

/** What a HEAD of the probe found: for a locked original, see above; else storage answered. */
function judgedProbe(probe: Probe, stored: StoredBlob | undefined): DoctorCheck {
  if (probe.original !== undefined) return judgedOriginal(probe.key, probe.original, stored);
  return noticed('read-access', UNCONFIRMED_STORE);
}

/** One HEAD through the configured read transport; a `s3-readonly` key is resolved only here. */
export async function checkReadAccess(request: AccessRequest): Promise<DoctorCheck> {
  const { config } = request.project;
  const reader = openReadTransport(config, request.environment, config.limits.concurrency);
  const probe = probeOf(request);
  return judgedProbe(probe, await reader.statBlob(probe.key));
}

/** Whether either writer variable is set; one without the other fails as a missing variable. */
function areWriterVariablesSet({ project, environment }: AccessRequest): boolean {
  const { writer } = project.config.r2;
  const names = [writer.accessKeyIdEnv, writer.secretAccessKeyEnv];
  return names.some((name) => (environment.variables[name] ?? '') !== '');
}

/**
 * When the writer variables are set, one HEAD signed with the writer key: storage accepting it
 * proves the key is valid. Write permission itself is not tested: `doctor` never writes.
 */
export async function checkWriterAccess(request: AccessRequest): Promise<DoctorCheck> {
  const { r2, limits } = request.project.config;
  if (!areWriterVariablesSet(request)) {
    return skipped(
      'writer-access',
      'The writer variables are not set; only authors who push need them.',
    );
  }
  const connection = resolveR2Connection(r2, 'write', request.environment);
  const reader = createR2BlobReader(connection, transferSettingsFrom(limits, limits.concurrency));
  const probe = probeOf(request);
  return judgedWriterProbe(probe, await reader.statBlob(probe.key));
}

const NEVER_WRITES = 'write permission is not tested, as doctor never writes';

/**
 * Storage only proves it accepted the writer key when it finds the locked original with it; a
 * not-found answer also comes from a wrong bucket, so it confirms nothing.
 */
function judgedWriterProbe(probe: Probe, stored: StoredBlob | undefined): DoctorCheck {
  if (probe.original !== undefined && stored !== undefined) {
    return passed(
      'writer-access',
      `Storage accepted the writer key and found a locked original; ${NEVER_WRITES}.`,
    );
  }
  return noticed(
    'writer-access',
    `Storage answered the writer key but found no locked original, so the key and bucket are not confirmed; ${NEVER_WRITES}.`,
  );
}
