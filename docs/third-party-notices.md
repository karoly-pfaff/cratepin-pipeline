# Third-party notices

Cratepin's source is [MIT licensed](../LICENSE). This licence does not cover third-party
dependencies or consumer media.

The only direct runtime dependency is [Sharp](https://sharp.pixelplumbing.com/) 0.35.5
(Apache-2.0). npm installs Sharp and its platform dependencies separately; Cratepin's npm
tarball does not bundle their code or native binaries. Exact dependencies are pinned in the
source repository's `package-lock.json`.

Sharp's supporting packages and native libraries have their own licences, including
libvips under LGPL-3.0-or-later. See [Sharp's installation documentation](https://sharp.pixelplumbing.com/install/)
and the licence files included with the installed packages.

When redistributing dependencies, preserve applicable upstream copyright, licence and notice
files and fulfil the relevant licence requirements. Bundling native binaries also requires
reviewing the source and relinking obligations for that exact bundle and distribution method;
Cratepin's MIT licence does not replace those obligations.
