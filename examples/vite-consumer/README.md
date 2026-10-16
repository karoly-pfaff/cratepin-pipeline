# Minimal Vite consumer

A host page that loads generated assets by logical ID. It shows the whole integration: the tool
is a dev dependency, `prebuild` runs it, and the page finds each file through the generated
manifest with Vite's base. Asset URLs resolve the same way at a domain root, under a subpath and
under Capacitor's `https://localhost` and `capacitor://localhost` origins (both only as a URL
resolution test so far, not in a Capacitor app). There is no bundler plugin.

## Files

| File                                             | Role                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| [cratepin.config.json](cratepin.config.json)     | Project namespace, profiles and asset metadata; the lock `push` writes is committed too                                          |
| [package.json](package.json)                     | `prebuild` builds and verifies the assets before `vite build`                                                                    |
| [vite.config.js](vite.config.js)                 | `base: './'`: no URL starts with a slash; Vite's bundles go to `dist/bundle/`, so `dist/assets/` is exactly the published output |
| [src/assetUrls.js](src/assetUrls.js)             | Loads `assets/cratepin-manifest.json` below the site base and maps IDs to URLs                                                   |
| [src/scenes/forest.json](src/scenes/forest.json) | Game data names assets by logical ID only; the tool never edits it                                                               |
| [src/main.js](src/main.js)                       | Resolves the scene's IDs and shows them                                                                                          |
| [ci/game-build.yml](ci/game-build.yml)           | GitHub Actions template: trusted builds read with a read-only token, forks build offline from the cache                          |

## Use

1. Install a pinned tool release as a dev dependency. This example uses a local tarball:
   `npm pack` in the tool repository gives `karoly-pfaff-cratepin-<version>.tgz`, which it expects
   in `vendor/`. Install Vite with it: `npm install`. To use the GitHub Packages release instead,
   follow the [installation guide](../../docs/recipes.md) and replace the file dependency with
   the pinned package version.
2. Author once: put the originals below `assets/source/` (for example
   `scenes/forest/backgrounds/meadow.png`, `scenes/forest/characters/fox.png` and
   `scenes/forest/voice/hu/find-the-fox.mp3`), set the R2 variables and run
   `npm run assets:push`. The config leaves `r2` at its defaults: `R2_ENDPOINT` (the account's
   S3 API endpoint) and `R2_BUCKET` for both, `R2_WRITE_ACCESS_KEY_ID` and
   `R2_WRITE_SECRET_ACCESS_KEY` for `push`, and `R2_READ_ACCESS_KEY_ID` and `R2_READ_SECRET_ACCESS_KEY` for a build on a cold
   cache (the tool's `.env.example` lists them). Commit `cratepin.config.json` and
   `cratepin-lock.json`.
3. Build: `npm run build`. `prebuild` gets every pinned original (read credentials only on a cold
   cache), publishes `public/assets/` and verifies it; Vite then copies `public/` into `dist/`.
   With a warm cache, `npm run assets:build:offline` needs no network or credential.

Push is an author action; neither `npm install` nor `npm run build` uploads anything.

## CI

Copy [ci/game-build.yml](ci/game-build.yml) to `.github/workflows/`. Its trusted job (pushes and
pull requests from this repository's branches) gets `R2_ENDPOINT`, `R2_BUCKET` and a read-only
token as repository secrets, builds and saves the cache. A fork's pull request gets no secret
(GitHub withholds them): it restores that cache and runs `assets:build:offline`. See
[CI](../../docs/integration.md#ci) for the rules behind it.

For the registry dependency, both install steps use the job's automatic read-only
`github.token`, with `packages: read` and scoped GitHub Packages configuration. The package
must be public or grant this consumer repository workflow access. A fork receives no PAT or
repository secrets; package authentication is confined to dependency installation, and asset
builds still run offline without R2 credentials. For a private package that forks cannot read,
use the checked local tarball alternative and make that tarball available in the checkout.

## Resolving URLs

Manifest URLs are relative to the site base (`assets/scenes/forest/backgrounds/meadow.webp`).
`siteBaseUrl(import.meta.env.BASE_URL, document.baseURI)` turns the base into an absolute URL and
every asset URL is resolved against it, never against the domain root. Look assets up by ID: a
profile may change the extension (here the fox always becomes WebP and the background usually
does), so a hardcoded `.png` path would break.

A relative base needs the page to be served from the directory that holds `index.html`, the
way a static host serves `https://example.com/games/forest/` or `.../forest/index.html`. Served as
`https://example.com/games/forest` without the slash, or at a deep route such as
`.../forest/level/2/` by a history-routing fallback, `./` points elsewhere and both Vite's bundle
and the manifest are missed. Redirect to the slash form, or give Vite an absolute `base` such as
`/games/forest/`: the helper works the same, but that build then only works at that one path, so
build Capacitor and other hosts separately with `./`.
