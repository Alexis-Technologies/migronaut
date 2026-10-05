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

/** Every `.js` file under `dir`, repo-relative — the tree the "nothing in src may…" rules walk */
function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(relative));
    else if (entry.name.endsWith('.js')) files.push(relative);
  }
  return files;
}

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
    const cliOnly = new Set(['PENDING_MIGRATIONS', 'AUDIT_FAILED', 'COLLECTIONS_DRIFT']);
    for (const key of Object.keys(api.EXIT_CODES)) {
      assert.ok(codes.has(key) || cliOnly.has(key), `EXIT_CODES key ${key} matches no error code`);
    }
    // Distinct, non-reserved numbers: 0 is success, 1 the generic failure.
    const values = Object.values(api.EXIT_CODES);
    assert.strictEqual(new Set(values).size, values.length, 'exit codes must be unique');
    assert.ok(values.every((value) => Number.isInteger(value) && value >= 2 && value <= 125));
  });
});

describe('declaration file', () => {
  it('should list every runtime error code in the MigronautErrorCode union', () => {
    // The one lockstep surface nothing else pins: classes and exit codes are
    // checked both ways above, but the code-literal union can silently omit a
    // new code — tsc/tsd cannot force it in, since subclasses do not narrow
    // `code`. Same textual-pin style schema-sync uses.
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
    const pattern = /require\(\s*['"]bullmq['"]\s*\)|from\s+['"]bullmq['"]|import\(\s*['"]bullmq/;
    const offenders = sourceFiles('src').filter((file) =>
      pattern.test(stripComments(readRepoFile(file))),
    );
    assert.deepStrictEqual(offenders, []);
  });

  it('should not import bullmq from either declaration file', () => {
    // Structural BullMQ*Like types stand in for it, as MongooseLike does for
    // mongoose — a hard import would break both files for users without bullmq.
    for (const file of ['bullmq.d.ts', 'index.d.ts']) {
      const code = stripComments(readRepoFile(file));
      assert.ok(!/from ['"]bullmq['"]/.test(code), `${file} must not import bullmq`);
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

describe('versioning subpath', () => {
  /** Every `require('…')` target in a source file */
  const requiresOf = (file) =>
    [...stripComments(readRepoFile(file)).matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
      (match) => match[1],
    );

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
        assert.ok(
          /^\.\/[\w-]+\.js$/.test(target) || target === '../errors/index.js',
          `${file} requires ${target}`,
        );
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
    const allowed = new Set(['src/core/migrator.js']);
    const offenders = [];
    for (const file of sourceFiles('src')) {
      for (const target of [
        ...stripComments(readRepoFile(file)).matchAll(
          /(?:require\(|import\()\s*['"](mongodb|mongoose|bson)['"]/g,
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

  it('should not import one from either declaration file', () => {
    // Structural MigronautTracer / MigronautMeter stand in, as MongooseLike
    // does for mongoose.
    for (const file of ['index.d.ts', 'bullmq.d.ts']) {
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

describe('published package', () => {
  it('should ship every file the entry points need', () => {
    for (const entry of ['index.js', 'index.d.ts', 'bin', 'src']) {
      assert.ok(packageJson.files.includes(entry), `${entry} must be in "files"`);
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
