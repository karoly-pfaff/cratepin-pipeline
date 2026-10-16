import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failPackageCheck, runNpmAndRequireSuccess } from './package-process.mjs';
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ALLOWED_PACKED_PATHS = [
  /^(build\/.+\.(js|d\.ts)|package\.json|README\.md|LICENSE)$/,
  /^docs\/(?:contracts\/|contribution\/|guides\/)?[a-z0-9-]+\.md$/i,
  /^examples\/cratepin\.config\.json$/,
  /^examples\/vite-consumer\/(README\.md|cratepin\.config\.json|index\.html|package\.json|vite\.config\.js)$/,
  /^examples\/vite-consumer\/(ci\/game-build\.yml|public\/favicon\.svg)$/,
  /^examples\/vite-consumer\/src\/(assetUrls\.js|main\.js|scenes\/forest\.json)$/,
];
const TEST_FILE = /\.test(-support)?\.(js|d\.ts)$/;
const REQUIRED_PACKED_PATHS = [
  'build/cli/main.js',
  'build/index.js',
  'build/index.d.ts',
  'LICENSE',
  'docs/third-party-notices.md',
  'docs/README.md',
  'docs/recipes.md',
  'examples/vite-consumer/README.md',
];

export function packCheckedTarball(packDirectory) {
  const packArguments = ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory];
  const { stdout } = runNpmAndRequireSuccess(packArguments, { cwd: REPOSITORY_ROOT });
  const [packedPackage] = JSON.parse(stdout);
  assertPackedPathsAllowed(packedPackage.files.map((entry) => entry.path));
  return {
    filename: packedPackage.filename,
    version: packedPackage.version,
    integrity: packedPackage.integrity,
    tarballPath: join(packDirectory, packedPackage.filename),
    packedPaths: packedPackage.files.map((packedFile) => packedFile.path),
  };
}

function assertPackedPathsAllowed(packedPaths) {
  const forbidden = packedPaths.filter(
    (path) => !ALLOWED_PACKED_PATHS.some((pattern) => pattern.test(path)) || TEST_FILE.test(path),
  );
  if (forbidden.length > 0) failPackageCheck(`unexpected packed files: ${forbidden}`);
  const missing = REQUIRED_PACKED_PATHS.filter((path) => !packedPaths.includes(path));
  if (missing.length > 0) failPackageCheck(`missing packed files: ${missing}`);
}
