import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const STRUCTURAL_SIZE_RULES = ['max-lines', 'max-lines-per-function', 'max-statements'];

export default tseslint.config(
  // Local plans/evidence are private context, separate from executable repository sources.
  { ignores: ['build/', 'coverage/', 'node_modules/', '.remember/', '.local/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // --- Structure and complexity (deliberately stricter than game-hangman) ---
      'max-lines': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true }],
      'max-statements': ['error', 8],
      complexity: ['error', 6],
      'sonarjs/cognitive-complexity': ['error', 8],
      'max-depth': ['error', 2],
      'max-params': ['error', 3],
      'max-nested-callbacks': ['error', 2],
      'no-nested-ternary': 'error',
      'no-else-return': ['error', { allowElseIf: false }],

      // --- Understandability: names must say what things are ---
      'id-length': ['error', { min: 2, exceptions: ['_'], properties: 'never' }],
      'id-denylist': [
        'error',
        ...['data', 'info', 'obj', 'val', 'tmp', 'temp', 'foo', 'bar', 'stuff', 'thing'],
        ...['handle', 'manager', 'util', 'utils', 'helper', 'helpers', 'doStuff'],
      ],
      // A named alias such as `ExitCode = number` states what a primitive means; that is the point.
      'sonarjs/redundant-type-aliases': 'off',

      // --- Correctness and clarity ---
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'no-console': 'error',
      'no-param-reassign': ['error', { props: true }],

      // --- TypeScript ---
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Repository scripts, tests and this config are plain JavaScript outside tsconfig.
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { '@typescript-eslint/explicit-module-boundary-types': 'off' },
  },
  {
    // The example host's page code runs in a browser.
    files: ['examples/**/src/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    // The CLI entry point and repository scripts report to the terminal by design.
    files: ['sources/cli/main.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    // Representative test setup may be long; complexity, depth and correctness rules still apply.
    files: ['**/*.test.ts', '**/*.test-support.ts', '**/*.test.mjs'],
    rules: Object.fromEntries(STRUCTURAL_SIZE_RULES.map((rule) => [rule, 'off'])),
  },
  {
    // node:test registers tests synchronously; the promises it returns are awaited by the runner.
    files: ['**/*.test.ts', '**/*.test-support.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', name: ['test', 'suite'], package: 'node:test' },
          ],
        },
      ],
    },
  },
  prettier,
);
