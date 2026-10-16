# Backup, retention and release rollback

A committed lock preserves references, not original bytes. Content-addressed keys prevent an
ordinary push from replacing a different original; they cannot recover an object removed by a
bucket administrator or lifecycle rule. Keep an independently recoverable copy of released
inputs and exercise restoration before relying on it.

## Retain a complete release

For every supported release, retain these together under a durable release identifier:

- A reachable Git tag/commit with the exact source lock, configuration, profiles, host mapping
  and package-manager lock. Preserve old tags/branches or an independent repository bundle;
  an unreachable commit or a developer's working copy is not the release catalogue.
- The exact tool tarball and its SHA-256, the dependency lock and cached dependency tarballs
  for the required OS/architecture, plus the exact Node/npm and native encoder fingerprint.
  An npm development dependency or an unpinned registry range is not an archived toolchain.
- Every original named by the lock, identified by project/object key, raw SHA-256 and byte
  count. Verify bytes while copying to an independent backup location. A manifest, ETag,
  object metadata or a list of object names cannot substitute for the bytes.
- Build instructions, the generation/manifest digest and a full output inventory. Preserve
  the packaged application too when immediate deployment rollback matters; rebuilding needs
  all of the above and may take longer than restoring an already approved distributable.
- Licence/attribution records and restore access instructions. Secrets belong in separately
  managed credentials, never in the archive's Git config, runtime output or public report.

Keep copies under a separate failure/administration boundary from the live bucket, with a
named owner and an explicit retention period covering every supported release and rollback
window. Choose that period and backup frequency for the project's requirements. Test that a
second authorized operator can restore the archive; a copy never read back is unverified.

## Remote and local retention are separate

The tool never deletes remote originals. `remote gc` remains unavailable. The
[retention design](retention.md) defines the read-only planning API and future
administrative requirements. If remote cleanup
is designed later, its roots must include **all** retained release locks/projects, not merely
the current checkout. Do not expire a released hash while any retained lock references it.

Cloudflare's [S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/) lists
bucket versioning APIs as unimplemented (checked 2026-10-16); do not assume S3 version restore
exists. [Bucket lock rules](https://developers.cloudflare.com/r2/buckets/bucket-locks/) can
prevent deletion for a retention interval, but are not an independent backup. Review
[lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) separately:
expiration can remove originals. [Emptying a bucket](https://developers.cloudflare.com/r2/buckets/delete-buckets/)
permanently removes its objects. This guide changes no bucket rule or remote object.

`cache prune` considers one current source lock. With shared caches or historical releases,
it may delete local originals/derivatives still needed elsewhere; retain the independent backup
and use isolated release caches. A warm cache is useful restoration input only after every
original is hash/size checked. Derivatives are a trusted local build boundary, not an archival
authority. Rebuilding from verified originals with an empty derivative cache checks the encoder.

Generation publication keeps the current and previous generation during ordinary cleanup;
that short window is not a release archive. Path-preserving publication also removes its
transaction backup after success. Neither output mode promises indefinite rollback storage.

## Rebuild or roll back without latest content

1. Stop builds/pulls/prunes targeting the output being recovered. Prefer a fresh isolated
   checkout and a separate cache/output root; preserve the running application until the
   recovered build is verified. Never wipe a host's public root or author source directory.
2. Select the retained release explicitly. Restore its config, profiles, logical mapping,
   source lock, package lock, tool tarball and platform dependencies. Check the tarball checksum
   before installing it with scripts disabled. Match the archived encoder fingerprint.
3. Initialize the isolated project's cache with the pinned CLI's `pull --offline --json`.
   For a cold cache, the expected result is `NOT_FOUND` (exit 10) with `CACHE_MISS` hashes;
   stop on other errors before copying anything. This creates the project's cache marker and
   [original-entry directories](contracts/data.md#verified-cache-and-pull) without remote access.
   Verify every backup original against the release lock's raw SHA-256 and byte count, then
   copy those bytes to `<cacheDir>/originals/sha256/<sha256>`, with no active claims. Restore
   originals only, with no old marker or derivative records. Preserve the archive as read-only input. If a
   referenced original is absent everywhere, report the exact missing hash; latest content or
   a local author's edited file cannot reconstruct it.
4. Ensure the host-owned output parent (for example `public/`) exists; the tool creates its
   dedicated output child, not a missing host parent. Run the pinned tool's
   `pull --offline --json`, `build --offline --json` and `verify --json`
   through the installed local CLI. Use the checked [invocation recipes](recipes.md). No writer
   credential or remote listing is needed. A cold miss fails explicitly; corrupt backup bytes
   are refused, not blessed as cache hits. `--restore-sources` is unnecessary for rebuilding;
   when explicitly requested, it writes missing files only and preserves existing edits.
5. Compare the recovered generation, manifest and full file hashes with the archived release,
   then run the host's packaging/runtime checks. Only promote that verified application through
   the host's normal release process. If encoder/platform inputs differ, obtain new compatibility
   evidence instead of claiming a byte-identical recovery.

Rebuilding an older lock through a newer tool is a compatibility experiment, not a pinned
rollback. Switching only a generation manifest by hand also leaves the lock/config inconsistent;
rebuild the selected release with its own inputs or deploy the archived application package.
