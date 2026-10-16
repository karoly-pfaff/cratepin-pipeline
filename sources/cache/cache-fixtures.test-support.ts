import { checkedProjectIn, sha256Of } from '../catalog/source-fixtures.test-support.ts';
import { PipelineError } from '../errors.ts';
import type { ErrorCode } from '../errors.ts';
import { objectKeyFor } from '../lock/source-lock.ts';
import type { SourceLock, SourceRecord } from '../lock/source-lock.ts';
import type { PlannedObject } from '../lock/upload-plan.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import type { CacheLayout } from './cache-layout.ts';
import { prepareCache } from './cache-root.ts';

const NAMESPACE = { objectPrefix: 'cratepin/v1', projectId: 'demo' };

/** The locked object of `content` in project demo. */
export function lockedObjectOf(content: string, ids: readonly string[] = []): PlannedObject {
  const sha256 = sha256Of(content);
  return {
    objectKey: objectKeyFor(NAMESPACE, sha256),
    sha256,
    bytes: Buffer.byteLength(content),
    ids,
  };
}

/** A lock of project demo pinning `sources` (path to content); IDs are the paths without `.png`. */
export function lockOf(sources: Readonly<Record<string, string>>): SourceLock {
  const assets = Object.entries(sources).map(([source, content]): SourceRecord => {
    const { objectKey, sha256, bytes } = lockedObjectOf(content);
    const id = source.replace(/\.png$/u, '');
    return { id, source, sha256, bytes, mediaType: 'image/png', category: 'image', objectKey };
  });
  return { schemaVersion: 1, projectId: 'demo', assets };
}

/** Initial store contents holding the bytes of every given content under its locked key. */
export function storedContentsOf(...contents: string[]): Record<string, Uint8Array> {
  return Object.fromEntries(
    contents.map((content) => [lockedObjectOf(content).objectKey, Buffer.from(content)]),
  );
}

/** Runs `useCache` with a preflighted project in a fresh workspace and its prepared cache. */
export async function withPreparedCache(
  useCache: (layout: CacheLayout, project: CheckedProject, workspace: string) => Promise<void>,
): Promise<void> {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    await useCache(await prepareCache(project), project, workspace);
  });
}

/** A predicate for `assert.rejects`: a PipelineError with `code`. */
export function failsWith(code: ErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof PipelineError && error.code === code;
}
