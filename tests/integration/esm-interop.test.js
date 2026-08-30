const { execFile } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const run = promisify(execFile);
const repoRoot = path.join(__dirname, '..', '..');

/**
 * The package is CommonJS-only by design (no dual build), with the documented
 * promise that "ESM consumers still work" through Node's CJS/ESM interop —
 * named exports included, which depends on cjs-module-lexer being able to see
 * the barrel's export shape. This pins that promise against a real `import`
 * from an .mjs consumer, so a future change to src/index.js's export style
 * cannot silently break every ESM user.
 */
describe('ESM consumer interop (integration)', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'migronaut-esm-'));
    // A real consumer imports the package NAME, resolved through node_modules
    // and the "exports" map — the symlink makes this repo that package.
    mkdirSync(path.join(dir, 'node_modules', '@alexify'), { recursive: true });
    symlinkSync(repoRoot, path.join(dir, 'node_modules', '@alexify', 'migronaut'), 'dir');
    writeFileSync(
      path.join(dir, 'consumer.mjs'),
      // Named imports (the lexer-dependent form) AND the default form.
      `import def from '@alexify/migronaut';
import {
  MigratorKit,
  runMigrations,
  pendingMigrations,
  createLogger,
  EXIT_CODES,
  MigronautError,
  OutOfOrderMigrationError,
} from '@alexify/migronaut';

if (typeof MigratorKit !== 'function') throw new Error('MigratorKit is not a function');
if (typeof runMigrations !== 'function') throw new Error('runMigrations is not a function');
if (typeof pendingMigrations !== 'function') throw new Error('pendingMigrations missing');
if (typeof createLogger !== 'function') throw new Error('createLogger missing');
if (typeof EXIT_CODES.LOCK_ALREADY_HELD !== 'number') throw new Error('EXIT_CODES missing');
if (!(new OutOfOrderMigrationError('x') instanceof MigronautError)) {
  throw new Error('error hierarchy broken through ESM interop');
}
if (def.MigratorKit !== MigratorKit) throw new Error('default and named exports disagree');
console.log('esm-interop-ok');
`,
    );
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should import named exports from an .mjs consumer', async () => {
    const { stdout } = await run(process.execPath, [path.join(dir, 'consumer.mjs')]);
    assert.match(stdout, /esm-interop-ok/);
  });
});
