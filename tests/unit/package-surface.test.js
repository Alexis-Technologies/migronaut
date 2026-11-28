const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const readRepoFile = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');
const packageJson = JSON.parse(readRepoFile('package.json'));

/** Source text with comments removed — the docs legitimately quote what the code must not do */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The hand-written declaration files, one per entry point */
const DECLARATION_FILES = ['index.d.ts', 'bullmq.d.ts', 'versioning.d.ts'];

/** Every `.js` file under `dir`, repo-relative — the tree the "nothing in src may…" rules walk */
const sourceFiles = (dir) => {
  const files = [];
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(relative));
    else if (entry.name.endsWith('.js')) files.push(relative);
  }
  return files;
};

describe('package entry point', () => {
  it('should expose the public surface through the package root', () => {
    // Nothing else in the suite requires the entry point, so a broken barrel
    // would otherwise ship green.
    const api = require(path.join(repoRoot, 'index.js'));
    assert.strictEqual(typeof api.MigratorKit, 'function');
    assert.strictEqual(typeof api.runMigrations, 'function');
    assert.strictEqual(typeof api.pendingMigrations, 'function');
  });

  it('should export every error class the type surface declares', () => {
    const api = require(path.join(repoRoot, 'index.js'));
    const declared = [...readRepoFile('index.d.ts').matchAll(/^export class (\w+)/gm)].map(
      (match) => match[1],
    );
    assert.ok(declared.length > 10, 'expected the declaration file to list error classes');
    for (const name of declared) {
      assert.strictEqual(typeof api[name], 'function', `${name} is declared but not exported`);
    }
  });

  it('should not export anything the type surface does not declare', () => {
    const api = require(path.join(repoRoot, 'index.js'));
    const dts = readRepoFile('index.d.ts');
    for (const name of Object.keys(api)) {
      assert.ok(
        dts.includes(`export class ${name}`) ||
          dts.includes(`export function ${name}`) ||
          dts.includes(`export const ${name}`),
        `${name} is exported at runtime but missing from index.d.ts`,
      );
    }
  });

  it('should map every error code (and only real codes) to a CLI exit code', () => {
    // The superset half: an error class added without an EXIT_CODES entry
    // silently collapses to exit 1, which is exactly the drift this pins.
    const api = require(path.join(repoRoot, 'index.js'));
    const errors = require(path.join(repoRoot, 'src', 'errors', 'index.js'));
    const codes = new Set();
    for (const [name, ErrorClass] of Object.entries(errors)) {
      if (name === 'MigronautError' || typeof ErrorClass !== 'function') continue;
      const instance = new ErrorClass('probe');
      codes.add(instance.code);
    }
    assert.ok(codes.size >= 22, 'expected every error subclass to carry a code');
    for (const code of codes) {
      assert.strictEqual(
        typeof api.EXIT_CODES[code],
        'number',
        `error code ${code} has no EXIT_CODES entry`,
      );
    }
    // The other direction: EXIT_CODES may add CLI-condition codes, but never
    // a typo'd error code.
    const cliOnly = new Set([
      'ALX_ERR_PENDING_MIGRATIONS',
      'ALX_ERR_AUDIT_FAILED',
      'ALX_ERR_COLLECTIONS_DRIFT',
    ]);
    for (const key of Object.keys(api.EXIT_CODES)) {
      assert.ok(codes.has(key) || cliOnly.has(key), `EXIT_CODES key ${key} matches no error code`);
    }
    // Distinct, non-reserved numbers: 0 is success, 1 the generic failure.
    const values = Object.values(api.EXIT_CODES);
    assert.strictEqual(new Set(values).size, values.length, 'exit codes must be unique');
    assert.ok(values.every((value) => Number.isInteger(value) && value >= 2 && value <= 125));
  });

  it('should start every code with ALX_ERR_, the CLI conditions included', () => {
    // 3.0 renamed them all at once; a code added in the 2.x format would split the set again.
    const api = require(path.join(repoRoot, 'index.js'));
    for (const code of Object.keys(api.EXIT_CODES)) {
      assert.match(code, /^ALX_ERR_[A-Z_]+$/, `${code} lacks the ALX_ERR_ prefix`);
    }
  });
});

describe('declaration file', () => {
  it('should list every runtime error code in the MigronautErrorCode union', () => {
    // The one lockstep surface nothing else pins both ways: classes and exit
    // codes are checked above, and a subclass's narrowed `code` makes check:dts
    // refuse a literal missing from the union — but nothing else drops a stale
    // member. Same textual-pin style schema-sync uses.
    const dts = readRepoFile('index.d.ts');
    const unionMatch = /export type MigronautErrorCode =([\s\S]*?);/.exec(dts);
    assert.ok(unionMatch, 'expected the MigronautErrorCode union in index.d.ts');
    const declared = new Set([...unionMatch[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));

    const errors = require(path.join(repoRoot, 'src', 'errors', 'index.js'));
    const runtime = new Set();
    for (const [name, ErrorClass] of Object.entries(errors)) {
      if (name === 'MigronautError' || typeof ErrorClass !== 'function') continue;
      runtime.add(new ErrorClass('probe').code);
    }
    assert.deepStrictEqual(
      [...declared].sort(),
      [...runtime].sort(),
      'MigronautErrorCode union and runtime error codes must match exactly',
    );
  });

  it('should not import from the optional mongoose peer', () => {
    // mongoose is an optional peer: a hard import makes index.d.ts fail to
    // resolve for everyone who never installs it. A structural MongooseLike
    // stands in for it instead.
    const dts = readRepoFile('index.d.ts');
    // Comments are stripped first: the doc block above MongooseLike quotes the
    // very import it exists to avoid.
    const code = dts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/from ['"]mongoose['"]/.test(code), 'index.d.ts must not import mongoose');
    assert.ok(dts.includes('interface MongooseLike'));
  });
});

describe('error code docs', () => {
  /** code → class name, for every subclass the error model exports */
  const runtimeCodes = () => {
    const errors = require(path.join(repoRoot, 'src', 'errors', 'index.js'));
    const codes = new Map();
    for (const [name, ErrorClass] of Object.entries(errors)) {
      if (name === 'MigronautError' || typeof ErrorClass !== 'function') continue;
      codes.set(new ErrorClass('probe').code, name);
    }
    return codes;
  };
  const sortedObject = (map) => Object.fromEntries([...map].sort((a, b) => (a[0] < b[0] ? -1 : 1)));

  it('should list every error code with its class in docs/reference/error-codes.md', () => {
    const doc = readRepoFile('docs/reference/error-codes.md');
    const documented = new Map();
    for (const match of doc.matchAll(/^\| `([A-Z_]+)` \| `(\w+)` \|/gm)) {
      assert.ok(!documented.has(match[1]), `${match[1]} is documented twice`);
      documented.set(match[1], match[2]);
    }
    assert.deepStrictEqual(sortedObject(documented), sortedObject(runtimeCodes()));
  });

  it('should list every exit code with its number in docs/reference/cli.md', () => {
    const { EXIT_CODES } = require(path.join(repoRoot, 'src', 'cli', 'exit-codes.js'));
    const doc = readRepoFile('docs/reference/cli.md');
    const documented = new Map();
    for (const match of doc.matchAll(/^\| `(\d+)` \| `([A-Z_]+)`/gm)) {
      documented.set(match[2], Number(match[1]));
    }
    assert.deepStrictEqual(
      sortedObject(documented),
      sortedObject(new Map(Object.entries(EXIT_CODES))),
    );
  });
});

describe('bullmq subpath', () => {
  it('should expose the adapter through its own entry point', () => {
    const adapter = require(path.join(repoRoot, 'bullmq.js'));
    assert.strictEqual(typeof adapter.createMigrationQueue, 'function');
    assert.strictEqual(typeof adapter.createMigrationProcessor, 'function');
    assert.ok(Object.isFrozen(adapter.JOB_NAMES));
  });

  it('should keep the adapter out of the package root', () => {
    // Importing migronaut must cost nothing to someone who never queues: the
    // root barrel neither exports nor loads the adapter.
    const api = require(path.join(repoRoot, 'index.js'));
    const adapter = require(path.join(repoRoot, 'bullmq.js'));
    for (const name of Object.keys(adapter)) {
      assert.strictEqual(api[name], undefined, `${name} leaked into the package root`);
    }
    assert.ok(!/require\(['"]\.\/bullmq/.test(stripComments(readRepoFile('src/index.js'))));
  });

  it('should declare every runtime export in bullmq.d.ts — and nothing that is not exported', () => {
    const adapter = require(path.join(repoRoot, 'bullmq.js'));
    const dts = readRepoFile('bullmq.d.ts');
    for (const name of Object.keys(adapter)) {
      assert.ok(
        dts.includes(`export class ${name}`) ||
          dts.includes(`export function ${name}`) ||
          dts.includes(`export const ${name}`),
        `${name} is exported at runtime but missing from bullmq.d.ts`,
      );
    }
    const declared = [...dts.matchAll(/^export (?:class|function|const) (\w+)/gm)];
    assert.ok(declared.length >= 10, 'expected the declaration file to list the adapter surface');
    for (const [, name] of declared) {
      assert.notStrictEqual(adapter[name], undefined, `${name} is declared but not exported`);
    }
  });

  it('should never require bullmq from src — it is injected, not depended on', () => {
    // The rule that keeps the package zero-dependency, made executable: one
    // `require('bullmq')` would make the adapter crash for anyone who relies on
    // injection alone, and would pin a BullMQ version for everyone else.
    // Its Redis client is the caller's too, and a subpath (`bullmq/dist/…`)
    // is the package all the same.
    const pattern = /(?:require\(|from|import\()\s*['"](?:bullmq|ioredis)(?:\/[^'"]*)?['"]/;
    const offenders = [...sourceFiles('src'), ...sourceFiles('bin')].filter((file) =>
      pattern.test(stripComments(readRepoFile(file))),
    );
    assert.deepStrictEqual(offenders, []);
    for (const sample of [
      "require('bullmq')",
      'require("bullmq")',
      "require('bullmq/dist/esm/classes')",
      "await import('bullmq')",
      "import { Queue } from 'bullmq'",
      "require('ioredis')",
    ]) {
      assert.ok(pattern.test(sample), `the guard must catch ${sample}`);
    }
    assert.ok(!pattern.test("require('./bullmq-like.js')"));
  });

  it('should not import bullmq from any declaration file', () => {
    // Structural BullMQ*Like types stand in for it, as MongooseLike does for
    // mongoose — a hard import would break the file for users without bullmq.
    for (const file of DECLARATION_FILES) {
      const code = stripComments(readRepoFile(file));
      assert.ok(
        !/(?:from|import\()\s*['"](?:bullmq|ioredis)(?:\/[^'"]*)?['"]/.test(code),
        `${file} must not import bullmq`,
      );
    }
    assert.ok(readRepoFile('bullmq.d.ts').includes('interface BullMQQueueLike'));
    // The dependency arrow points one way: the subpath builds on the root.
    assert.ok(!/from ['"]\.\/bullmq/.test(stripComments(readRepoFile('index.d.ts'))));
  });

  it('should publish the subpath in the exports map, types first', () => {
    assert.strictEqual(Object.keys(packageJson.exports)[0], '.');
    assert.deepStrictEqual(packageJson.exports['./bullmq'], {
      types: './bullmq.d.ts',
      default: './bullmq.js',
    });
    assert.deepStrictEqual(Object.keys(packageJson.exports['./bullmq']), ['types', 'default']);
    for (const entry of ['bullmq.js', 'bullmq.d.ts']) {
      assert.ok(packageJson.files.includes(entry), `${entry} must be in "files"`);
    }
  });

  it('should keep bullmq and its Redis client as test-only devDependencies', () => {
    for (const name of ['bullmq', 'ioredis']) {
      assert.strictEqual(packageJson.peerDependencies[name], undefined);
      assert.strictEqual(packageJson.peerDependenciesMeta?.[name], undefined);
      assert.strictEqual(typeof packageJson.devDependencies[name], 'string');
    }
  });
});

/** Every `require('…')` — or dynamic `import('…')` — target in a source file */
const requiresOf = (file) =>
  [
    ...stripComments(readRepoFile(file)).matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((match) => match[1]);

describe('bullmq adapter layering', () => {
  it('should require the kit and the lock wait of the core, never a mechanism module', () => {
    // A second orchestration layer above the kit: what it needs from the
    // engine, the kit offers as a public method (CLAUDE.md, layering rule).
    const files = sourceFiles('src/bullmq');
    assert.ok(files.length >= 6, 'expected the adapter sources');
    for (const file of files) {
      for (const target of requiresOf(file)) {
        // Node's built-ins are no layer: the rule is about the engine below.
        assert.ok(
          target.startsWith('node:') ||
            /^\.\/[\w-]+\.js$/.test(target) ||
            /^\.\.\/utils\/[\w-]+\.js$/.test(target) ||
            target === '../errors/index.js' ||
            target === '../core/migrator.js' ||
            target === '../core/lock-wait.js',
          `${file} requires ${target}`,
        );
      }
    }
  });
});

describe('versioning subpath', () => {
  it('should expose the runtime through its own entry point', () => {
    const versioning = require(path.join(repoRoot, 'versioning.js'));
    for (const name of [
      'defineShapes',
      'updateWithRevision',
      'replaceWithRevision',
      'findOneAndUpdateWithRevision',
      'retryOnConflict',
      'bumpRevision',
    ]) {
      assert.strictEqual(typeof versioning[name], 'function', `${name} missing`);
    }
  });

  it('should re-export the very error classes of the package root', () => {
    // `instanceof` must agree whichever entry point a caller imported from.
    const api = require(path.join(repoRoot, 'index.js'));
    const versioning = require(path.join(repoRoot, 'versioning.js'));
    for (const name of [
      'MigronautError',
      'ConfigInvalidError',
      'RevisionConflictError',
      'ShapeVersionError',
    ]) {
      assert.strictEqual(versioning[name], api[name], `${name} is a different class`);
    }
  });

  it('should require nothing but its own modules and the error classes', () => {
    // The point of the subpath: a repository layer that loads it pays for no
    // engine, no driver and no mongoose.
    const files = sourceFiles('src/versioning');
    assert.ok(files.length >= 6, 'expected the versioning sources');
    for (const file of files) {
      for (const target of requiresOf(file)) {
        // Node's built-ins cost nothing to load and are no part of the engine.
        const isOwn = /^\.\/[\w-]+\.js$/.test(target) || target === '../errors/index.js';
        assert.ok(target.startsWith('node:') || isOwn, `${file} requires ${target}`);
      }
    }
  });

  it('should keep the engine from being required by the subpath, only the other way round', () => {
    for (const file of sourceFiles('src/versioning')) {
      assert.ok(!requiresOf(file).some((target) => target.includes('core/')), file);
    }
    assert.ok(!/require\(['"]\.\/versioning/.test(stripComments(readRepoFile('src/index.js'))));
  });

  it('should declare every runtime export in versioning.d.ts — and nothing that is not exported', () => {
    const versioning = require(path.join(repoRoot, 'versioning.js'));
    const dts = readRepoFile('versioning.d.ts');
    const reexported = new Set(
      /export \{([^}]*)\} from '\.\/index\.js'/
        .exec(dts)[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    );
    for (const name of Object.keys(versioning)) {
      assert.ok(
        reexported.has(name) ||
          dts.includes(`export function ${name}`) ||
          dts.includes(`export const ${name}`),
        `${name} is exported at runtime but missing from versioning.d.ts`,
      );
    }
    for (const [, name] of dts.matchAll(/^export (?:class|function|const) (\w+)/gm)) {
      assert.notStrictEqual(versioning[name], undefined, `${name} is declared but not exported`);
    }
  });

  it('should not import the driver or mongoose from versioning.d.ts', () => {
    const code = stripComments(readRepoFile('versioning.d.ts'));
    assert.ok(!/from ['"](mongodb|mongoose|bson)['"]/.test(code));
    assert.ok(!/from ['"]\.\/versioning/.test(stripComments(readRepoFile('index.d.ts'))));
  });

  it('should publish the subpath in the exports map, types first', () => {
    assert.deepStrictEqual(packageJson.exports['./versioning'], {
      types: './versioning.d.ts',
      default: './versioning.js',
    });
    for (const entry of ['versioning.js', 'versioning.d.ts']) {
      assert.ok(packageJson.files.includes(entry), `${entry} must be in "files"`);
    }
    assert.match(packageJson.scripts['check:dts'], /versioning\.d\.ts/);
  });
});

describe('peer dependencies', () => {
  it('should never require mongoose from src, and the driver only where it is a peer by design', () => {
    // mongoose is an optional peer the caller injects; the driver is loaded
    // lazily, from the one place that connects.
    // bson-peer.js is the one lazy door to the driver's BSON (sizes, EJSON).
    const allowed = new Set(['src/core/migrator.js', 'src/core/background/bson-peer.js']);
    const offenders = [];
    for (const file of sourceFiles('src')) {
      for (const target of [
        ...stripComments(readRepoFile(file)).matchAll(
          // A subpath (`mongodb/lib/…`) is the package all the same. No
          // `from`: the source is CommonJS, and an error message that says
          // "BSONRegExp from 'bson'" is not an import.
          /(?:require\(|import\()\s*['"](mongodb|mongoose|bson)(?:\/[^'"]*)?['"]/g,
        ),
      ].map((match) => match[1])) {
        if (target !== 'mongodb' || !allowed.has(file)) offenders.push(`${file}: ${target}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });
});

describe('OpenTelemetry', () => {
  // Injected like everything else: the tracer and the meter arrive through the
  // `telemetry` option, and BullMQ's telemetry object through `bullmq.telemetry`.
  const packages = [
    '@opentelemetry/api',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/instrumentation-mongodb',
    'bullmq-otel',
  ];
  const imports = /(?:require\(|from|import\()\s*['"](?:@opentelemetry\/|bullmq-otel)/;

  it('should never require an OpenTelemetry package from src or the CLI', () => {
    // One `require('@opentelemetry/api')` would crash every install that does
    // not trace — which is nearly all of them — and pin an API version for the
    // rest.
    const offenders = [...sourceFiles('src'), ...sourceFiles('bin')].filter((file) =>
      imports.test(stripComments(readRepoFile(file))),
    );
    assert.deepStrictEqual(offenders, []);
  });

  it('should not import one from any declaration file', () => {
    // Structural MigronautTracer / MigronautMeter stand in, as MongooseLike
    // does for mongoose.
    for (const file of DECLARATION_FILES) {
      assert.ok(!imports.test(stripComments(readRepoFile(file))), `${file} must not import it`);
    }
    const dts = readRepoFile('index.d.ts');
    assert.ok(dts.includes('interface MigronautTracer'));
    assert.ok(dts.includes('interface MigronautMeter'));
  });

  it('should keep every OpenTelemetry package a test-only devDependency', () => {
    for (const name of packages) {
      assert.strictEqual(packageJson.peerDependencies[name], undefined);
      assert.strictEqual(packageJson.peerDependenciesMeta?.[name], undefined);
      assert.strictEqual(typeof packageJson.devDependencies[name], 'string');
    }
  });
});

describe('identifier minting', () => {
  it('should mint ids in one module only — the one `generateId` replaces', () => {
    // A stray `randomUUID()` anywhere else would be an id the `generateId`
    // option cannot reach: a deployment that asked for ULIDs would still find
    // a UUID in its changelog or its queue.
    const minters = sourceFiles('src').filter((file) =>
      /randomUUID|randomBytes|getRandomValues/.test(stripComments(readRepoFile(file))),
    );
    assert.deepStrictEqual(minters, ['src/utils/id.js']);
  });
});

describe('conventions that only review used to hold', () => {
  const shipped = [...sourceFiles('src'), ...sourceFiles('bin')];
  /** The files of `files` whose code (comments apart) matches `pattern`, minus the sanctioned ones */
  const offendersOf = (pattern, sanctioned = new Set()) => {
    const offenders = [];
    for (const file of shipped) {
      if (!sanctioned.has(file) && pattern.test(stripComments(readRepoFile(file)))) {
        offenders.push(file);
      }
    }
    return offenders;
  };

  it('should never write to the console — the injected logger is the only voice', () => {
    // A `console.log` in a mechanism module is output no `logger: null`, no
    // `--json` and no pino sink can route or silence.
    assert.deepStrictEqual(offendersOf(/\bconsole\s*\.\s*\w+/), []);
  });

  it('should call Array#find and Array#filter nowhere — the lint bans the other methods', () => {
    // `find` and `filter` are MongoDB words too (Collection#find, a query's
    // filter), so the lint cannot ban them by name. An array's takes a
    // function; MongoDB's takes a filter document.
    const callback = /\.(?:find|filter)\(\s*(?:async\b|function\b|\(|[\w$]+\s*=>|Boolean\s*\))/;
    assert.deepStrictEqual(offendersOf(callback), []);
    assert.ok(callback.test('list.find((item) => item)') && !callback.test('collection.find({})'));
  });

  it('should destructure no array — a library reads by index', () => {
    // oxlint has no `no-restricted-syntax`, so this holds alexiskills' rule
    // instead: declarations and loop heads, arrow parameters, assignments.
    const patterns = [
      /\b(?:const|let|var)\s*\[/,
      /\(\s*(?:[\w$]+\s*,\s*)*\[[\w$\s,.]*\][^()]*\)\s*=>/,
      /^\s*\[[^\]]+\]\s*=[^=>]/m,
    ];
    const samples = [
      'const [a] = list;',
      'for (const [k, v] of map)',
      '([name]) => name',
      '[a, b] = [b, a];',
    ];
    for (const sample of samples) {
      assert.ok(
        patterns.some((pattern) => pattern.test(sample)),
        sample,
      );
    }
    for (const pattern of patterns) assert.deepStrictEqual(offendersOf(pattern), [], `${pattern}`);
  });

  it('should never throw a bare Error — every throw carries a typed code', () => {
    const sanctioned = new Set([
      // Text of the user's scaffold, not migronaut's code.
      'src/utils/template.js',
      // A malformed flag definition: a bug in migronaut's own command table,
      // thrown at registration, never at a user.
      'src/cli/args.js',
    ]);
    assert.deepStrictEqual(
      offendersOf(
        /throw\s+new\s+(?:Error|TypeError|RangeError|SyntaxError|ReferenceError)\b/,
        sanctioned,
      ),
      [],
    );
  });

  it('should call a tracer, a span or an instrument in utils/telemetry.js only', () => {
    // Every such call goes through that module's one guard: telemetry must
    // never break a run, and an exception recorded raw would skip redaction.
    const calls =
      /\.(?:startActiveSpan|startSpan|recordException|setStatus|setAttributes?|createCounter|createHistogram|createUpDownCounter|createObservable\w*)\s*\(/;
    assert.deepStrictEqual(offendersOf(calls, new Set(['src/utils/telemetry.js'])), []);
    assert.ok(calls.test(readRepoFile('src/utils/telemetry.js')), 'the guard must see real calls');
  });

  it('should name the published minor as the supported one in SECURITY.md', () => {
    // "Only the latest published version receives fixes": the table said
    // 2.1.x for three minors.
    const [major, minor] = packageJson.version.split('.');
    const security = readRepoFile('SECURITY.md');
    assert.ok(
      security.includes(`| ${major}.${minor}.x | ✅ |`),
      `SECURITY.md must list ${major}.${minor}.x as supported`,
    );
    assert.ok(security.includes(`| < ${major}.${minor} | ❌ |`));
  });
});

describe('published package', () => {
  it('should ship every file the entry points need', () => {
    for (const entry of ['index.js', 'index.d.ts', 'bin', 'src']) {
      assert.ok(packageJson.files.includes(entry), `${entry} must be in "files"`);
    }
  });

  it('should leave the folder notes for agents out of the tarball', () => {
    // A folder's CLAUDE.md sits beside its code; `src` alone would publish it.
    assert.ok(packageJson.files.includes('!**/CLAUDE.md'));
  });

  it('should ship the license and the security policy beside the changelog', () => {
    for (const entry of ['README.md', 'CHANGELOG.md', 'LICENSE', 'SECURITY.md']) {
      assert.ok(packageJson.files.includes(entry), `${entry} must be in "files"`);
    }
  });

  it('should name one version in package.json, the CHANGELOG, ARCHITECTURE.md and the docs', () => {
    // Four spots, synced by hand in the release commit (CLAUDE.md, Release process).
    const { version } = packageJson;
    const released = /^## \[(\d+\.\d+\.\d+[^\]]*)\] - \d{4}-\d{2}-\d{2}$/m.exec(
      readRepoFile('CHANGELOG.md'),
    );
    assert.strictEqual(released?.[1], version, 'the newest CHANGELOG release');
    const snapshot = /\*\*Snapshot at time of writing:\*\* v(\S+) ·/.exec(
      readRepoFile('ARCHITECTURE.md'),
    );
    assert.strictEqual(snapshot?.[1], version, 'the snapshot line of ARCHITECTURE.md');
    const config = readRepoFile('docs/.vitepress/config.mts');
    // `\r?`: a Windows checkout ends its lines with CRLF, and `.` stops at the `\r`.
    const nav = /\/\/ Hand-synced with package\.json "version".*\r?\n\s*text: 'v([^']+)'/.exec(
      config,
    );
    assert.strictEqual(nav?.[1], version, 'the nav label of the docs site');
  });

  it('should link every CHANGELOG release, newest first, from the link block', () => {
    const changelog = readRepoFile('CHANGELOG.md');
    const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1]);
    assert.strictEqual(headings[0], 'Unreleased', 'an [Unreleased] section on top');
    for (const heading of headings) {
      const label = heading.toLowerCase() === 'unreleased' ? 'unreleased' : heading;
      assert.match(changelog, new RegExp(`^\\[${label.replaceAll('.', '\\.')}\\]: https://`, 'm'));
    }
  });

  it('should publish the scoped package publicly', () => {
    // Without this npm defaults a scoped package to restricted, and a manual
    // publish silently produces something nobody can install.
    assert.strictEqual(packageJson.publishConfig?.access, 'public');
  });

  it('should declare no runtime dependencies', () => {
    assert.strictEqual(packageJson.dependencies, undefined);
  });

  it('should pin the in-memory MongoDB used by the integration tests', () => {
    // An unpinned version silently changes the server the whole suite runs on.
    assert.match(packageJson.devDependencies['mongodb-memory-server'], /^\d+\.\d+\.\d+$/);
  });
});
