/**
 * Storage ports. Reading and writing are separate interfaces so build-side code can only ever
 * receive a reader (ADR-007). Every operation accepts an AbortSignal and streams its bytes.
 * Failures are rejected promises or stream errors carrying a PipelineError code.
 */

export interface TransferOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface StoredBlob {
  readonly key: string;
  readonly bytes: number;
}

export interface BlobReader {
  /** Size of the object at `key`, or `undefined` when it does not exist. */
  statBlob(key: string, options?: TransferOptions): Promise<StoredBlob | undefined>;
  /** Streams the object's content; fails with `NOT_FOUND` when it does not exist. */
  readBlob(key: string, options?: TransferOptions): AsyncIterable<Uint8Array>;
}

export interface BlobUpload {
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  /**
   * Opens a fresh, lazily started stream of the content. Writers may call it again to retry a
   * transient failure and may never call it when the key already exists.
   */
  readonly openBody: () => AsyncIterable<Uint8Array>;
}

/** `already-exists` means the key was present; the caller must still verify its content. */
export type CreateOutcome = 'created' | 'already-exists';

export interface BlobWriter {
  /**
   * Stores the upload only if `key` is absent and never overwrites an object that existed before
   * the call, nor one a racing writer created meanwhile; `already-exists` says nothing about the
   * stored bytes, so the result must be verified by readback. Fails with
   * `INTEGRITY_MISMATCH` when the streamed content differs from the declared `bytes`/`sha256`,
   * so a changed source can never be stored under its old hash.
   */
  createBlobIfAbsent(upload: BlobUpload, options?: TransferOptions): Promise<CreateOutcome>;
}
