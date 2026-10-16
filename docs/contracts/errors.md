# Errors

The error model is implemented in `sources/errors.ts` and exported from the public API.
Operation outcomes and their rendered output follow the [report contract](reports.md).

## Error codes

Library failures are `PipelineError`s with a stable `code`, a user-facing `message` and scalar
`details` (key, path, counts). Codes are part of the public contract; their meaning never changes
once released. The CLI reports every failure, including usage errors, through this model.

| Code                 | Meaning                                                                                    | Retryable | Exit |
| -------------------- | ------------------------------------------------------------------------------------------ | --------- | ---: |
| `IO_FAILED`          | Local operation failed for another reason; raw details suppressed                          | no        |    1 |
| `CONFIG_INVALID`     | Configuration, required environment variables, or an endpoint or public URL that redirects | no        |    2 |
| `NOT_IMPLEMENTED`    | Command is planned but not available yet                                                   | no        |    3 |
| `USAGE`              | Unknown command, flag or argument; nothing was read or written                             | no        |    4 |
| `AUTH_FAILED`        | Storage rejected the credentials or permissions                                            | no        |    5 |
| `TRANSIENT_TRANSFER` | Network or service failure that may succeed when retried                                   | yes       |    6 |
| `INTEGRITY_MISMATCH` | Bytes differ from the expected SHA-256 or length                                           | no        |    7 |
| `INVALID_DATA`       | Input data (lock, manifest, media) is malformed or unsupported                             | no        |    8 |
| `OUTPUT_CONFLICT`    | Target already exists, is not owned, or is locked by someone else                          | no        |    9 |
| `NOT_FOUND`          | A required file or stored object does not exist                                            | no        |   10 |
| `CANCELLED`          | The operation was cancelled through its AbortSignal                                        | no        |  130 |

The `issues` in [operation reports](reports.md) carry their own code families: `CONFIG_INVALID`/`CONFIG_SECRET` for the
configuration ([config](config.md)), the source inventory and catalog codes such as
`UNSUPPORTED_MEDIA` or `MISSING_SOURCE`, `LOCK_INVALID`/`LOCK_UNSUPPORTED` for the committed
lock ([data](data.md)), the pull codes such as `OBJECT_MISSING` or `CACHE_MISS`
([pull](data.md#verified-cache-and-pull); `doctor` reports a corrupt cache entry as `CACHE_CORRUPT` too), the prune notices such as `UNKNOWN_CACHE_NAME`
([prune](data.md#cache-prune)), and the build codes such as `OUTPUT_NOT_OWNED`,
`OUTPUT_PATH_COLLISION` or `EXTENSION_CHANGED` ([build dry run](data.md#build-dry-run)). An operation with blocking source or lock issues fails with
`INVALID_DATA` (exit 8); an invalid configuration with `CONFIG_INVALID` (exit 2).

Exit codes 0–3 kept their earlier meaning when the full model was introduced. Only
`TRANSIENT_TRANSFER` may be retried automatically; authentication, integrity and validation
failures are never retried blindly. A missing credential environment variable is
`CONFIG_INVALID` and names only the variable; no report shows a variable's value, also when a
key is rejected (`AUTH_FAILED`) or the cache misses while credentials are set. An offline build
or pull with a cold cache is `NOT_FOUND` and lists every missing identifier and hash.

`toPipelineError` is the fallback converter for anything thrown; transport adapters classify
HTTP statuses themselves first. A `PipelineError` passes unchanged, also when `fetch` wraps it as
the `cause` of its own error (an upload body that refused a changed source). It never copies the
original message, which can contain paths or credentials:

- `AbortError` becomes `CANCELLED`; `TimeoutError` (from `AbortSignal.timeout`) becomes
  `TRANSIENT_TRANSFER`;
- `ENOENT` becomes `NOT_FOUND`; `EEXIST`, `ENOTEMPTY` and `EBUSY` become `OUTPUT_CONFLICT`;
  `EISDIR` (a directory where a file was expected) becomes `INVALID_DATA`;
- network codes (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`, `ENOTFOUND`,
  undici socket and timeout codes) become `TRANSIENT_TRANSFER`, also when they are the `cause`
  of a `fetch failed` error. `ENOTFOUND` can also mean a misconfigured endpoint, which is why
  every retry loop has a bounded budget;
- everything else becomes `IO_FAILED` with only the system error code as a detail. `EPERM` is
  deliberately `IO_FAILED` here; code that renames owned output classifies a rename blocked by
  an open file (`EPERM`, `EACCES`, `EBUSY`) as `OUTPUT_CONFLICT` itself.
