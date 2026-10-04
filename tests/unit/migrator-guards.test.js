const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { MigratorKit } = require('../../src/core/migrator.js');
const { ConfigInvalidError, MigrationInvalidNameError } = require('../../src/errors/index.js');

/**
 * A kit pointed at an unreachable host. Every guard below must reject *before*
 * any connection is attempted — if a guard were missing, the call would hang on
 * server selection instead of throwing, so these tests double as proof that the
 * validation happens up front.
 */
function guardedKit() {
  return new MigratorKit({
    // serverSelectionTimeoutMS keeps the one test that *does* reach the driver
    // from waiting out the 30s default.
    uri: 'mongodb://127.0.0.1:1/never?serverSelectionTimeoutMS=100',
    dbName: 'nope',
    migrationsDir: '/tmp/migronaut-guards-does-not-exist',
    logger: null,
  });
}

describe('MigratorKit filename guards', () => {
  // A non-string filename would flow into changelog.getByName -> findOne({ name })
  // where a query operator selects an arbitrary record.
  const injections = [
    ['query operator', { $ne: null }],
    ['regex', { $regex: '.*' }],
    ['array', ['a.js']],
    ['number', 42],
    ['null', null],
  ];

  for (const [label, value] of injections) {
    it(`should reject a ${label} filename passed to up()`, async () => {
      await assert.rejects(guardedKit().up(value), MigrationInvalidNameError);
    });

    it(`should reject a ${label} filename passed to down()`, async () => {
      await assert.rejects(guardedKit().down(value), MigrationInvalidNameError);
    });

    it(`should reject a ${label} filename passed to redo()`, async () => {
      await assert.rejects(guardedKit().redo(value), MigrationInvalidNameError);
    });

    it(`should reject a ${label} filename passed to dryRun()`, async () => {
      await assert.rejects(guardedKit().dryRun('up', value), MigrationInvalidNameError);
    });
  }

  it('should still allow an omitted filename (the bulk case)', () => {
    // undefined must pass the guard — it reaches the connection attempt instead,
    // which is a different (connection) failure, not an invalid-name one.
    const kit = guardedKit();
    return assert.rejects(kit.up(undefined), (error) => {
      assert.ok(!(error instanceof MigrationInvalidNameError));
      return true;
    });
  });
});

describe('MigratorKit list filter guard', () => {
  // An unknown filter used to silently return [] — indistinguishable from
  // "no migrations", which is the worst possible answer to a typo.
  const badFilters = ['reverted', 'Applied', '', 42, null, { $ne: null }];

  for (const value of badFilters) {
    it(`should reject ${JSON.stringify(value)} as a list() filter`, async () => {
      await assert.rejects(guardedKit().list(value), ConfigInvalidError);
    });
  }
});

describe('MigratorKit import collection guards', () => {
  const badNames = [
    ['a system collection', 'system.users'],
    ['a $-bearing name', 'change$log'],
    ['a NUL-bearing name', 'change\0log'],
    ['an empty name', ''],
  ];

  for (const [label, value] of badNames) {
    it(`should reject ${label} as --from`, async () => {
      await assert.rejects(guardedKit().import({ from: value }), ConfigInvalidError);
    });

    it(`should reject ${label} as --to`, async () => {
      await assert.rejects(guardedKit().import({ to: value }), ConfigInvalidError);
    });
  }
});

describe('MigratorKit sequenced-run option guards', () => {
  // `batch` and `ordered` are what a queue job passes for every migration, so
  // a malformed value must be refused before anything connects — never stamped
  // into the changelog or quietly ignored.
  const badBatches = [0, -1, 1.5, '3', Number.NaN, null];

  for (const value of badBatches) {
    it(`should reject ${JSON.stringify(value)} as an up() batch`, async () => {
      await assert.rejects(guardedKit().up('0001-a.js', { batch: value }), (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.ok(Object.hasOwn(error.context, 'batch'));
        return true;
      });
    });
  }

  it('should reject an explicit batch combined with step', async () => {
    await assert.rejects(guardedKit().up(undefined, { batch: 3, step: true }), (error) => {
      assert.ok(error instanceof ConfigInvalidError);
      assert.match(error.message, /--batch with --step/);
      return true;
    });
  });

  for (const value of ['yes', 1, null, {}]) {
    it(`should reject ${JSON.stringify(value)} as ordered`, async () => {
      await assert.rejects(guardedKit().up('0001-a.js', { ordered: value }), ConfigInvalidError);
      await assert.rejects(guardedKit().down('0001-a.js', { ordered: value }), ConfigInvalidError);
    });
  }

  it('should reject ordered without a filename — a bulk run is in order by construction', async () => {
    for (const run of [
      guardedKit().up(undefined, { ordered: true }),
      guardedKit().down(undefined, { ordered: true }),
    ]) {
      await assert.rejects(run, (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.match(error.message, /requires a filename/);
        return true;
      });
    }
  });

  it('should let ordered: false through without a filename', () => {
    // Reaches the connection attempt — a different failure, not a guard one.
    return assert.rejects(guardedKit().up(undefined, { ordered: false }), (error) => {
      assert.ok(!(error instanceof ConfigInvalidError));
      return true;
    });
  });
});

describe('MigratorKit.generateId', () => {
  const kitWith = (config) =>
    new MigratorKit({
      uri: 'mongodb://127.0.0.1:1/never?serverSelectionTimeoutMS=100',
      dbName: 'nope',
      logger: null,
      ...config,
    });

  it('should mint a random UUID by default, without connecting', async () => {
    // The host is unreachable: a connection attempt would reject, not resolve.
    const kit = kitWith({});
    const id = await kit.generateId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notStrictEqual(await kit.generateId(), id);
  });

  it('should mint through the configured generator', async () => {
    let count = 0;
    const kit = kitWith({ generateId: () => `run_${++count}` });
    assert.deepStrictEqual([await kit.generateId(), await kit.generateId()], ['run_1', 'run_2']);
  });

  it('should reject a generator that is not a function as a config issue', async () => {
    await assert.rejects(kitWith({ generateId: 'ulid' }).generateId(), (error) => {
      assert.ok(error instanceof ConfigInvalidError);
      assert.deepStrictEqual(error.context.issues, [
        { path: 'generateId', message: 'must be a function' },
      ]);
      return true;
    });
  });

  it('should reject what an unusable generator returns, every time it is asked', async () => {
    const kit = kitWith({ generateId: () => '' });
    await assert.rejects(kit.generateId(), ConfigInvalidError);
    await assert.rejects(kit.generateId(), /non-empty string/);
  });

  it('should reject an async generator', async () => {
    await assert.rejects(
      kitWith({ generateId: async () => 'late' }).generateId(),
      /must be synchronous/,
    );
  });
});

describe('MigratorKit converge guards', () => {
  const kitWith = (config) =>
    new MigratorKit({
      uri: 'mongodb://127.0.0.1:1/never?serverSelectionTimeoutMS=100',
      dbName: 'nope',
      logger: null,
      ...config,
    });

  for (const key of ['dryRun', 'prune', 'noLock', 'ordered']) {
    it(`should reject a non-boolean ${key} before anything connects`, async () => {
      await assert.rejects(kitWith({}).converge({ [key]: 'yes' }), (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.deepStrictEqual(error.context, { [key]: 'yes' });
        return true;
      });
    });
  }

  it('should return an empty, in-sync result without connecting when nothing is declared', async () => {
    // The host is unreachable: a connection attempt would reject.
    for (const dryRun of [true, false]) {
      assert.deepStrictEqual(await kitWith({}).converge({ dryRun }), {
        dryRun,
        changed: 0,
        inSync: true,
        collections: [],
      });
    }
  });

  it('should reject an invalid definition file before connecting', async () => {
    await assert.rejects(
      kitWith({ collectionsDir: '/tmp/migronaut-guards-no-such-dir' }).converge(),
      (error) =>
        error instanceof ConfigInvalidError && error.message === 'collectionsDir not found',
    );
  });

  it("should validate up's converge option", async () => {
    await assert.rejects(guardedKit().up(undefined, { converge: 'yes' }), (error) => {
      assert.ok(error instanceof ConfigInvalidError);
      assert.match(error.message, /converge must be a boolean/);
      return true;
    });
    await assert.rejects(
      guardedKit().up('0001-a.js', { converge: true }),
      /converge cannot follow a single-file up/,
    );
    await assert.rejects(
      guardedKit().up(undefined, { converge: true, to: '0001-a.js' }),
      /converge cannot follow up --to/,
    );
  });

  it('should report whether a bulk up converges, without connecting', async () => {
    const collections = [{ name: 'users', indexes: [] }];
    assert.strictEqual(await kitWith({}).convergesAfterUp(), false);
    assert.strictEqual(await kitWith({ collections }).convergesAfterUp(), false);
    assert.strictEqual(await kitWith({ convergeAfterUp: true }).convergesAfterUp(), false);
    assert.strictEqual(
      await kitWith({ convergeAfterUp: true, collections }).convergesAfterUp(),
      true,
    );
    assert.strictEqual(
      await kitWith({ convergeAfterUp: true, collectionsDir: './collections' }).convergesAfterUp(),
      true,
    );
  });
});

describe('MigratorKit config resolution', () => {
  it('should load the config once for callers that ask at the same time', async () => {
    const { makeProject } = require('../helpers/project.js');
    const project = makeProject();
    try {
      // A factory, as one that fetches a secret would be: it must run once.
      project.write(
        'migronaut.config.js',
        'let calls = 0;\n' +
          'export default () => {\n' +
          '  calls += 1;\n' +
          '  globalThis.__migronautConfigCalls = calls;\n' +
          "  return { uri: 'mongodb://127.0.0.1:1/never', dbName: 'once', logger: null };\n" +
          '};\n',
      );
      const kit = new MigratorKit({}, { cwd: project.dir });
      const ids = await Promise.all([kit.generateId(), kit.generateId(), kit.generateId()]);
      assert.strictEqual(new Set(ids).size, 3);
      assert.strictEqual(globalThis.__migronautConfigCalls, 1);
      await kit.generateId();
      assert.strictEqual(globalThis.__migronautConfigCalls, 1, 'cached afterwards too');
    } finally {
      delete globalThis.__migronautConfigCalls;
      project.cleanup();
    }
  });
});
