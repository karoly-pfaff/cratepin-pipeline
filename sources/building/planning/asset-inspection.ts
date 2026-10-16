import { findCachedConversion } from '../../derivatives/cached-conversion.ts';
import type { ImagePolicy } from '../../media/policies/transform-policy.ts';
import type { ReportIssue } from '../../report.ts';
import {
  builtAssetOf,
  conversionRequestOf,
  copiedOutput,
  issueOrRethrow,
  withoutBytes,
} from '../assembly/asset-outputs.ts';
import type { AssetBuilding, BuiltAsset } from '../assembly/asset-outputs.ts';
import type { PlannedAsset } from './build-plan.ts';

/**
 * What a build would do with one asset, found without writing anything: its output is already
 * `known` (a copy, or a derivative it would reuse), it `wouldConvert`, or it has an `issue`.
 */
export type AssetInspection =
  | { readonly known: BuiltAsset }
  | { readonly wouldConvert: PlannedAsset }
  | { readonly issue: ReportIssue };

/** The outputs a dry run already knows: copies and derivatives it would reuse. */
export function knownOutputsOf(outputs: readonly AssetInspection[]): BuiltAsset[] {
  return outputs.flatMap((output) => ('known' in output ? [output.known] : []));
}

/** The issues of assets a build would refuse. */
export function refusalsOf(outputs: readonly AssetInspection[]): ReportIssue[] {
  return outputs.flatMap((output) => ('issue' in output ? [output.issue] : []));
}

async function inspectedImage(
  building: AssetBuilding,
  asset: PlannedAsset,
  policy: ImagePolicy,
): Promise<AssetInspection> {
  const found = await building.imageGate(async () =>
    findCachedConversion(await conversionRequestOf(building, asset.record, policy), policy),
  );
  if (found === undefined) return { wouldConvert: asset };
  return { known: builtAssetOf(asset, withoutBytes(found)) };
}

/**
 * What a build would make of one asset whose original is a verified cache entry, without
 * converting or writing: a copy and a reusable derivative are known outputs, anything else would
 * be converted, and an asset its role or the limits refuse becomes its issue.
 */
export async function inspectAssetOutput(
  building: AssetBuilding,
  asset: PlannedAsset,
): Promise<AssetInspection> {
  const { record, profile } = asset;
  if (profile.policy.kind === 'copy') {
    return { known: builtAssetOf(asset, copiedOutput(building.layout, record)) };
  }
  try {
    return await inspectedImage(building, asset, profile.policy);
  } catch (error) {
    return { issue: issueOrRethrow(record, error) };
  }
}
