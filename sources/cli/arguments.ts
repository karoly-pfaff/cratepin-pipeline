import {
  commandLabel,
  DEFAULT_CONFIG_FILE,
  findCommandSpec,
  FLAGS_WITH_VALUES,
  KNOWN_FLAGS,
  synopsisOf,
} from './command-specs.ts';
import type { CommandSpec, FlagName } from './command-specs.ts';
import { MAX_CONCURRENCY } from '../config/pipeline-config.ts';
import { PipelineError } from '../errors.ts';

export type OutputFormat = 'text' | 'json';
type FlagValues = Map<FlagName, string | true>;

/** How a command must behave; every flag the user gave ends up here or is rejected. */
interface RunPolicy {
  readonly configFile: string;
  readonly outputFormat: OutputFormat;
  readonly isDryRun: boolean;
  readonly isOffline: boolean;
  readonly concurrency: number | undefined;
  /** The user accepts that the new lock no longer lists some IDs. */
  readonly isRemovalConfirmed: boolean;
  /** Write locked sources missing from the source directory; existing files are never replaced. */
  readonly isRestoringSources: boolean;
}

export interface Invocation {
  /** The command as typed, including a subcommand (`cache prune`). */
  readonly command: string;
  readonly positionals: readonly string[];
  readonly policy: RunPolicy;
  readonly acceptedFlags: readonly FlagName[];
}

interface TokenReader {
  readonly spec: CommandSpec;
  readonly remainingTokens: string[];
  readonly flagValues: FlagValues;
  readonly positionals: string[];
}

const HELP_COMMANDS = ['help', '--help', '-h'];
const HELP_FLAGS = ['--help', '-h'];
const END_OF_OPTIONS = '--';

function failUsage(message: string): never {
  throw new PipelineError('USAGE', message);
}

/** Help is the first word (`--help`), or the only flag after a command (`hash --help`). */
export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.length === 0 || HELP_COMMANDS.includes(argv[0] ?? '') || isCommandHelpRequest(argv);
}

/** Exactly `<known command> --help` (or `-h`); anything else with --help is a usage error. */
function isCommandHelpRequest(argv: readonly string[]): boolean {
  const [command = '', flag = ''] = argv;
  return argv.length === 2 && findCommandSpec(command) !== undefined && HELP_FLAGS.includes(flag);
}

function isKnownFlag(name: string): name is FlagName {
  return (KNOWN_FLAGS as readonly string[]).includes(name);
}

function inlineFlagValue(name: FlagName, inlineValue: string): string {
  if (!FLAGS_WITH_VALUES.includes(name)) failUsage(`--${name} does not take a value`);
  if (inlineValue === '') failUsage(`--${name} requires a non-empty value`);
  return inlineValue;
}

/** The flag's value: `--name=value`, else the next token, which it removes from the reader. */
function takeFlagValue(
  name: FlagName,
  inlineValue: string | undefined,
  reader: TokenReader,
): string | true {
  if (inlineValue !== undefined) return inlineFlagValue(name, inlineValue);
  if (!FLAGS_WITH_VALUES.includes(name)) return true;
  const value = reader.remainingTokens.shift();
  if (value === undefined || value === '' || value.startsWith('-'))
    failUsage(`--${name} requires a value`);
  return value;
}

/** The flag named by `rawName` if this command accepts it and it was not given before. */
function acceptedFlagName(rawName: string, reader: TokenReader): FlagName {
  const name = rawName.slice(2);
  if (!rawName.startsWith('--') || !isKnownFlag(name)) failUsage(`Unknown option ${rawName}`);
  if (!reader.spec.flags.includes(name)) {
    failUsage(`${rawName} is not supported by ${commandLabel(reader.spec)}`);
  }
  if (reader.flagValues.has(name)) failUsage(`${rawName} was given more than once`);
  return name;
}

/** Records one flag, consuming its value token too when the value is not inline. */
function consumeFlag(token: string, reader: TokenReader): void {
  const [rawName = '', ...valueParts] = token.split('=');
  const name = acceptedFlagName(rawName, reader);
  const inlineValue = valueParts.length > 0 ? valueParts.join('=') : undefined;
  reader.flagValues.set(name, takeFlagValue(name, inlineValue, reader));
}

function consumeToken(token: string, reader: TokenReader): void {
  if (!token.startsWith('-')) reader.positionals.push(token);
  // After `--` every remaining token is an argument, even one that starts with a dash.
  else if (token === END_OF_OPTIONS) reader.positionals.push(...reader.remainingTokens.splice(0));
  else consumeFlag(token, reader);
}

function readTokens(spec: CommandSpec, tokens: readonly string[]): TokenReader {
  const reader: TokenReader = {
    spec,
    remainingTokens: [...tokens],
    flagValues: new Map(),
    positionals: [],
  };
  for (
    let token = reader.remainingTokens.shift();
    token !== undefined;
    token = reader.remainingTokens.shift()
  ) {
    consumeToken(token, reader);
  }
  return reader;
}

/** Positional arguments after the fixed subcommand word, which must match exactly. */
function argumentsAfterSubcommand(
  spec: CommandSpec,
  positionals: readonly string[],
): readonly string[] {
  if (spec.subcommand === undefined) return positionals;
  const [subcommand, ...rest] = positionals;
  if (subcommand !== spec.subcommand) failUsage(`${spec.name} expects: ${synopsisOf(spec)}`);
  return rest;
}

function parseConcurrencyFlag(flagValue: string | true | undefined): number | undefined {
  if (flagValue === undefined) return undefined;
  const concurrency =
    typeof flagValue === 'string' && /^\d+$/.test(flagValue) ? Number(flagValue) : 0;
  if (concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    failUsage(`--concurrency must be an integer 1–${String(MAX_CONCURRENCY)}`);
  }
  return concurrency;
}

function policyFrom(flagValues: FlagValues): RunPolicy {
  const configFile = flagValues.get('config');
  return {
    configFile: typeof configFile === 'string' ? configFile : DEFAULT_CONFIG_FILE,
    outputFormat: flagValues.has('json') ? 'json' : 'text',
    isDryRun: flagValues.has('dry-run'),
    isOffline: flagValues.has('offline'),
    concurrency: parseConcurrencyFlag(flagValues.get('concurrency')),
    isRemovalConfirmed: flagValues.has('confirm-removals'),
    isRestoringSources: flagValues.has('restore-sources'),
  };
}

/** Parses the whole command line before any file or network access; every mistake is USAGE. */
export function parseInvocation(argv: readonly string[]): Invocation {
  const [command = '', ...tokens] = argv;
  const spec = findCommandSpec(command);
  if (!spec) return failUsage(`Unknown command "${command}"; run "cratepin --help"`);
  const reader = readTokens(spec, tokens);
  const positionals = argumentsAfterSubcommand(spec, reader.positionals);
  if (positionals.length !== spec.positionals.length)
    failUsage(`${spec.name} expects: ${synopsisOf(spec)}`);
  return {
    command: commandLabel(spec),
    positionals,
    policy: policyFrom(reader.flagValues),
    acceptedFlags: spec.flags,
  };
}
