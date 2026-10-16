import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packCheckedTarball } from './package-tarball.mjs';
import { checkExternalPackageConsumer } from './package-consumer.mjs';
const workDirectory = await mkdtemp(join(tmpdir(), 'cratepin-package-'));
try {
  const { tarballPath, packedPaths } = packCheckedTarball(workDirectory);
  await checkExternalPackageConsumer(workDirectory, tarballPath);
  console.log(
    `Package check passes: ${packedPaths.length} packed files, external CLI/API/types work.`,
  );
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
