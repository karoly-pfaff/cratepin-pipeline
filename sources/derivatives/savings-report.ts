import { compareCodeUnits } from '../catalog/ordering.ts';
import type { CachedConversion, DerivativeUse } from './cached-conversion.ts';

/** One converted asset, with the names a report shows for it. */
export interface ConvertedAsset {
  readonly id: string;
  readonly source: string;
  readonly profile: string;
  /** How the output was made; its bytes are not needed. */
  readonly conversion: Omit<CachedConversion, 'bytes'>;
}

/** What one asset became, as measured; `savedBytes` is zero or negative when nothing was saved. */
interface AssetSavings {
  readonly id: string;
  readonly source: string;
  readonly profile: string;
  readonly choice: CachedConversion['choice'];
  readonly mediaType: string;
  readonly sourceBytes: number;
  readonly outputBytes: number;
  readonly savedBytes: number;
  /** The output's and the original's size in pixels; absent for a copy, which is never decoded. */
  readonly width?: number;
  readonly height?: number;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly derivativeUse: DerivativeUse;
  /** The codes of the conversion's notices, such as `SIZE_GREW`. */
  readonly notices: readonly string[];
}

interface SavingsTotals {
  readonly assetCount: number;
  readonly sourceBytes: number;
  readonly outputBytes: number;
  /** Total source minus total output bytes: zero or negative too, never a percentage target. */
  readonly savedBytes: number;
  /** Assets whose output is larger than their original. */
  readonly grewCount: number;
  readonly derivativeUses: Readonly<Record<DerivativeUse, number>>;
}

export interface SavingsReport {
  readonly assets: readonly AssetSavings[];
  readonly totals: SavingsTotals;
}

function savingsOf({ id, source, profile, conversion }: ConvertedAsset): AssetSavings {
  const { choice, mediaType, sourceBytes, outputBytes, savedBytes } = conversion;
  const { dimensions, sourceDimensions } = conversion;
  return {
    id,
    source,
    profile,
    choice,
    mediaType,
    sourceBytes,
    outputBytes,
    savedBytes,
    ...(dimensions ?? {}),
    ...(sourceDimensions === undefined
      ? {}
      : { sourceWidth: sourceDimensions.width, sourceHeight: sourceDimensions.height }),
    derivativeUse: conversion.derivativeUse,
    notices: conversion.notices.map((notice) => notice.code),
  };
}

function totalOf(assets: readonly AssetSavings[], field: 'sourceBytes' | 'outputBytes'): number {
  return assets.reduce((total, asset) => total + asset[field], 0);
}

function usesOf(assets: readonly AssetSavings[]): Record<DerivativeUse, number> {
  const uses: Record<DerivativeUse, number> = { copied: 0, reused: 0, made: 0, remade: 0 };
  for (const asset of assets) uses[asset.derivativeUse] += 1;
  return uses;
}

/**
 * The real sizes of every converted asset, by logical ID, and their totals, all as measured:
 * savings may be zero or negative and are reported as such.
 */
export function savingsReportOf(converted: readonly ConvertedAsset[]): SavingsReport {
  const assets = converted
    .map(savingsOf)
    .toSorted((left, right) => compareCodeUnits(left.id, right.id));
  const sourceBytes = totalOf(assets, 'sourceBytes');
  const outputBytes = totalOf(assets, 'outputBytes');
  return {
    assets,
    totals: {
      assetCount: assets.length,
      sourceBytes,
      outputBytes,
      savedBytes: sourceBytes - outputBytes,
      grewCount: assets.filter((asset) => asset.savedBytes < 0).length,
      derivativeUses: usesOf(assets),
    },
  };
}
