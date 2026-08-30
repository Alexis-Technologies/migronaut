const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const readRepoFile = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');
const packageJson = JSON.parse(readRepoFile('package.json'));

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
    assert.ok(codes.size >= 19, 'expected every error subclass to carry a code');
    for (const code of codes) {
      assert.strictEqual(
        typeof api.EXIT_CODES[code],
        'number',
        `error code ${code} has no EXIT_CODES entry`,
      );
    }
    // The other direction: EXIT_CODES may add CLI-condition codes, but never
    // a typo'd error code.
    const cliOnly = new Set(['PENDING_MIGRATIONS', 'AUDIT_FAILED']);
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
