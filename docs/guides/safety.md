# Cache, paths and generated output safety

## Cache model

Each project owns its cache through cratepin-cache.json. The default is .cratepin-cache/;
nonempty unmarked directories and markers belonging to another project are refused. Sharing one
cache across projects or hosts is unsupported.

Originals are stored by raw SHA-256 under originals/sha256/. Every hit must be a regular file
with the locked hash and length. Downloads use private incoming/ partial files and publish
verified bytes without replacing an existing name. Corrupt entries are quarantined and fetched
again online; offline mode fails clearly. The filesystem must support hard links.

Derivative records bind output bytes to source hash, normalized policy and encoder fingerprint.
Changing any of these prevents reuse. A copy preserves every original byte. The cache is a
trusted local build boundary; protect write access and retain independent backups of originals.

Activity claims coordinate local pulls, builds and prune. cache prune --dry-run previews local
removals against the current lock; historical releases require isolated caches and independent
retention. Prune never deletes remote objects or author originals.

## Portable paths

Source, cache, lock and output paths must remain inside the project with the required separation.
Linked roots, escaping paths, unsafe Windows names and case-folded collisions are refused.
The output is a dedicated child directory, never the public root. Its parent must already exist.
See the complete [configuration path rules](../contracts/config.md).

## Public output ownership and transaction

build plans every output before publication. A nonempty unowned output directory is refused;
preserve it separately and follow the [output adoption procedure](../integration.md#adopting-an-existing-output-directory)
before granting the tool an empty output root.
Do not place hand-maintained files in a directory owned by the tool. The tool does not adopt
unrecognized markers or silently rewrite application content references.

### Path-preserving publication

The default mode assembles and validates a complete owned staging directory, then publishes it
through a recoverable directory swap. Existing URLs keep source paths unless an explicit profile
changes format. Resolve changed extensions through the generated manifest. An identical output
is left untouched. Failed or interrupted transactions retain enough state for recovery on a
later build; do not manually remove their markers or work directories.

Files held open on Windows may prevent directory replacement. Close readers and retry after
OUTPUT_IN_USE; use generation mode when consumers need to read during publication.

### Generation publication

outputMode: generation writes immutable generation files, validates the complete generation,
then switches cratepin-manifest.json in one step. Manifest URLs identify that generation.
The output root stays in place; the current and previous generation are kept during normal
cleanup. Unknown root entries are preserved and reported rather than served. An open manifest
can prevent its replacement on Windows; the old manifest remains published.

Neither output mode is a durable release archive. Keep released locks, toolchain and originals
as described in [backup and rollback](../operations.md). Run cratepin verify after building and
before packaging; it audits the published output against the lock without re-encoding or network.
