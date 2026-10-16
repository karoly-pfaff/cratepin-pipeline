# Source layout

Files under `sources/` use kebab-case. Keep `.test.ts` and `.test-support.ts` suffixes for
colocated unit tests and fixtures. The public API starts at `sources/index.ts`; the CLI starts
at `sources/cli/main.ts`. Other modules are internal unless explicitly exported by the API.

Larger areas have subdirectories named for their responsibilities:

| Area        | Groups                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `building/` | `planning/` inspects inputs and plans changes; `assembly/` prepares output trees; `publication/` commits staged builds. Run orchestration remains at the area's root.                                      |
| `cli/`      | `commands/` implements commands; `reports/` renders their results. Argument parsing, command definitions and shared execution remain at the area's root.                                                   |
| `config/`   | `rules/` contains field and relationship checks. Configuration reading, normalization and validation remain at the area's root.                                                                            |
| `media/`    | `encoding/` probes and encodes images; `policies/` selects and checks transforms; `testing/` holds semantic tests, fixtures and reviewed samples. Original conversion remains at the area's root.          |
| `output/`   | `layout/`, `ownership/`, `files/`, `manifest/`, `generation/` and `publication/` separate output paths, claims, file operations, manifests, generations and publication recovery.                          |
| `paths/`    | `layout/` validates project directories; `files/` provides bounded and checked file operations; `matching/` implements glob matching. Portable-path and containment checks remain at the area's root.      |
| `storage/`  | `r2/` implements R2 and request signing; `multipart/` uploads parts; `http/` handles HTTP reads; `transfer/` supplies bounded tasks, retries and cancellation; `testing/` holds shared transport fixtures. |

Smaller areas, including `cache/`, `catalog/`, `derivatives/`, `doctor/`, `json/`, `lock/`,
`pull/`, `push/`, `retention/` and `verify/`, remain flat. Shared contracts, errors, hashing and
stream primitives live at the source root. Add a subgroup when a clear responsibility emerges.

Tests tied to one module stay beside it. Tests spanning a media or transport area use that area's
`testing/` directory. Integration and end-to-end tests live under `tests/`, grouped by behavior;
shared process fixtures and preloads live under `tests/support/`.
