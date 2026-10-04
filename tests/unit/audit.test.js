const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { runAudit } = require('../../src/core/audit.js');

const ALL_INDEXES = [
  { name: '_id_' },
  { name: 'name_unique' },
  { name: 'status_batch' },
  { name: 'batch' },
  { name: 'status_name' },
  { name: 'status_appliedAt_name' },
];

/** Deps for a fully healthy setup — override per case */
function makeDeps(overrides = {}) {
  const config = {
    dbName: 'app',
    migrationsCollection: '_migronaut_migrations',
    lockTTLSeconds: 60,
    fileExtensions: ['.ts', '.js'],
    ...overrides.config,
  };
  const db = {
    admin: () => ({
      command: overrides.hello ?? (async () => ({ setName: 'rs0' })),
    }),
    collection: () => ({
      indexes: overrides.indexes ?? (async () => ALL_INDEXES),
    }),
  };
  return {
    ensureConfig: overrides.ensureConfig ?? (async () => config),
    connect: overrides.connect ?? (async () => undefined),
    getDb: () => db,
    inspectLock: overrides.inspectLock ?? (async () => null),
    status: overrides.status ?? (async () => []),
  };
}

const check = (report, name) => report.checks.find((entry) => entry.name === name);

describe('runAudit (mocked deps)', () => {
  it('should pass every check on a healthy setup', async () => {
    const report = await runAudit(makeDeps());
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.failed, 0);
    for (const name of ['config', 'connection', 'transactions', 'indexes', 'lock', 'checksums']) {
      assert.strictEqual(check(report, name)?.status, 'pass', name);
    }
  });

  it('should stop at the config check when configuration fails', async () => {
    const report = await runAudit(
      makeDeps({
        ensureConfig: async () => {
          throw new Error('bad config');
        },
      }),
    );
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.checks.length, 1);
    assert.strictEqual(check(report, 'config').status, 'fail');
  });

  it('should report a connection failure as a check, not a crash', async () => {
    const report = await runAudit(
      makeDeps({
        connect: async () => {
          throw new Error('mongodb://user:secret@host refused');
        },
      }),
    );
    assert.strictEqual(report.ok, false);
    assert.strictEqual(check(report, 'connection').status, 'fail');
    // Redacted through errorText — a driver message echoing the URI must not
    // leak the password into the report.
    assert.ok(!check(report, 'connection').detail.includes('secret'));
  });

  it('should note an injected client on the connection check', async () => {
    const report = await runAudit(makeDeps({ config: { client: {} } }));
    assert.match(check(report, 'connection').detail, /injected client/);
  });

  it('should fail transactions on a standalone server with useTransaction on', async () => {
    const report = await runAudit(
      makeDeps({ config: { useTransaction: true }, hello: async () => ({}) }),
    );
    assert.strictEqual(check(report, 'transactions').status, 'fail');
    assert.strictEqual(report.ok, false);
  });

  it('should warn about a standalone server when useTransaction is off', async () => {
    const report = await runAudit(makeDeps({ hello: async () => ({}) }));
    assert.strictEqual(check(report, 'transactions').status, 'warn');
    assert.strictEqual(report.ok, true);
  });

  it('should recognize a sharded cluster as transaction-capable', async () => {
    const report = await runAudit(makeDeps({ hello: async () => ({ msg: 'isdbgrid' }) }));
    assert.strictEqual(check(report, 'transactions').status, 'pass');
  });

  it('should warn (not fail) when the topology cannot be determined', async () => {
    const report = await runAudit(
      makeDeps({
        hello: async () => {
          throw new Error('unauthorized');
        },
      }),
    );
    assert.strictEqual(check(report, 'transactions').status, 'warn');
  });

  it('should warn about missing indexes by name', async () => {
    const report = await runAudit(
      makeDeps({ indexes: async () => [{ name: '_id_' }, { name: 'name_unique' }] }),
    );
    const indexes = check(report, 'indexes');
    assert.strictEqual(indexes.status, 'warn');
    assert.match(indexes.detail, /status_appliedAt_name/);
  });

  it('should warn when indexes cannot be read', async () => {
    const report = await runAudit(
      makeDeps({
        indexes: async () => {
          throw new Error('unauthorized');
        },
      }),
    );
    assert.strictEqual(check(report, 'indexes').status, 'warn');
  });

  it('should pass a fresh lock and warn about a stale one', async () => {
    const fresh = await runAudit(
      makeDeps({
        inspectLock: async () => ({ lockedAt: new Date(), pid: 1, host: 'h', executedBy: 'u' }),
      }),
    );
    assert.strictEqual(check(fresh, 'lock').status, 'pass');

    const stale = await runAudit(
      makeDeps({
        inspectLock: async () => ({
          lockedAt: new Date(Date.now() - 120_000),
          pid: 1,
          host: 'h',
          executedBy: 'u',
        }),
      }),
    );
    const lock = check(stale, 'lock');
    assert.strictEqual(lock.status, 'warn');
    assert.match(lock.detail, /past its TTL/);
  });

  it('should warn when the lock cannot be read', async () => {
    const report = await runAudit(
      makeDeps({
        inspectLock: async () => {
          throw new Error('unauthorized');
        },
      }),
    );
    assert.strictEqual(check(report, 'lock').status, 'warn');
  });

  it('should fail on checksum drift and name the drifted files', async () => {
    const report = await runAudit(
      makeDeps({
        status: async () => [
          { file: 'a.ts', status: 'applied', checksumOk: true },
          { file: 'b.ts', status: 'applied', checksumOk: false },
        ],
      }),
    );
    const checksums = check(report, 'checksums');
    assert.strictEqual(checksums.status, 'fail');
    assert.match(checksums.detail, /b\.ts/);
    assert.strictEqual(report.ok, false);
  });

  it('should warn about pending migrations without failing the audit', async () => {
    const report = await runAudit(
      makeDeps({
        status: async () => [{ file: 'a.ts', status: 'pending', checksumOk: null }],
      }),
    );
    assert.strictEqual(check(report, 'pending').status, 'warn');
    assert.strictEqual(report.ok, true);
  });

  it('should warn when status cannot be read', async () => {
    const report = await runAudit(
      makeDeps({
        status: async () => {
          throw new Error('boom');
        },
      }),
    );
    assert.strictEqual(check(report, 'checksums').status, 'warn');
  });

  it('should count failures and warnings independently', async () => {
    const report = await runAudit(
      makeDeps({
        hello: async () => ({}),
        status: async () => [{ file: 'b.ts', status: 'applied', checksumOk: false }],
      }),
    );
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.failed, 1);
    assert.ok(report.warnings >= 1);
  });
});

describe('runAudit — Atlas Search', () => {
  const serverError = (code, message) => Object.assign(new Error(message), { code });
  const declared = (...names) =>
    names.map((name) => ({
      name,
      searchIndexes: [{ name: 'default', type: 'search', definition: { mappings: {} } }],
    }));

  /** Healthy deps whose database also answers the search probe */
  function searchDeps({ definitions, listed = {}, listError, config = {}, version = [8, 0, 4] }) {
    const deps = makeDeps({ config });
    const base = deps.getDb();
    const db = {
      ...base,
      admin: () => ({
        command: async (command) => {
          if (command.buildInfo) return { versionArray: [...version, 0] };
          return { setName: 'rs0' };
        },
      }),
      collection: (name) => ({
        ...base.collection(name),
        aggregate: () => ({
          toArray: async () => {
            if (listError) throw listError;
            return listed[name] ?? [];
          },
        }),
      }),
    };
    return { ...deps, getDb: () => db, definitions };
  }

  it('should record nothing when no definition declares search indexes', async () => {
    for (const definitions of [
      undefined,
      async () => [{ name: 'users', indexes: [] }],
      async () => {
        throw new Error('broken definition file');
      },
    ]) {
      const report = await runAudit(searchDeps({ definitions }));
      assert.strictEqual(check(report, 'search'), undefined);
      assert.strictEqual(report.ok, true);
    }
  });

  it('should pass where Search is available', async () => {
    const report = await runAudit(
      searchDeps({ definitions: async () => declared('movies', 'shows') }),
    );
    assert.deepStrictEqual(check(report, 'search'), {
      name: 'search',
      status: 'pass',
      detail: 'Available — 2 search index(es) declared in 2 collection(s)',
    });
  });

  it('should warn about a declared search index that failed to build', async () => {
    const report = await runAudit(
      searchDeps({
        definitions: async () => declared('movies'),
        listed: {
          movies: [
            { name: 'default', status: 'FAILED', queryable: false, message: 'too many fields' },
            { name: 'other', status: 'FAILED', queryable: false },
          ],
        },
      }),
    );
    assert.strictEqual(check(report, 'search').status, 'warn');
    assert.strictEqual(
      check(report, 'search').detail,
      'Available — failed to build: movies.default (too many fields)',
    );
  });

  it('should warn about a declared search index that went stale', async () => {
    const report = await runAudit(
      searchDeps({
        definitions: async () => declared('movies'),
        listed: { movies: [{ name: 'default', status: 'STALE', queryable: true }] },
      }),
    );
    assert.strictEqual(check(report, 'search').status, 'warn');
    assert.strictEqual(
      check(report, 'search').detail,
      'Available — stale (not replicating): movies.default',
    );
  });

  it('should fail where Search is missing and converge would refuse', async () => {
    const report = await runAudit(
      searchDeps({
        definitions: async () => declared('movies'),
        listError: serverError(31082, 'requires additional configuration'),
      }),
    );
    assert.strictEqual(report.ok, false);
    assert.strictEqual(check(report, 'search').status, 'fail');
    assert.match(
      check(report, 'search').detail,
      /Not available on this server .*converge refuses them: use Atlas/,
    );
  });

  it("should only warn where Search is missing and onSearchUnavailable is 'skip'", async () => {
    const report = await runAudit(
      searchDeps({
        definitions: async () => declared('movies'),
        listError: serverError(31082, 'requires additional configuration'),
        config: { onSearchUnavailable: 'skip' },
      }),
    );
    assert.strictEqual(report.ok, true);
    assert.strictEqual(check(report, 'search').status, 'warn');
    assert.match(check(report, 'search').detail, /converge skips them/);
  });

  it('should warn when the check itself cannot run', async () => {
    const report = await runAudit(
      searchDeps({
        definitions: async () => declared('movies'),
        listError: serverError(13, 'not authorized'),
      }),
    );
    assert.strictEqual(check(report, 'search').status, 'warn');
    assert.match(check(report, 'search').detail, /Could not check Atlas Search: not authorized/);
  });

  it('should run before the runtime check', async () => {
    const report = await runAudit(searchDeps({ definitions: async () => declared('movies') }));
    const names = report.checks.map((entry) => entry.name);
    assert.ok(names.indexOf('search') < names.indexOf('runtime'));
  });
});
