# Reports

Operation reports and redaction are implemented in `sources/report.ts` and
`sources/redaction.ts`, and exported from the public API. Failure codes and exit statuses
are defined in the [error contract](errors.md).

A command's outcome is one `OperationReport`: `command`, `status` (`succeeded` or `failed`), `facts`
(scalars, string lists or listings whose rows hold scalars or string lists), `issues` (`path`,
`code`, `message`) and, on failure, the `error` with its code, message, retryability, exit code and
details. A failed report can still carry facts, such as counts finished before the failure or
orphaned keys; a successful report can carry notices in `issues`, such as files with identical
bytes. The text rendering shows each listing row on its own line. `renderReportAsText` and
`renderReportAsJson` are two renderings of the same object, so human and machine output always carry
the same actionable state. `exitCodeOf` derives the exit code.

Both renderers require a `RedactionContext` holding the secret values this run resolved
(`NO_RESOLVED_SECRETS` when it resolved none), so redaction cannot be forgotten. Every string value
of the report is redacted before rendering (field names are chosen by code and kept, so they
cannot collide); JSON is serialized afterwards and
always parses. The text rendering shows control characters escaped, so a value can never forge
extra lines.

`redactSecrets` removes:

- `Authorization`, `Proxy-Authorization` and `x-amz-security-token` header values, also in
  JSON-quoted form;
- SigV4 `Credential=` and `Signature=` fields;
- signed URL parameters `X-Amz-Credential`, `X-Amz-Signature`, `X-Amz-Security-Token`, `token`,
  `signature` and `sig` (diagnostic ones such as `X-Amz-Expires` stay);
- user info in URLs, including passwords that contain `@`;
- values of credential-like environment variables (`*SECRET*`, `*PASSWORD*`, `*TOKEN*`,
  `*ACCESS_KEY*`) written as `NAME=value`, `NAME: value`, `NAME = value` or JSON, whatever the
  value looks like (even another variable name, which is harmless to hide);
- S3 signing details in error XML (`AWSAccessKeyId`, `SignatureProvided`, `StringToSign`,
  `CanonicalRequest`);
- unambiguous credential tokens (private key blocks, `AKIA…`/`ASIA…` keys, JWTs);
- the run's resolved secret values: anywhere when they have at least 8 characters, as whole
  words when shorter, so short values cannot shred ordinary text.

Hex strings are not redacted by shape, because SHA-256 digests are legitimate report content;
resolved R2 keys are covered as known values instead.
