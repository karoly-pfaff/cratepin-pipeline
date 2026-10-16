# Storage ports

The storage contracts are implemented in `sources/blob-store.ts`, `sources/byte-streams.ts` and
`sources/memory-store.ts`, and exported from the public API. Storage failures use the
[error contract](errors.md).

Build-side code receives only a `BlobReader`; only author commands receive a `BlobWriter`
([read credentials](../guides/r2.md#credentials)).

- `statBlob(key, { signal })` resolves to `{ key, bytes }` or `undefined` when absent.
- `readBlob(key, { signal })` streams the object as `Uint8Array` chunks and fails with
  `NOT_FOUND` when absent. Callers verify SHA-256 and length themselves; the port never claims
  integrity.
- `createBlobIfAbsent({ key, bytes, sha256, openBody }, { signal })` stores the content only if the
  key is absent and resolves to `created` or `already-exists`. It never overwrites an object that
  existed before the call; the in-memory store, the R2 single PUT and the R2 multipart completion
  (`If-None-Match: *`) also refuse a racing writer. `already-exists` proves nothing about the
  stored bytes, which is why every upload is verified by readback. `openBody` returns a fresh, lazily started stream each time, so a
  writer can retry a transient failure; it may not be called at all when the key exists. The writer
  fails with `INTEGRITY_MISMATCH` when the streamed content differs from the declared length or
  hash. `already-exists` is not proof of identical content; callers verify.

Every operation honours its `AbortSignal`, also while a body is stalled, and reports cancellation as
`CANCELLED`; abort listeners are removed when the operation ends, so one run-level signal can serve
any number of transfers. A cancelled body is asked to close; an async generator stalled inside an
`await` closes only once that await settles. Failures are always rejected promises or stream errors,
never synchronous throws.

`createMemoryStore` is a deterministic in-memory implementation for tests. It records every
call, streams copies in configurable chunk sizes, stores copies of seeded and uploaded content,
rejects uploads whose content differs from the declaration, and replays scripted faults: the
next `times` calls of an operation on a key fail with a chosen code, and only a read fault may
set `afterBytes` to stream that many bytes first and simulate a truncated transfer.
