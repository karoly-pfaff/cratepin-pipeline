# Read-only remote retention API

`remote gc` still exits with `NOT_IMPLEMENTED`; push, pull, build and cache prune never run
remote cleanup. The public `planRemoteRetention` API is a pure, synchronous dry-run planner.
It accepts administrator-supplied snapshots, performs no I/O, obtains no credentials and has no
delete port. `ready` means these supplied snapshots are internally consistent. It grants no
authority to delete and does not establish that a caller's completeness or backup assertion is
true. A remote executor is deliberately deferred.

## Retained releases and catalogue backups

Inventory every project and every release still eligible for rollback, including older
tool/config namespaces, deployment branches and supported installed clients. Git's current
branch alone cannot establish retention. Keep an append-only catalogue of immutable release
identifiers, config/namespace snapshots, committed source locks and their SHA-256/byte counts.
Removing a release requires an explicit retirement decision after its support/rollback period.
An empty project still needs its validated empty release lock so its namespace is explicit.
A namespace absent from this catalogue is unknown, even under the same bucket prefix.

Before cleanup, archive that complete catalogue, its locks/configs and every referenced original
to a separately administered location. Verify raw original SHA-256 and byte counts against the
locks, record the backup reference, and rehearse recovery with the pinned older tool as in the
[recovery guide](operations.md). ETags, replication under the same deletion authority and an
untested backup index are insufficient. Retain archived locks after retiring a release;
catalogue history must explain when its originals stopped being retention roots. No catalogue
uploader or backup writer is introduced by the planner.

## Snapshot and plan contract

Import `planRemoteRetention` and its `RemoteRetentionRequest`, `RemoteRetentionPlan`,
`RetainedRelease` and `RetentionObject` types from `@karoly-pfaff/cratepin`. This is a typed API,
not an untrusted-JSON parser. Each release's `lock` is accepted as `unknown` and validated by
the existing strict lock rules; namespace configuration must also validate.

Supply `releases` with an immutable `reference`, historical `namespace` and parsed `lock`;
`objects` with canonical `key`, integer `bytes` and `lastModifiedMs`; `capturedAtMs`, `nowMs`
and positive integer `gracePeriodSeconds`. The administrative assertions are
`isInventoryComplete`, `isReleaseCatalogComplete`, `hasVerifiedIndependentBackup` and a
nonblank `backupReference`. Missing assertions block the whole plan. These are caller claims,
not remote evidence verified by this library.

Freeze source uploads, release publication and retirement before collecting the inventory.
Include all listing pages for every retained namespace, with exactly one entry per object.
Do not filter unknown keys out to manufacture a complete inventory. Unknown projects,
non-source keys and malformed keys block this planner; an administrator must account for them
explicitly before any deletion. There is no same-prefix ownership inference.

Reachability is the union of all validated release locks. Shared hashes and old-only references
stay retained. Missing referenced inventory keys or conflicting byte counts between locks and
inventory block every candidate. Inventory size is not content-integrity proof; independently
verified backups remain required.

The plan returns `schemaVersion: 1`, `isReadOnly: true`, `status`, stable `blockers`, sorted
`candidates` with key/bytes/last-modified time, `candidateBytes`, `referencedCount` and
`graceRetainedCount`. Candidate count is `candidates.length`. Candidate entries are copied;
the request is unchanged. Any blocker returns an empty candidate list and zero bytes.

Only unreferenced objects whose age at **capture** is at least the grace period qualify.
Waiting before planning cannot promote a younger object. Times must be safe nonnegative integer
milliseconds; object modification cannot follow capture, and capture cannot follow now.
Snapshots older than 24 hours block; grace is 1–31,536,000 seconds. Limits are 100,000 inventory
objects, 1,024 releases and 100,000 total lock records, checked before lock validation.
Aggregate byte totals must remain safe integers. Larger estates require a separately designed
bounded snapshot store, not silently truncated input.

Remote deletion is unavailable. A plan is advisory and provides no deletion authority, backup verification or protection against concurrent remote changes.
