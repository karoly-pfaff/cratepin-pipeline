import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { defaultConfig } from './pipeline-config.ts';
import type { PipelineConfig } from './pipeline-config.ts';
import { validateConfig } from './validation.ts';

const MINIMAL_CONFIG = { schemaVersion: 1, projectId: 'demo-game' };
const R2_ACCESS_KEY_ID_SHAPE = '0123456789abcdef0123456789abcdef';
const EXAMPLE_CONFIG_URL = new URL('../../examples/cratepin.config.json', import.meta.url);

type CorpusEntry = readonly [name: string, config: unknown, expectedIssuePaths: readonly string[]];

/** Spellings no path field may take: absolute, UNC, drive, backslash-separated or with a NUL. */
const HOSTILE_PATHS: readonly (readonly [shape: string, path: string])[] = [
  ['absolute', '/srv/assets'],
  ['UNC', '//server/share/assets'],
  ['Windows absolute', 'C:\\assets'],
  ['backslash', 'assets\\source'],
  ['NUL', 'assets/so\u0000urce'],
];

/** Each path field of the config: a config holding `path` there, and the issue it must get. */
const PATH_FIELDS: readonly (readonly [
  field: string,
  configWith: (path: string) => object,
  issuePath: string,
])[] = [
  ...['sourceDir', 'cacheDir', 'lockFile', 'outputDir', 'objectPrefix'].map(
    (key) => [key, (path: string) => ({ ...MINIMAL_CONFIG, [key]: path }), `/${key}`] as const,
  ),
  [
    'asset source',
    (path) => ({ ...MINIMAL_CONFIG, assets: [{ source: path }] }),
    '/assets/0/source',
  ],
  [
    'include pattern',
    (path) => ({ ...MINIMAL_CONFIG, sources: { include: [path] } }),
    '/sources/include/0',
  ],
];

const HOSTILE_PATH_CORPUS: readonly CorpusEntry[] = PATH_FIELDS.flatMap(
  ([field, configWith, issuePath]) =>
    HOSTILE_PATHS.map(
      ([shape, path]) => [`${shape} ${field}`, configWith(path), [issuePath]] as const,
    ),
);

/** Each entry: a config that must fail, and exactly the issue paths it must report. */
const INVALID_CONFIG_CORPUS: readonly CorpusEntry[] = [
  ['not an object', [], ['/']],
  ['missing project', { schemaVersion: 1 }, ['/projectId']],
  ['future schema', { ...MINIMAL_CONFIG, schemaVersion: 2 }, ['/schemaVersion']],
  ['unknown top-level field', { ...MINIMAL_CONFIG, images: {} }, ['/images']],
  ['traversal', { ...MINIMAL_CONFIG, sourceDir: '../other' }, ['/sourceDir']],
  ['windows drive', { ...MINIMAL_CONFIG, cacheDir: 'C:/cache' }, ['/cacheDir']],
  [
    'source in the build work directory',
    { ...MINIMAL_CONFIG, sourceDir: 'public/.assets.cratepin' },
    ['/sourceDir'],
  ],
  [
    'case variant of the build work directory',
    { ...MINIMAL_CONFIG, sourceDir: 'public/.ASSETS.cratepin' },
    ['/sourceDir'],
  ],
  [
    'cache in the build staging',
    { ...MINIMAL_CONFIG, cacheDir: 'public/.assets.cratepin/staging/c' },
    ['/cacheDir'],
  ],
  [
    "output in a sibling root's work directory",
    { ...MINIMAL_CONFIG, outputDir: 'public/.assets.Cratepin/staging' },
    ['/outputDir'],
  ],
  [
    "source in another root's work directory",
    { ...MINIMAL_CONFIG, sourceDir: 'public/.other.cratepin/source' },
    ['/sourceDir'],
  ],
  [
    'output named like a work directory',
    { ...MINIMAL_CONFIG, outputDir: 'public/.Assets.cratepin' },
    ['/outputDir'],
  ],
  [
    'lock in the build work directory',
    { ...MINIMAL_CONFIG, lockFile: 'public/.assets.cratepin/cratepin-lock.json' },
    ['/lockFile'],
  ],
  ['public root output', { ...MINIMAL_CONFIG, outputDir: 'apps/game/public' }, ['/outputDir']],
  ['null is not absent', { ...MINIMAL_CONFIG, outputMode: null }, ['/outputMode']],
  ['zero concurrency', { ...MINIMAL_CONFIG, limits: { concurrency: 0 } }, ['/limits/concurrency']],
  ['empty include', { ...MINIMAL_CONFIG, sources: { include: [] } }, ['/sources/include']],
  [
    'glob escapes root',
    { ...MINIMAL_CONFIG, sources: { include: ['../**'] } },
    ['/sources/include/0'],
  ],
  [
    'unknown category',
    { ...MINIMAL_CONFIG, sources: { categories: [{ match: '**', category: 'video' }] } },
    ['/sources/categories/0/category'],
  ],
  [
    'plain http read',
    {
      ...MINIMAL_CONFIG,
      r2: { read: { transport: 'public-http', publicBaseUrl: 'http://x.example/' } },
    },
    ['/r2/read/publicBaseUrl'],
  ],
  [
    'unknown transport',
    { ...MINIMAL_CONFIG, r2: { read: { transport: 'ftp' } } },
    ['/r2/read/transport'],
  ],
  [
    'incomplete writer',
    { ...MINIMAL_CONFIG, r2: { writer: { accessKeyIdEnv: 'W_ID' } } },
    ['/r2/writer/secretAccessKeyEnv'],
  ],
  [
    'image profile without work',
    { ...MINIMAL_CONFIG, profiles: { thumb: { kind: 'image' } } },
    ['/profiles/thumb'],
  ],
  [
    'copy redefined',
    { ...MINIMAL_CONFIG, profiles: { copy: { kind: 'copy' } } },
    ['/profiles/copy'],
  ],
  [
    'unknown profile kind',
    { ...MINIMAL_CONFIG, profiles: { clip: { kind: 'video' } } },
    ['/profiles/clip/kind'],
  ],
  ['profile not an object', { ...MINIMAL_CONFIG, profiles: { clip: 'copy' } }, ['/profiles/clip']],
  [
    'copy profile with options',
    { ...MINIMAL_CONFIG, profiles: { raw: { kind: 'copy', quality: 90 } } },
    ['/profiles/raw/quality'],
  ],
  [
    'resize out of range',
    {
      ...MINIMAL_CONFIG,
      profiles: { big: { kind: 'image', resize: { width: 0, height: 99999 } } },
    },
    ['/profiles/big/resize/width', '/profiles/big/resize/height'],
  ],
  [
    'webp quality range',
    { ...MINIMAL_CONFIG, profiles: { bg: { kind: 'image', webp: { quality: 0 } } } },
    ['/profiles/bg/webp/quality'],
  ],
  [
    'unknown profile reference',
    { ...MINIMAL_CONFIG, profileRules: [{ match: '**/*.png', profile: 'missing' }] },
    ['/profileRules/0/profile'],
  ],
  [
    'unknown default profile',
    { ...MINIMAL_CONFIG, defaultProfile: 'missing' },
    ['/defaultProfile'],
  ],
  [
    'shared read and write keys',
    {
      ...MINIMAL_CONFIG,
      r2: {
        read: {
          transport: 's3-readonly',
          accessKeyIdEnv: 'R2_WRITE_ACCESS_KEY_ID',
          secretAccessKeyEnv: 'R2_READ_SECRET',
        },
      },
    },
    ['/r2/read/accessKeyIdEnv'],
  ],
  [
    'one variable for id and secret',
    {
      ...MINIMAL_CONFIG,
      r2: { writer: { accessKeyIdEnv: 'R2_KEY', secretAccessKeyEnv: 'R2_KEY' } },
    },
    ['/r2/writer/secretAccessKeyEnv'],
  ],
  [
    'bucket variable reused as a credential',
    {
      ...MINIMAL_CONFIG,
      r2: { writer: { accessKeyIdEnv: 'R2_BUCKET', secretAccessKeyEnv: 'W_SECRET' } },
    },
    ['/r2/writer/accessKeyIdEnv'],
  ],
  [
    'read id equal to writer secret',
    {
      ...MINIMAL_CONFIG,
      r2: {
        read: {
          transport: 's3-readonly',
          accessKeyIdEnv: 'R2_WRITE_SECRET_ACCESS_KEY',
          secretAccessKeyEnv: 'R2_READ_SECRET',
        },
      },
    },
    ['/r2/read/accessKeyIdEnv'],
  ],
  ['8.3 short name alias', { ...MINIMAL_CONFIG, cacheDir: 'GENERA~1' }, ['/cacheDir']],
  [
    'output inside .git',
    { ...MINIMAL_CONFIG, outputDir: '.git/assets', outputUrlPath: 'assets' },
    ['/outputDir'],
  ],
  [
    'source inside node_modules',
    { ...MINIMAL_CONFIG, sourceDir: 'Node_Modules/pkg' },
    ['/sourceDir'],
  ],
  ['lock path containing a root', { ...MINIMAL_CONFIG, lockFile: 'assets' }, ['/lockFile']],
  ['public root in another case', { ...MINIMAL_CONFIG, outputDir: 'apps/Public' }, ['/outputDir']],
  ['Windows device name', { ...MINIMAL_CONFIG, lockFile: 'nul.json' }, ['/lockFile']],
  ['trailing dot alias', { ...MINIMAL_CONFIG, sourceDir: 'assets.' }, ['/sourceDir']],
  [
    'output equals source',
    { ...MINIMAL_CONFIG, outputDir: 'assets/source', outputUrlPath: 'assets' },
    ['/outputDir'],
  ],
  [
    'output contains source',
    { ...MINIMAL_CONFIG, outputDir: 'assets', outputUrlPath: 'assets' },
    ['/outputDir'],
  ],
  ['cache equals output', { ...MINIMAL_CONFIG, cacheDir: 'public/assets' }, ['/outputDir']],
  [
    'lock inside cache',
    { ...MINIMAL_CONFIG, lockFile: '.cratepin-cache/lock.json' },
    ['/lockFile'],
  ],
  [
    'brace glob escaping the root',
    { ...MINIMAL_CONFIG, sources: { include: ['{..,x}/**/*.png'] } },
    ['/sources/include/0'],
  ],
  [
    'negated glob',
    { ...MINIMAL_CONFIG, profileRules: [{ match: '!**/*.png', profile: 'copy' }] },
    ['/profileRules/0/match'],
  ],
  ['assets not a list', { ...MINIMAL_CONFIG, assets: {} }, ['/assets']],
  [
    'image and size limits out of range',
    { ...MINIMAL_CONFIG, limits: { imageConcurrency: 17, maxSourceBytes: 0, maxImagePixels: 1.5 } },
    ['/limits/imageConcurrency', '/limits/maxSourceBytes', '/limits/maxImagePixels'],
  ],
  [
    'image concurrency not a positive integer',
    { ...MINIMAL_CONFIG, limits: { imageConcurrency: 'two' } },
    ['/limits/imageConcurrency'],
  ],
  [
    'image concurrency zero',
    { ...MINIMAL_CONFIG, limits: { imageConcurrency: 0 } },
    ['/limits/imageConcurrency'],
  ],
  [
    'transfer limits out of range',
    {
      ...MINIMAL_CONFIG,
      limits: {
        multipartThresholdBytes: 1024,
        multipartPartBytes: 6 * 1024 * 1024 * 1024,
        transferAttempts: 0,
        requestTimeoutSeconds: 301,
      },
    },
    [
      '/limits/multipartThresholdBytes',
      '/limits/multipartPartBytes',
      '/limits/transferAttempts',
      '/limits/requestTimeoutSeconds',
    ],
  ],
  [
    'largest original needs too many parts',
    {
      ...MINIMAL_CONFIG,
      limits: { maxSourceBytes: 10_001 * 5 * 1024 * 1024, multipartPartBytes: 5 * 1024 * 1024 },
    },
    ['/limits/multipartPartBytes'],
  ],
  [
    'licence with an invisible line separator or bidi override, decomposed id',
    {
      ...MINIMAL_CONFIG,
      assets: [
        { source: 'a.png', licence: 'MIT\u2028second line' },
        { source: 'b.png', licence: 'MIT \u202eTIM' },
        { source: 'c.png', id: 'cafe\u0301' },
      ],
    },
    ['/assets/0/licence', '/assets/1/licence', '/assets/2/id'],
  ],
  [
    'reversed class range',
    { ...MINIMAL_CONFIG, sources: { include: ['**/[b-a].png'] } },
    ['/sources/include/0'],
  ],
  [
    'asset entry without source and with an unknown field',
    { ...MINIMAL_CONFIG, assets: [{ id: 'hero', label: 'Hero' }] },
    ['/assets/0/label', '/assets/0/source'],
  ],
  [
    'asset source that is a glob or leaves the source root',
    { ...MINIMAL_CONFIG, assets: [{ source: 'images/*.png' }, { source: '../cat.png' }] },
    ['/assets/0/source', '/assets/1/source'],
  ],
  [
    'malformed asset metadata',
    {
      ...MINIMAL_CONFIG,
      assets: [
        {
          source: 'a.png',
          id: '/hero',
          category: 'video',
          locale: 'english',
          role: 'Actor',
          licence: 'line' + String.fromCharCode(10) + 'break',
        },
      ],
    },
    [
      '/assets/0/id',
      '/assets/0/category',
      '/assets/0/locale',
      '/assets/0/role',
      '/assets/0/licence',
    ],
  ],
  [
    'two entries for one source and one ID for two sources, ignoring letter case',
    {
      ...MINIMAL_CONFIG,
      assets: [
        { source: 'images/Cat.png', id: 'hero' },
        { source: 'images/cat.png', locale: 'en' },
        { source: 'images/dog.png', id: 'HERO' },
      ],
    },
    ['/assets/1/source', '/assets/2/id'],
  ],
  [
    'unknown asset profile',
    { ...MINIMAL_CONFIG, assets: [{ source: 'a.png', profile: 'missing' }] },
    ['/assets/0/profile'],
  ],
  ...HOSTILE_PATH_CORPUS,
];

function issuePathsOf(config: unknown): readonly string[] {
  const validation = validateConfig(config);
  return validation.ok ? [] : validation.issues.map((issue) => issue.path);
}

function validConfigOf(raw: unknown): PipelineConfig {
  const validation = validateConfig(raw);
  if (!validation.ok)
    throw new Error(`expected a valid config: ${JSON.stringify(validation.issues)}`);
  return validation.config;
}

test('the default, minimal and example configs validate', async () => {
  assert.equal(validConfigOf(defaultConfig()).projectId, 'example-game');
  assert.equal(validConfigOf(MINIMAL_CONFIG).projectId, 'demo-game');
  const example = validConfigOf(JSON.parse(await readFile(EXAMPLE_CONFIG_URL, 'utf8')));
  assert.equal(example.r2.read.transport, 'public-http');
});

test('the invalid config corpus reports exactly the expected issue paths', () => {
  for (const [name, config, expectedPaths] of INVALID_CONFIG_CORPUS) {
    assert.deepEqual(issuePathsOf(config), expectedPaths, name);
  }
});

test('omitted fields get defaults while explicit zero and false are kept', () => {
  const config = validConfigOf({
    ...MINIMAL_CONFIG,
    profiles: {
      bg: { kind: 'image', webp: { lossless: false, alphaQuality: 0, keepSmaller: false } },
    },
  });
  const profile = config.profiles.bg;
  assert.ok(profile?.kind === 'image');
  assert.deepEqual(profile.webp, {
    lossless: false,
    quality: 80,
    alphaQuality: 0,
    keepSmaller: false,
  });
  assert.equal(config.outputDir, 'public/assets');
  assert.equal(config.outputMode, 'path-preserving');
  assert.deepEqual(config.limits, defaultConfig().limits);
  assert.equal(config.r2.read.transport, 's3-readonly');
});

test('an empty webp block is lossless and flexible by default', () => {
  const config = validConfigOf({
    ...MINIMAL_CONFIG,
    profiles: { artwork: { kind: 'image', webp: {} } },
  });
  const profile = config.profiles.artwork;
  assert.ok(profile?.kind === 'image');
  assert.deepEqual(profile.webp, {
    lossless: true,
    quality: 80,
    alphaQuality: 100,
    keepSmaller: true,
  });
});

test('credential-shaped values are rejected without echoing them', () => {
  const secretValues = [
    R2_ACCESS_KEY_ID_SHAPE,
    'AKIAIOSFODNN7EXAMPLE',
    'https://user:secret@assets.example.com/',
    'https://assets.example.com/?X-Amz-Signature=abc',
  ];
  for (const secret of secretValues) {
    const validation = validateConfig({ ...MINIMAL_CONFIG, r2: { bucketEnv: secret } });
    assert.ok(!validation.ok, secret);
    const isSecretIssue = validation.issues.some(
      (issue) => issue.code === 'CONFIG_SECRET' && issue.path === '/r2/bucketEnv',
    );
    assert.ok(isSecretIssue, secret);
    assert.ok(!JSON.stringify(validation.issues).includes(secret));
  }
});

test('a credential-shaped field name is reported but never echoed', () => {
  const validation = validateConfig({ ...MINIMAL_CONFIG, [R2_ACCESS_KEY_ID_SHAPE]: 'x' });
  assert.ok(!validation.ok);
  assert.ok(!JSON.stringify(validation.issues).includes(R2_ACCESS_KEY_ID_SHAPE));
});

test('validation never aliases the caller object', () => {
  const include = ['**/*.png'];
  const config = validConfigOf({ ...MINIMAL_CONFIG, sources: { include } });
  include.push('**/*.wav');
  assert.deepEqual(config.sources.include, ['**/*.png']);
});

test('credential shapes are found in nested arrays, inside longer strings and in profile names', () => {
  const hiddenSecrets = [
    { ...MINIMAL_CONFIG, sources: { include: ['**/*.png', R2_ACCESS_KEY_ID_SHAPE] } },
    { ...MINIMAL_CONFIG, objectPrefix: `prefix/${R2_ACCESS_KEY_ID_SHAPE}` },
    { ...MINIMAL_CONFIG, profiles: { [R2_ACCESS_KEY_ID_SHAPE]: { kind: 'copy', extra: 1 } } },
  ];
  for (const config of hiddenSecrets) {
    const validation = validateConfig(config);
    assert.ok(!validation.ok);
    assert.ok(validation.issues.some((issue) => issue.code === 'CONFIG_SECRET'));
    assert.ok(!JSON.stringify(validation.issues).includes(R2_ACCESS_KEY_ID_SHAPE));
  }
});

test('a public R2 bucket host is not mistaken for a key, but a key in a path still is', () => {
  const publicHost = 'https://pub-0123456789abcdef0123456789abcdef.r2.dev/';
  const withPublicHost = {
    ...MINIMAL_CONFIG,
    r2: { read: { transport: 'public-http', publicBaseUrl: publicHost } },
  };
  assert.equal(validConfigOf(withPublicHost).r2.read.transport, 'public-http');
  const keyInPath = `https://cdn.example/${R2_ACCESS_KEY_ID_SHAPE}/`;
  const withKeyInPath = {
    ...MINIMAL_CONFIG,
    r2: { read: { transport: 'public-http', publicBaseUrl: keyInPath } },
  };
  assert.deepEqual(issuePathsOf(withKeyInPath), ['/r2/read/publicBaseUrl']);
  assert.deepEqual(
    issuePathsOf({ ...MINIMAL_CONFIG, objectPrefix: `p_${R2_ACCESS_KEY_ID_SHAPE}` }),
    ['/objectPrefix'],
  );
});

test('only the standard public R2 host is exempt; a key in any other host or key name is caught', () => {
  const withKeyInHost = {
    ...MINIMAL_CONFIG,
    r2: {
      read: {
        transport: 'public-http',
        publicBaseUrl: `https://${R2_ACCESS_KEY_ID_SHAPE}.example/`,
      },
    },
  };
  assert.deepEqual(issuePathsOf(withKeyInHost), ['/r2/read/publicBaseUrl']);
  const urlShapedKey = validateConfig({ ...MINIMAL_CONFIG, [`x://${R2_ACCESS_KEY_ID_SHAPE}`]: 1 });
  assert.ok(!urlShapedKey.ok);
  assert.ok(!JSON.stringify(urlShapedKey.issues).includes(R2_ACCESS_KEY_ID_SHAPE));
});

test('a public base URL may use plain http only towards a loopback test server', () => {
  for (const publicBaseUrl of [
    'http://127.0.0.1:9000/public',
    'http://localhost/',
    'http://[::1]/',
  ]) {
    const config = { ...MINIMAL_CONFIG, r2: { read: { transport: 'public-http', publicBaseUrl } } };
    assert.equal(validConfigOf(config).r2.read.transport, 'public-http', publicBaseUrl);
  }
  const remote = { transport: 'public-http', publicBaseUrl: 'http://127.0.0.1.example/' };
  assert.deepEqual(issuePathsOf({ ...MINIMAL_CONFIG, r2: { read: remote } }), [
    '/r2/read/publicBaseUrl',
  ]);
});

test('the output URL path follows outputDir after its last "public" segment unless given', () => {
  const derived = [
    ['public/assets', 'assets'],
    ['apps/game/public/assets', 'assets'],
    ['web/Public/media/gen', 'media/gen'],
    ['public/assets/public/sounds', 'sounds'],
  ];
  for (const [outputDir, outputUrlPath] of derived) {
    assert.equal(validConfigOf({ ...MINIMAL_CONFIG, outputDir }).outputUrlPath, outputUrlPath);
  }
  const given = validConfigOf({ ...MINIMAL_CONFIG, outputDir: 'www/gen', outputUrlPath: '' });
  assert.equal(given.outputUrlPath, '', 'an empty path serves outputDir at the public root');
});

test('without a "public" segment the URL path must be given, never guessed', () => {
  const validation = validateConfig({ ...MINIMAL_CONFIG, outputDir: 'www/media/gen' });
  assert.ok(!validation.ok);
  assert.deepEqual(
    validation.issues.map((issue) => issue.path),
    ['/outputUrlPath'],
  );
});

test('a derived URL path follows the same rule as a given one, never encoded silently', () => {
  for (const outputDir of ['public/my assets', 'public/#media', 'public/médiák']) {
    const validation = validateConfig({ ...MINIMAL_CONFIG, outputDir });
    assert.ok(!validation.ok, outputDir);
    assert.deepEqual(
      validation.issues.map((issue) => issue.path),
      ['/outputUrlPath'],
      outputDir,
    );
  }
  const given = validConfigOf({
    ...MINIMAL_CONFIG,
    outputDir: 'public/my assets',
    outputUrlPath: 'media',
  });
  assert.equal(given.outputUrlPath, 'media');
});

test('the output URL path is a plain relative URL path', () => {
  for (const outputUrlPath of [
    '/assets',
    'assets/',
    'a//b',
    '..',
    'a/./b',
    'a?b',
    'a#b',
    'a b',
    'ä',
  ]) {
    const validation = validateConfig({ ...MINIMAL_CONFIG, outputUrlPath });
    assert.ok(!validation.ok, outputUrlPath);
    assert.deepEqual(
      validation.issues.map((issue) => issue.path),
      ['/outputUrlPath'],
      outputUrlPath,
    );
  }
});
