export { defaultConfig, SUPPORTED_SCHEMA_VERSIONS } from './config/pipeline-config.ts';
export type {
  AssetEntry,
  CategoryRule,
  ConfigIssue,
  CredentialEnvNames,
  MediaCategory,
  MediaProfile,
  OutputMode,
  PipelineConfig,
  ProfileRule,
  R2Settings,
  ReadTransport,
  ResizeBox,
  ResizeFit,
  ResourceLimits,
  SourceSelection,
  ConfigValidation,
  WebpEncoding,
} from './config/pipeline-config.ts';
export { validateConfig } from './config/validation.ts';
export { loadProjectConfig, resolveProjectPaths } from './config/project-config.ts';
export type { ProjectConfig, ProjectConfigLoad, ProjectPaths } from './config/project-config.ts';
export { isPortableRelativePath } from './paths/portable-path.ts';
export { loadCheckedProject } from './paths/layout/checked-project.ts';
export type { CheckedProject, CheckedProjectLoad } from './paths/layout/checked-project.ts';
export { inventorySources } from './catalog/inventory.ts';
export type { InventoryEntry, SourceInventory } from './catalog/inventory.ts';
export { catalogSources, derivedIdOf } from './catalog/asset-catalog.ts';
export type { CatalogedAsset, SourceCatalog } from './catalog/asset-catalog.ts';
export { isBlockingIssue } from './catalog/source-issues.ts';
export type { SourceIssue, SourceIssueCode } from './catalog/source-issues.ts';
export { hashFile } from './hash.ts';
export type { FileDigest } from './hash.ts';
export { PipelineError, toPipelineError } from './errors.ts';
export type { ErrorCode, ErrorDetails } from './errors.ts';
export {
  MIN_KNOWN_SECRET_LENGTH,
  NO_RESOLVED_SECRETS,
  redactSecrets,
  ResolvedSecrets,
} from './redaction.ts';
export { resolveR2Connection } from './storage/r2/r2-connection.ts';
export type {
  EnvironmentVariables,
  R2Access,
  R2Connection,
  RunEnvironment,
} from './storage/r2/r2-connection.ts';
export { createR2BlobReader, createR2BlobWriter } from './storage/r2/r2-blob-store.ts';
export { createPublicHttpBlobReader } from './storage/http/public-http-reader.ts';
export { encoderFingerprint } from './media/encoding/encoder-fingerprint.ts';
export type { EncoderFingerprint } from './media/encoding/encoder-fingerprint.ts';
export { derivativeKeyOf, normalizedPolicyOf } from './media/policies/transform-policy.ts';
export type {
  DerivativeInputs,
  ImagePolicy,
  ResizePolicy,
  SameFormatOutput,
  TransformPolicy,
  WebpOutput,
} from './media/policies/transform-policy.ts';
export { encodeImage } from './media/encoding/image-encoding.ts';
export type { EncodedImage, MediaNotice } from './media/encoding/image-encoding.ts';
export type { ImageFacts } from './media/encoding/image-probe.ts';
export type { MediaFailureReason } from './media/media-failures.ts';
export { profileSelectorFor } from './media/policies/profile-selection.ts';
export type { ProfileSource, SelectedProfile } from './media/policies/profile-selection.ts';
export { convertOriginal } from './media/original-conversion.ts';
export { assertConversionAllowed } from './media/policies/special-media.ts';
export type { MediaTypeAndRole } from './media/policies/special-media.ts';
export type {
  ConversionChoice,
  ConversionNotice,
  ConvertedOriginal,
  Dimensions,
  Original,
} from './media/original-conversion.ts';
export { previewPull, pullLockedOriginals } from './pull/pull-run.ts';
export type { PullPreview, PullRequest, PullResult } from './pull/pull-run.ts';
export type { CacheInspection, OriginalOutcome, OriginalStatus } from './pull/locked-originals.ts';
export type { SourceRestorePlan, SourceRestoreResult } from './pull/source-restore.ts';
export type { EntryState } from './cache/cache-files.ts';
export { transferSettingsFrom } from './storage/transfer/transfer-settings.ts';
export { pushStagedLock } from './push/push-run.ts';
export type { PushRequest, PushResult, StorageProgress } from './push/push-run.ts';
export { writeFinalizedLock } from './push/lock-writer.ts';
export { uploadAndVerify } from './push/source-upload.ts';
export type { ObjectSource, PushStorage, UploadedObject } from './push/source-upload.ts';
export { verifyByReadback } from './push/object-verification.ts';
export type { TransferSettings } from './storage/transfer/transfer-settings.ts';
export type { RedactionContext } from './redaction.ts';
export type {
  BlobReader,
  BlobUpload,
  BlobWriter,
  CreateOutcome,
  StoredBlob,
  TransferOptions,
} from './blob-store.ts';
export { createMemoryStore } from './memory-store.ts';
export type {
  BlobCall,
  BlobOperation,
  InjectedFault,
  MemoryStore,
  MemoryStoreOptions,
} from './memory-store.ts';
export {
  exitCodeOf,
  failedReport,
  renderReportAsJson,
  renderReportAsText,
  succeededReport,
} from './report.ts';
export type {
  FailureContext,
  OperationReport,
  ReportedError,
  ReportFacts,
  ReportIssue,
  ReportRecord,
  ReportValue,
} from './report.ts';
export { RUNTIME_MANIFEST_SCHEMA_VERSION } from './contracts.ts';
export type { ManifestAsset, RuntimeManifest } from './contracts.ts';
export { LOCK_SCHEMA_VERSION, lockDigest, objectKeyFor, stageLock } from './lock/source-lock.ts';
export type {
  LockNamespace,
  SourceLock,
  SourceRecord,
  SourceRecordField,
} from './lock/source-lock.ts';
export { validateLock } from './lock/lock-validation.ts';
export type { LockIssue, LockRules, LockValidation } from './lock/lock-validation.ts';
export { diffLocks } from './lock/lock-diff.ts';
export type { ChangedRecord, IdentityChange, LockDiff } from './lock/lock-diff.ts';
export { planUploads } from './lock/upload-plan.ts';
export { identityChangeNotices, sourcesMissingIssues } from './lock/change-checks.ts';
export type { PlannedObject, UploadPlan } from './lock/upload-plan.ts';
export { loadCommittedLock } from './lock/lock-file.ts';
export type { LockLoad } from './lock/lock-file.ts';
export { FinalizedLock } from './lock/lock-finalization.ts';
export type { VerifiedObject } from './lock/lock-finalization.ts';
export { planRemoteRetention } from './retention/cleanup-plan.ts';
export type {
  RemoteRetentionRequest,
  RemoteRetentionPlan,
  RetentionBlocker,
  RetentionObject,
  RetainedRelease,
} from './retention/types.ts';
export const TOOL_STATUS = 'starter' as const;
