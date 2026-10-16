import { createHash } from 'node:crypto';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';

import type {
  BlobReader,
  BlobUpload,
  BlobWriter,
  CreateOutcome,
  StoredBlob,
  TransferOptions,
} from './blob-store.ts';
import {
  collectUntilCancelled,
  sliceIntoChunks,
  streamChunksUntilCancelled,
} from './byte-streams.ts';
import { PipelineError, throwIfCancelled } from './errors.ts';
import type { ErrorCode } from './errors.ts';

export type BlobOperation = 'stat' | 'read' | 'create';

/** A scripted failure: the next `times` (default 1) matching calls fail with `code`. */
export type InjectedFault =
  | {
      readonly operation: 'stat' | 'create';
      readonly key: string;
      readonly code: ErrorCode;
      readonly times?: number;
    }
  | {
      readonly operation: 'read';
      readonly key: string;
      readonly code: ErrorCode;
      readonly times?: number;
      /** Stream this many bytes first, then fail: a truncated transfer. */
      readonly afterBytes?: number;
    };

export interface MemoryStoreOptions {
  readonly initialContents?: Readonly<Record<string, Uint8Array>>;
  readonly faults?: readonly InjectedFault[];
  readonly chunkBytes?: number;
}

export interface BlobCall {
  readonly operation: BlobOperation;
  readonly key: string;
}

export interface MemoryStore extends BlobReader, BlobWriter {
  readonly storedContents: ReadonlyMap<string, Uint8Array>;
  readonly calls: readonly BlobCall[];
}

interface PendingFault {
  readonly fault: InjectedFault;
  remainingCalls: number;
}

const DEFAULT_CHUNK_BYTES = 64 * 1024;

function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertContentMatchesUpload(upload: BlobUpload, content: Buffer): void {
  const isIntact = content.length === upload.bytes && sha256Hex(content) === upload.sha256;
  if (isIntact) return;
  throw new PipelineError(
    'INTEGRITY_MISMATCH',
    'Uploaded content differs from its declared hash.',
    {
      key: upload.key,
    },
  );
}

function pendingFaultsFrom(faults: readonly InjectedFault[]): PendingFault[] {
  return faults.map((fault) => {
    const isMisplacedTruncation = fault.operation !== 'read' && 'afterBytes' in fault;
    if (isMisplacedTruncation)
      throw new PipelineError('INVALID_DATA', 'afterBytes applies to read faults only.');
    return { fault, remainingCalls: fault.times ?? 1 };
  });
}

function injectedError(fault: InjectedFault): PipelineError {
  return new PipelineError(fault.code, `Injected ${fault.code} for ${fault.operation}.`, {
    key: fault.key,
  });
}

/** Deterministic in-memory BlobReader/BlobWriter with scripted faults, for tests without a network. */
class ScriptedMemoryStore implements MemoryStore {
  readonly storedContents = new Map<string, Uint8Array>();
  readonly calls: BlobCall[] = [];
  private readonly pendingFaults: PendingFault[];
  private readonly chunkBytes: number;

  constructor(options: MemoryStoreOptions) {
    for (const [key, content] of Object.entries(options.initialContents ?? {})) {
      this.storedContents.set(key, Uint8Array.from(content));
    }
    this.pendingFaults = pendingFaultsFrom(options.faults ?? []);
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  }

  async statBlob(key: string, options: TransferOptions = {}): Promise<StoredBlob | undefined> {
    await nextEventLoopTurn();
    this.recordCallAndFireDueFault('stat', key, options.signal);
    const content = this.storedContents.get(key);
    return content ? { key, bytes: content.length } : undefined;
  }

  async *readBlob(key: string, options: TransferOptions = {}): AsyncIterable<Uint8Array> {
    const truncation = this.recordReadAndTakeTruncation(key, options.signal);
    const content = this.storedContentOrNotFound(key);
    const streamedByteCount = truncation?.afterBytes ?? content.length;
    const chunks = sliceIntoChunks(content.subarray(0, streamedByteCount), this.chunkBytes);
    yield* streamChunksUntilCancelled(chunks, options.signal);
    if (truncation) throw injectedError(truncation);
  }

  async createBlobIfAbsent(
    upload: BlobUpload,
    options: TransferOptions = {},
  ): Promise<CreateOutcome> {
    this.recordCallAndFireDueFault('create', upload.key, options.signal);
    if (this.storedContents.has(upload.key)) return 'already-exists';
    const content = await collectUntilCancelled(upload.openBody(), options.signal);
    assertContentMatchesUpload(upload, content);
    // A concurrent writer may have created the key while this body was streaming.
    if (this.storedContents.has(upload.key)) return 'already-exists';
    this.storedContents.set(upload.key, content);
    return 'created';
  }

  private storedContentOrNotFound(key: string): Uint8Array {
    const content = this.storedContents.get(key);
    if (!content) throw new PipelineError('NOT_FOUND', 'Blob does not exist.', { key });
    return content;
  }

  private recordCall(operation: BlobOperation, key: string, signal: AbortSignal | undefined): void {
    this.calls.push({ operation, key });
    throwIfCancelled(signal);
  }

  private recordCallAndFireDueFault(
    operation: 'stat' | 'create',
    key: string,
    signal: AbortSignal | undefined,
  ): void {
    this.recordCall(operation, key, signal);
    const fault = this.takeDueFault(operation, key);
    if (fault) throw injectedError(fault);
  }

  /** A read fault without `afterBytes` fails at once; with it, the caller streams then fails. */
  private recordReadAndTakeTruncation(
    key: string,
    signal: AbortSignal | undefined,
  ): ({ readonly afterBytes: number } & InjectedFault) | undefined {
    this.recordCall('read', key, signal);
    const fault = this.takeDueFault('read', key);
    if (!fault) return undefined;
    if (fault.operation !== 'read' || fault.afterBytes === undefined) throw injectedError(fault);
    return { ...fault, afterBytes: fault.afterBytes };
  }

  private takeDueFault(operation: BlobOperation, key: string): InjectedFault | undefined {
    const pending = this.pendingFaults.find(
      ({ fault, remainingCalls }) =>
        remainingCalls > 0 && fault.operation === operation && fault.key === key,
    );
    if (pending) pending.remainingCalls -= 1;
    return pending?.fault;
  }
}

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  return new ScriptedMemoryStore(options);
}
