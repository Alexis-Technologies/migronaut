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

  describe('the ./bullmq subpath', () => {
    // The JS entry, not node_modules/.bin/tsc: that one is a shell shim (and a
    // .cmd on Windows), which `node` cannot run.
    const tsc = require.resolve('typescript/bin/tsc');

    before(() => {
      writeFileSync(
        path.join(dir, 'subpath.mjs'),
        `import adapter from '@alexify/migronaut/bullmq';
import {
  createMigrationQueue,
  createMigrationProcessor,
  JOB_NAMES,
} from '@alexify/migronaut/bullmq';

if (typeof createMigrationQueue !== 'function') throw new Error('createMigrationQueue missing');
if (typeof createMigrationProcessor !== 'function') throw new Error('processor factory missing');
if (JOB_NAMES.UP !== 'up') throw new Error('JOB_NAMES missing');
if (adapter.createMigrationQueue !== createMigrationQueue) {
  throw new Error('default and named exports disagree');
}
console.log('subpath-esm-ok');
`,
      );
      writeFileSync(
        path.join(dir, 'subpath.cjs'),
        `const adapter = require('@alexify/migronaut/bullmq');
if (typeof adapter.createMigrationQueue !== 'function') throw new Error('subpath did not resolve');

// The exports map is closed: only what it lists is reachable, so an internal
// module can be moved without breaking anyone who reached past the entry point.
let code;
try {
  require('@alexify/migronaut/src/bullmq/index.js');
} catch (error) {
  code = error.code;
}
if (code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw new Error('deep import was allowed: ' + code);
console.log('subpath-cjs-ok');
`,
      );
      writeFileSync(
        path.join(dir, 'root-only.cjs'),
        // Whoever only migrates must not pay for the queue adapter — nor ever
        // touch bullmq, which they may not have installed.
        `require('@alexify/migronaut');
const loaded = Object.keys(require.cache).filter(
  (file) => /[\\/]src[\\/]bullmq[\\/]/.test(file) || /[\\/]node_modules[\\/]bullmq[\\/]/.test(file),
);
if (loaded.length > 0) throw new Error('the root entry loaded: ' + loaded.join(', '));
console.log('root-only-ok');
`,
      );
      writeFileSync(
        path.join(dir, 'adapter-only.cjs'),
        // The adapter itself never loads bullmq either — it is injected.
        `require('@alexify/migronaut/bullmq');
const loaded = Object.keys(require.cache).filter((file) =>
  /[\\/]node_modules[\\/](bullmq|ioredis)[\\/]/.test(file),
);
if (loaded.length > 0) throw new Error('the adapter loaded: ' + loaded.join(', '));
console.log('adapter-only-ok');
`,
      );
      writeFileSync(
        path.join(dir, 'types.mts'),
        // Type-only: bullmq is deliberately absent from this consumer, which is
        // exactly the install the declaration file must still resolve for.
        `import type { MigrationJobData, MigrationQueue } from '@alexify/migronaut/bullmq';
import type { MigratorKit } from '@alexify/migronaut';

export type Kit = MigrationQueue['kit'] extends MigratorKit ? true : never;
export const direction: MigrationJobData['direction'] = 'up';
export const ok: Kit = true;
`,
      );
    });

    it('should resolve from an ESM consumer through the exports map', async () => {
      const { stdout } = await run(process.execPath, [path.join(dir, 'subpath.mjs')]);
      assert.match(stdout, /subpath-esm-ok/);
    });

    it('should resolve from a CJS consumer, and keep deep imports closed', async () => {
      const { stdout } = await run(process.execPath, [path.join(dir, 'subpath.cjs')]);
      assert.match(stdout, /subpath-cjs-ok/);
    });

    it('should not be loaded by the package root', async () => {
      const { stdout } = await run(process.execPath, [path.join(dir, 'root-only.cjs')]);
      assert.match(stdout, /root-only-ok/);
    });

    it('should not load bullmq itself', async () => {
      const { stdout } = await run(process.execPath, [path.join(dir, 'adapter-only.cjs')]);
      assert.match(stdout, /adapter-only-ok/);
    });

    it('should resolve its types for a nodenext consumer without bullmq installed', async () => {
      // tsd and check:dts only ever use classic resolution, which ignores the
      // exports map — this is the one place `exports["./bullmq"].types` is
      // proven for the resolver modern TypeScript projects actually use.
      await run(
        process.execPath,
        [
          tsc,
          '--noEmit',
          '--strict',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--skipLibCheck',
          path.join(dir, 'types.mts'),
        ],
        { cwd: dir },
      );
    });
  });

  describe('the ./versioning subpath', () => {
    const tsc = require.resolve('typescript/bin/tsc');

    before(() => {
      writeFileSync(
        path.join(dir, 'versioning.mjs'),
        `import versioning from '@alexify/migronaut/versioning';
import {
  defineShapes,
  updateWithRevision,
  retryOnConflict,
  RevisionConflictError,
} from '@alexify/migronaut/versioning';
import { RevisionConflictError as RootError } from '@alexify/migronaut';

if (typeof defineShapes !== 'function') throw new Error('defineShapes missing');
if (typeof updateWithRevision !== 'function') throw new Error('updateWithRevision missing');
if (typeof retryOnConflict !== 'function') throw new Error('retryOnConflict missing');
if (RevisionConflictError !== RootError) throw new Error('two RevisionConflictError classes');
if (versioning.defineShapes !== defineShapes) throw new Error('default and named exports disagree');
console.log('versioning-esm-ok');
`,
      );
      writeFileSync(
        path.join(dir, 'versioning-only.cjs'),
        // A repository layer that loads the runtime must not load the engine,
        // the driver or mongoose.
        `require('@alexify/migronaut/versioning');
const loaded = Object.keys(require.cache).filter(
  (file) =>
    /[\\/]src[\\/](core|cli|bullmq|utils)[\\/]/.test(file) ||
    /[\\/]node_modules[\\/](mongodb|mongoose|bson)[\\/]/.test(file),
);
if (loaded.length > 0) throw new Error('the subpath loaded: ' + loaded.join(', '));
console.log('versioning-only-ok');
`,
      );
      writeFileSync(
        path.join(dir, 'versioning-types.mts'),
        `import type { ShapeRegistry, RevisionWriteOptions } from '@alexify/migronaut/versioning';
import { defineShapes } from '@alexify/migronaut/versioning';

const shapes: ShapeRegistry<'orders'> = defineShapes({ orders: { versioning: { current: 2 } } });
export const options: RevisionWriteOptions = { verify: false };
export const current: number = shapes.current('orders');
`,
      );
    });

    it('should resolve from an ESM consumer, with the root error classes', async () => {
      const { stdout } = await run(process.execPath, [path.join(dir, 'versioning.mjs')]);
      assert.match(stdout, /versioning-esm-ok/);
    });

    it('should load neither the engine nor the driver', async () => {
      const { stdout } = await run(process.execPath, [path.join(dir, 'versioning-only.cjs')]);
      assert.match(stdout, /versioning-only-ok/);
    });

    it('should resolve its types for a nodenext consumer', async () => {
      await run(
        process.execPath,
        [
          tsc,
          '--noEmit',
          '--strict',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--skipLibCheck',
          path.join(dir, 'versioning-types.mts'),
        ],
        { cwd: dir },
      );
    });
  });
});
