import assert from 'node:assert/strict';
import test from 'node:test';

import * as publicApi from './index.ts';

/** The runtime surface consumers rely on; removing or renaming any of it is a breaking change. */
const PUBLIC_RUNTIME_EXPORTS = [
  'assertConversionAllowed',
  'catalogSources',
  'convertOriginal',
  'createMemoryStore',
  'createPublicHttpBlobReader',
  'createR2BlobReader',
  'createR2BlobWriter',
  'defaultConfig',
  'derivativeKeyOf',
  'derivedIdOf',
  'diffLocks',
  'encodeImage',
  'encoderFingerprint',
  'exitCodeOf',
  'FinalizedLock',
  'failedReport',
  'hashFile',
  'identityChangeNotices',
  'inventorySources',
  'isBlockingIssue',
  'isPortableRelativePath',
  'loadCheckedProject',
  'loadCommittedLock',
  'loadProjectConfig',
  'LOCK_SCHEMA_VERSION',
  'lockDigest',
  'MIN_KNOWN_SECRET_LENGTH',
  'NO_RESOLVED_SECRETS',
  'normalizedPolicyOf',
  'objectKeyFor',
  'planRemoteRetention',
  'planUploads',
  'profileSelectorFor',
  'previewPull',
  'pullLockedOriginals',
  'pushStagedLock',
  'PipelineError',
  'redactSecrets',
  'renderReportAsJson',
  'renderReportAsText',
  'RUNTIME_MANIFEST_SCHEMA_VERSION',
  'ResolvedSecrets',
  'resolveProjectPaths',
  'resolveR2Connection',
  'sourcesMissingIssues',
  'stageLock',
  'succeededReport',
  'SUPPORTED_SCHEMA_VERSIONS',
  'toPipelineError',
  'TOOL_STATUS',
  'transferSettingsFrom',
  'uploadAndVerify',
  'validateConfig',
  'validateLock',
  'verifyByReadback',
  'writeFinalizedLock',
];

test('the public API exports exactly the documented runtime names', () => {
  assert.deepEqual(new Set(Object.keys(publicApi)), new Set(PUBLIC_RUNTIME_EXPORTS));
  assert.equal(publicApi.TOOL_STATUS, 'starter');
});
