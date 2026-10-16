import { findProfile } from '../../config/pipeline-config.ts';
import type { PipelineConfig } from '../../config/pipeline-config.ts';
import type { SourceRecord } from '../../lock/source-lock.ts';
import { compileGlob } from '../../paths/matching/glob-matcher.ts';
import { mediaFailure } from '../media-failures.ts';
import { normalizedPolicyOf } from './transform-policy.ts';
import type { TransformPolicy } from './transform-policy.ts';

/** Where a profile choice came from: the asset's own entry, a profile rule, or the default. */
export type ProfileSource = 'asset' | 'rule' | 'default';

export interface SelectedProfile {
  readonly name: string;
  readonly from: ProfileSource;
  readonly policy: TransformPolicy;
}

type LockedSource = Pick<SourceRecord, 'source' | 'profile'>;

const UNKNOWN_PROFILE_REMEDIES: Readonly<Record<ProfileSource, string>> = {
  asset: 'the lock pins it from an assets entry; define it, or change the entry and push again',
  rule: 'a profile rule names it; define it or fix the rule',
  default: 'defaultProfile names it; define it or change defaultProfile',
};

interface ChosenName {
  readonly name: string;
  readonly from: ProfileSource;
}

function definedPolicy(
  config: PipelineConfig,
  { name, from }: ChosenName,
  source: string,
): TransformPolicy {
  const profile = findProfile(config, name);
  if (profile !== undefined) return normalizedPolicyOf(profile);
  throw mediaFailure(
    'PROFILE_UNKNOWN',
    `Profile "${name}" for ${source} is not defined in the config: ${UNKNOWN_PROFILE_REMEDIES[from]}.`,
    { profile: name, from, source },
  );
}

/**
 * Chooses profiles for one config, its rules compiled once: a source's profile is the one its
 * `assets` entry names (pinned in the lock), else that of the first matching profile rule
 * (matched ignoring letter case, like the include patterns), else the default profile. A name
 * the config does not define is refused, never replaced by another profile.
 */
export function profileSelectorFor(
  config: PipelineConfig,
): (record: LockedSource) => SelectedProfile {
  const rules = config.profileRules.map(({ match, profile }) => ({
    matches: compileGlob(match),
    profile,
  }));
  return (record) => {
    const chosen = chosenName(
      config,
      record,
      rules.find(({ matches }) => matches(record.source)),
    );
    return { ...chosen, policy: definedPolicy(config, chosen, record.source) };
  };
}

function chosenName(
  config: PipelineConfig,
  record: LockedSource,
  rule: { readonly profile: string } | undefined,
): ChosenName {
  if (record.profile !== undefined) return { name: record.profile, from: 'asset' };
  if (rule !== undefined) return { name: rule.profile, from: 'rule' };
  return { name: config.defaultProfile, from: 'default' };
}
