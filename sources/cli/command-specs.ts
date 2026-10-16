export type FlagName =
  | 'config'
  | 'json'
  | 'dry-run'
  | 'offline'
  | 'concurrency'
  | 'confirm-removals'
  | 'restore-sources';

export const DEFAULT_CONFIG_FILE = 'cratepin.config.json';
export const FLAGS_WITH_VALUES: readonly FlagName[] = ['config', 'concurrency'];
export const KNOWN_FLAGS: readonly FlagName[] = [
  'config',
  'json',
  'dry-run',
  'offline',
  'concurrency',
  'confirm-removals',
  'restore-sources',
];

/** What a command accepts. A subcommand is a fixed word (`cache prune`), not a free argument. */
export interface CommandSpec {
  readonly name: string;
  readonly subcommand?: string;
  readonly flags: readonly FlagName[];
  readonly positionals: readonly string[];
  readonly isImplemented: boolean;
}

const PLANNED_TRANSFER_FLAGS: readonly FlagName[] = ['config', 'json', 'dry-run', 'concurrency'];
const CLEANUP_FLAGS: readonly FlagName[] = ['config', 'json', 'dry-run'];

const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: 'init', flags: ['config', 'dry-run', 'json'], positionals: [], isImplemented: true },
  { name: 'validate', flags: ['config', 'json'], positionals: [], isImplemented: true },
  { name: 'hash', flags: ['json'], positionals: ['file'], isImplemented: true },
  { name: 'scan', flags: ['config', 'json'], positionals: [], isImplemented: true },
  {
    name: 'push',
    flags: [...PLANNED_TRANSFER_FLAGS, 'confirm-removals'],
    positionals: [],
    isImplemented: true,
  },
  {
    name: 'pull',
    flags: [...PLANNED_TRANSFER_FLAGS, 'offline', 'restore-sources'],
    positionals: [],
    isImplemented: true,
  },
  {
    name: 'build',
    flags: [...PLANNED_TRANSFER_FLAGS, 'offline'],
    positionals: [],
    isImplemented: true,
  },
  { name: 'verify', flags: ['config', 'json'], positionals: [], isImplemented: true },
  { name: 'doctor', flags: ['config', 'json', 'offline'], positionals: [], isImplemented: true },
  {
    name: 'cache',
    subcommand: 'prune',
    flags: CLEANUP_FLAGS,
    positionals: [],
    isImplemented: true,
  },
  {
    name: 'remote',
    subcommand: 'gc',
    flags: CLEANUP_FLAGS,
    positionals: [],
    isImplemented: false,
  },
];

export function findCommandSpec(name: string): CommandSpec | undefined {
  return COMMAND_SPECS.find((spec) => spec.name === name);
}

/** The command as the user types it, including a subcommand: `build`, `cache prune`. */
export function commandLabel(spec: CommandSpec): string {
  return spec.subcommand === undefined ? spec.name : `${spec.name} ${spec.subcommand}`;
}

export function synopsisOf(spec: CommandSpec): string {
  const positionals = spec.positionals.map((name) => `<${name}>`);
  const flags = spec.flags.map((flag) =>
    FLAGS_WITH_VALUES.includes(flag) ? `[--${flag} <value>]` : `[--${flag}]`,
  );
  return [commandLabel(spec), ...positionals, ...flags].join(' ');
}

export function helpText(): string {
  const implemented = COMMAND_SPECS.filter((spec) => spec.isImplemented).map(
    (spec) => `  ${synopsisOf(spec)}`,
  );
  const planned = COMMAND_SPECS.filter((spec) => !spec.isImplemented).map(commandLabel);
  return [
    'Cratepin',
    'Implemented:',
    ...implemented,
    `Planned: ${planned.join(', ')}`,
    `--config defaults to ${DEFAULT_CONFIG_FILE}; paths inside it resolve from its directory.`,
    'Use -- to end options, e.g. "hash -- -file.png".',
  ].join('\n');
}
