# Cratepin

![Version: 1.0.0-beta.1](https://img.shields.io/badge/version-1.0.0--beta.1-orange)

Pinned originals, verified media builds and offline release recovery. Cratepin stores originals
in R2, verifies a local cache and builds an owned public asset directory from a committed source
lock. Applications use generated files without R2 access or credentials.

Repository name: `cratepin-pipeline`.

The package is `@karoly-pfaff/cratepin`, the CLI is `cratepin`, and the source is
[MIT licensed](LICENSE). [Third-party notices](docs/third-party-notices.md) cover dependencies.
Node 24 is required; developer hosts are Windows and Linux, including WSL.
This is a beta release. The npm package registry is [GitHub Packages](https://npm.pkg.github.com/).

Support development through [GitHub Sponsors](https://github.com/sponsors/karoly-pfaff).

Start with the [installation and CLI/API recipes](docs/recipes.md), then the
[Vite consumer example](examples/vite-consumer/README.md). Configuration lives in
`cratepin.config.json`, the source lock in `cratepin-lock.json`, and the default cache in
`.cratepin-cache/`. Commit configuration and locks; keep originals, cache and generated output
outside Git.

Available commands include `init`, `validate`, `hash`, `scan`, verified R2 `push` and `pull`,
`cache prune`, `build`, `verify` and `doctor`. Warm-cache `build --offline` uses no network or
credentials. Builds preserve original files and publish generated assets through recoverable
owned-output transactions. PNG and opt-in WebP profiles are supported; audio is copied unchanged.

The public `planRemoteRetention` API produces a read-only advisory plan. Remote deletion and
`remote gc` are unavailable. See the [documentation index](docs/README.md) and
[CLI reference](docs/contracts/cli.md).
