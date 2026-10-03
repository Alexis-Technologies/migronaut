const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { normalizeDefinition } = require('../../src/core/collections.js');
const { READ_OPTIONS, readLiveState, runConverge } = require('../../src/core/converge.js');
const { ConvergeFailedError, RunAbortedError } = require('../../src/errors/index.js');

const serverError = (code, message = `server error ${code}`) =>
  Object.assign(new Error(message), { code });

/**
 * An in-memory stand-in for the few database calls converge makes. It stores
 * indexes the way the server reports them (`v`, a plain key object, options
 * as given), records every write in `ops`, and lets a test make any call fail.
 */
function fakeDb(collections = {}, { fail = {}, reads = [], server } = {}) {
  const state = {};
  for (const [name, spec] of Object.entries(collections)) {
    state[name] = {
      type: spec.type ?? 'collection',
      options: spec.options ?? {},
      indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }, ...(spec.indexes ?? [])],
    };
  }
  const ops = [];
  const maybeFail = (op) => {
    const failure = fail[op];
    if (typeof failure === 'function') {
      const error = failure();
      if (error) throw error;
    } else if (failure) {
      throw failure;
    }
  };
  const db = {
    state,
    ops,
    // `server`: { version: [major, minor], mongos } — absent, the fake says nothing.
    ...(server
      ? {
          admin: () => ({
            command: async (command) => {
              if (command.hello) return server.mongos ? { msg: 'isdbgrid' } : {};
              return { versionArray: [...server.version, 0, 0] };
            },
          }),
        }
      : {}),
    listCollections: (filter, options) => ({
      toArray: async () => {
        reads.push(['listCollections', options]);
        const names = typeof filter.name === 'string' ? [filter.name] : filter.name.$in;
        const found = [];
        for (const name of names) {
          const entry = state[name];
          if (entry) found.push({ name, type: entry.type, options: entry.options });
        }
        return found;
      },
    }),
    createCollection: async (name, options) => {
      ops.push(`createCollection ${name}`);
      maybeFail('createCollection');
      state[name] = {
        type: 'collection',
        options: { ...options },
        indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }],
      };
    },
    command: async (command) => {
      const { collMod, ...rest } = command;
      ops.push(`collMod ${collMod} ${rest.index ? rest.index.name : 'validator'}`);
      maybeFail('collMod');
      const entry = state[collMod];
      if (rest.index) {
        const index = entry.indexes.find((candidate) => candidate.name === rest.index.name);
        if (rest.index.unique === true) {
          maybeFail('collModUnique');
          index.unique = true;
        }
        if (rest.index.prepareUnique !== undefined) index.prepareUnique = rest.index.prepareUnique;
        if (rest.index.expireAfterSeconds !== undefined) {
          index.expireAfterSeconds = rest.index.expireAfterSeconds;
        }
        if (rest.index.hidden === true) index.hidden = true;
        if (rest.index.hidden === false) delete index.hidden;
      } else {
        const options = { ...entry.options, ...rest };
        if (Object.keys(rest.validator ?? {}).length === 0) delete options.validator;
        entry.options = options;
      }
      return { ok: 1 };
    },
    collection: (name) => ({
      listIndexes: (options) => ({
        toArray: async () => {
          reads.push(['listIndexes', options]);
          maybeFail('listIndexes');
          if (!state[name]) throw serverError(26, 'ns does not exist');
          return state[name].indexes.map((index) => ({ ...index }));
        },
      }),
      // One command, all or nothing — as the server builds several indexes.
      createIndexes: async (specs) => {
        for (const spec of specs) ops.push(`createIndex ${name}.${spec.name}`);
        maybeFail('createIndexes');
        state[name] ??= {
          type: 'collection',
          options: {},
          indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }],
        };
        for (const spec of specs) {
          const { key, ...options } = spec;
          const plainKey = key instanceof Map ? Object.fromEntries(key) : key;
          state[name].indexes.push({ v: 2, key: plainKey, ...options });
        }
        return specs.map((spec) => spec.name);
      },
      dropIndex: async (indexName) => {
        ops.push(`dropIndex ${name}.${indexName}`);
        maybeFail('dropIndex');
        const entry = state[name];
        const position = entry.indexes.findIndex((index) => index.name === indexName);
        if (position === -1) throw serverError(27, 'index not found');
        entry.indexes.splice(position, 1);
      },
    }),
  };
  return db;
}

function makeDeps(db, overrides = {}) {
  const events = [];
  const lines = [];
  const log = (level) => (message, fields) => lines.push({ level, message, fields });
  return {
    events,
    lines,
    deps: {
      db,
      logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
      fields: (extra) => ({ runId: 'run-1', ...extra }),
      emit: (event, payload) => events.push([event, payload]),
      assertNotAborted: overrides.assertNotAborted ?? (() => undefined),
    },
  };
}

const definitions = (...list) => list.map((definition) => normalizeDefinition(definition));
const statuses = (result) =>
  result.collections.flatMap((collection) =>
    collection.actions.map(
      (action) => `${collection.name}/${action.name}:${action.action}:${action.status}`,
    ),
  );

describe('readLiveState', () => {
  it('should force primary reads and plain-JavaScript BSON values', async () => {
    const reads = [];
    const db = fakeDb({ c: { indexes: [] } }, { reads });
    await readLiveState(db, 'c');
    assert.deepStrictEqual(reads, [
      ['listCollections', { nameOnly: false, ...READ_OPTIONS }],
      ['listIndexes', READ_OPTIONS],
    ]);
    assert.strictEqual(READ_OPTIONS.readPreference, 'primary');
    assert.strictEqual(READ_OPTIONS.promoteValues, true);
  });

  it('should report a missing collection, and one dropped between the two reads', async () => {
    assert.deepStrictEqual(await readLiveState(fakeDb(), 'c'), { exists: false, indexes: [] });
    const racing = fakeDb({ c: {} }, { fail: { listIndexes: serverError(26) } });
    assert.deepStrictEqual(await readLiveState(racing, 'c'), { exists: false, indexes: [] });
    const broken = fakeDb({ c: {} }, { fail: { listIndexes: serverError(13) } });
    await assert.rejects(readLiveState(broken, 'c'), (error) => error.code === 13);
  });

  it('should not list the indexes of a view', async () => {
    const live = await readLiveState(fakeDb({ v: { type: 'view' } }), 'v');
    assert.deepStrictEqual(live, { exists: true, type: 'view', options: {}, indexes: [] });
  });
});

describe('runConverge — dry run', () => {
  it('should plan without writing, emitting or taking the abort path', async () => {
    const db = fakeDb({ users: { indexes: [{ v: 2, key: { old: 1 }, name: 'old_1' }] } });
    const { deps, events, lines } = makeDeps(db, {
      assertNotAborted: () => assert.fail('a dry run is not a run'),
    });
    const result = await runConverge(
      deps,
      {
        definitions: definitions({ name: 'users', indexes: [{ key: { email: 1 } }] }),
        dryRun: true,
        prune: true,
      },
      undefined,
    );
    assert.deepStrictEqual(db.ops, []);
    assert.deepStrictEqual(events, []);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.changed, 2);
    assert.strictEqual(result.inSync, false);
    assert.deepStrictEqual(statuses(result), [
      'users/email_1:create:planned',
      'users/old_1:drop:planned',
    ]);
    assert.deepStrictEqual(
      lines.map((line) => [line.level, line.message]),
      [['info', '◎ Planned  2 change(s) in 1 of 1 collection(s)']],
    );
  });

  it('should log an in-sync probe at debug only', async () => {
    const db = fakeDb({ users: { indexes: [{ v: 2, key: { email: 1 }, name: 'email_1' }] } });
    const { deps, lines } = makeDeps(db);
    const result = await runConverge(
      deps,
      {
        definitions: definitions({ name: 'users', indexes: [{ key: { email: 1 } }] }),
        dryRun: true,
      },
      undefined,
    );
    assert.strictEqual(result.inSync, true);
    assert.deepStrictEqual(
      lines.map((line) => line.level),
      ['debug'],
    );
  });
});

describe('runConverge — a real run', () => {
  it('should carry the plan out in order and report every step', async () => {
    const db = fakeDb({
      users: {
        options: { validator: { a: 1 } },
        indexes: [
          { v: 2, key: { r: 1 }, name: 'r_1' },
          { v: 2, key: { t: 1 }, name: 't_1', expireAfterSeconds: 9 },
          { v: 2, key: { gone: 1 }, name: 'gone_1' },
        ],
      },
    });
    const { deps, events, lines } = makeDeps(db);
    const result = await runConverge(
      deps,
      {
        definitions: definitions(
          {
            name: 'users',
            indexes: [
              { key: { r: 1 }, unique: true },
              { key: { t: 1 }, expireAfterSeconds: 5 },
              { key: { n: 1 } },
            ],
            validator: { a: 2 },
            prune: true,
          },
          { name: 'orders', indexes: [{ key: { total: -1 } }] },
        ),
      },
      undefined,
    );
    assert.deepStrictEqual(db.ops, [
      'collMod users validator',
      'createIndex users.n_1',
      'collMod users t_1',
      'dropIndex users.r_1',
      'createIndex users.r_1',
      'dropIndex users.gone_1',
      'createCollection orders',
      'createIndex orders.total_-1',
    ]);
    assert.strictEqual(result.changed, 7);
    assert.strictEqual(result.inSync, true);
    assert.strictEqual(result.unstable, undefined);
    assert.ok(
      result.collections.every((collection) =>
        collection.actions.every((a) => a.status === 'applied'),
      ),
    );
    assert.ok(
      result.collections[0].actions.every((action) => typeof action.durationMs === 'number'),
    );

    const names = events.map(([event]) => event);
    assert.strictEqual(names[0], 'converge:start');
    assert.strictEqual(names.at(-1), 'converge:end');
    // Each step announced before it runs, then settled.
    const actions = events.filter(([event]) => event === 'converge:action').map(([, e]) => e);
    assert.deepStrictEqual(
      actions.map((action) => action.status),
      Array.from({ length: 7 }, () => ['started', 'applied']).flat(),
    );
    assert.deepStrictEqual(
      [actions[0].action, actions[0].name, actions[0].durationMs],
      ['modify', 'users', undefined],
    );
    assert.deepStrictEqual(events[0][1], { trigger: 'converge', collections: 2 });
    const end = events.at(-1)[1];
    assert.strictEqual(end.success, true);
    assert.strictEqual(end.result, result);
    assert.deepStrictEqual(end.counts, { modify: 2, create: 3, recreate: 1, drop: 1 });

    const messages = lines.map((line) => line.message);
    assert.ok(
      messages.includes(
        '✔ Rebuilt  index r_1 on users   [' + result.collections[0].actions[1].durationMs + 'ms]',
      ),
    );
    assert.ok(messages.some((message) => message.startsWith('✔ Modified validator users')));
    // An index build says which one it is busy with before it starts.
    assert.ok(messages.includes('… Rebuilding index r_1 on users'), messages.join(' | '));
    assert.ok(messages.includes('… Creating index total_-1 on orders'));
    const validatorLine = lines.find((line) => line.message === '… Modifying validator users');
    assert.strictEqual(validatorLine.level, 'debug', 'not a build: debug only');
    assert.ok(
      messages.some((message) =>
        message.startsWith('✔ Converged 7 change(s) in 2 of 2 collection(s)'),
      ),
    );
  });

  it('should mark rows that needed nothing as skipped and say when nothing changed', async () => {
    const db = fakeDb({
      users: {
        indexes: [
          { v: 2, key: { email: 1 }, name: 'email_1' },
          { v: 2, key: { extra: 1 }, name: 'extra_1' },
        ],
      },
    });
    const { deps, lines, events } = makeDeps(db);
    const result = await runConverge(
      deps,
      {
        definitions: definitions({ name: 'users', indexes: [{ key: { email: 1 } }] }),
        trigger: 'up',
      },
      undefined,
    );
    assert.deepStrictEqual(statuses(result), [
      'users/email_1:unchanged:skipped',
      'users/extra_1:keep:skipped',
    ]);
    assert.strictEqual(result.inSync, true);
    assert.deepStrictEqual(db.ops, []);
    assert.deepStrictEqual(
      lines.map((line) => line.message),
      [
        'Collections already match their declarations',
        '• Kept 1 undeclared index(es) — converge with prune to drop them',
      ],
    );
    assert.strictEqual(events[0][1].trigger, 'up');
  });

  it('should warn when a declared index lives on under another name', async () => {
    const db = fakeDb({ users: { indexes: [{ v: 2, key: { email: 1 }, name: 'by_email' }] } });
    const { deps, lines } = makeDeps(db);
    await runConverge(
      deps,
      { definitions: definitions({ name: 'users', indexes: [{ key: { email: 1 } }] }) },
      undefined,
    );
    const warning = lines.find((line) => line.level === 'warn');
    assert.match(warning.message, /index "email_1" exists as "by_email"/);
  });
});

describe('runConverge — refusals and failures', () => {
  it('should refuse a plan with a conflict before writing anything', async () => {
    const db = fakeDb({
      users: { indexes: [{ v: 2, key: { email: 1 }, name: 'by_email' }] },
      view: { type: 'view' },
    });
    const { deps, events } = makeDeps(db);
    await assert.rejects(
      runConverge(
        deps,
        {
          definitions: definitions(
            {
              name: 'users',
              indexes: [{ key: { email: 1 }, unique: true }, { key: { other: 1 } }],
            },
            { name: 'view', indexes: [] },
          ),
        },
        undefined,
      ),
      (error) => {
        assert.ok(error instanceof ConvergeFailedError);
        assert.strictEqual(error.context.phase, 'plan');
        assert.deepStrictEqual(
          error.context.conflicts.map((conflict) => `${conflict.collection}/${conflict.name}`),
          ['users/email_1', 'view/view'],
        );
        assert.match(error.message, /^Converge refused: 2 conflict\(s\) — users index "email_1": /);
        assert.match(error.message, /view is a view, not a regular collection$/);
        assert.deepStrictEqual(statuses(error.context.converge), [
          'users/email_1:conflict:failed',
          'users/other_1:create:skipped',
          'view/view:conflict:failed',
        ]);
        return true;
      },
    );
    assert.deepStrictEqual(db.ops, []);
    const end = events.at(-1);
    assert.strictEqual(end[0], 'converge:end');
    assert.strictEqual(end[1].success, false);
    assert.match(end[1].error, /Converge refused/);
  });

  it('should stop between steps when aborted, keeping what was applied', async () => {
    const db = fakeDb({});
    let checks = 0;
    const abort = new RunAbortedError('Stopped', { reason: 'Stopped' });
    const { deps } = makeDeps(db, {
      assertNotAborted: () => {
        checks += 1;
        if (checks === 2) throw abort;
      },
    });
    await assert.rejects(
      runConverge(
        deps,
        {
          definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 } }, { key: { b: 1 } }] }),
        },
        undefined,
      ),
      (error) => {
        assert.strictEqual(error, abort);
        assert.deepStrictEqual(statuses(error.context.converge), [
          'c/c:create:applied',
          'c/a_1:create:skipped',
          'c/b_1:create:skipped',
        ]);
        // Copy-on-write: the original context survives next to it.
        assert.strictEqual(error.context.reason, 'Stopped');
        return true;
      },
    );
    assert.deepStrictEqual(db.ops, ['createCollection c']);
  });

  it('should wrap a failed step with what usually fixes it', async () => {
    const db = fakeDb(
      { c: { indexes: [] } },
      { fail: { createIndexes: serverError(11000, 'E11000 duplicate key error') } },
    );
    const { deps, events } = makeDeps(db);
    await assert.rejects(
      runConverge(
        deps,
        { definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 }, unique: true }] }) },
        undefined,
      ),
      (error) => {
        assert.ok(error instanceof ConvergeFailedError);
        assert.strictEqual(error.cause.code, 11000);
        assert.deepStrictEqual(
          { ...error.context, converge: undefined },
          {
            phase: 'apply',
            collection: 'c',
            target: 'index',
            name: 'a_1',
            action: 'create',
            cause: 'E11000 duplicate key error',
            mongoCode: 11000,
            hint: error.context.hint,
            converge: undefined,
          },
        );
        assert.match(error.context.hint, /deduplicate/);
        assert.match(
          error.message,
          /^Could not create index "a_1" on c: E11000 .* — existing documents/,
        );
        assert.deepStrictEqual(statuses(error.context.converge), ['c/a_1:create:failed']);
        return true;
      },
    );
    const failed = events.find(
      ([event, payload]) => event === 'converge:action' && payload.status === 'failed',
    );
    assert.strictEqual(failed[1].error, 'E11000 duplicate key error');
  });

  it('should leave a non-server error without a code or hint', async () => {
    const db = fakeDb({ c: { indexes: [] } }, { fail: { collMod: new Error('socket closed') } });
    const { deps } = makeDeps(db);
    await assert.rejects(
      runConverge(
        deps,
        { definitions: definitions({ name: 'c', validator: { a: 1 } }) },
        undefined,
      ),
      (error) =>
        error.context.target === 'validator' &&
        !('mongoCode' in error.context) &&
        !('hint' in error.context) &&
        error.message === 'Could not create the validator on c: socket closed',
    );
  });

  it('should put the old index back when its replacement fails to build', async () => {
    let creates = 0;
    const db = fakeDb(
      { c: { indexes: [{ v: 2, key: { a: 1 }, name: 'a_1', ns: 'db.c' }] } },
      {
        fail: {
          createIndexes: () => {
            creates += 1;
            return creates === 1 ? serverError(11000, 'E11000') : undefined;
          },
        },
      },
    );
    const { deps } = makeDeps(db);
    await assert.rejects(
      runConverge(
        deps,
        { definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 }, unique: true }] }) },
        undefined,
      ),
      (error) =>
        error.context.action === 'recreate' &&
        error.context.restored === true &&
        error.context.dropped.join() === 'a_1' &&
        /^Could not rebuild index "a_1"/.test(error.message),
    );
    assert.deepStrictEqual(db.ops, ['dropIndex c.a_1', 'createIndex c.a_1', 'createIndex c.a_1']);
    assert.deepStrictEqual(db.state.c.indexes[1], { v: 2, key: { a: 1 }, name: 'a_1' });
  });

  it('should say so when the old index could not be put back either', async () => {
    const db = fakeDb(
      { c: { indexes: [{ v: 2, key: { a: 1 }, name: 'a_1' }] } },
      { fail: { createIndexes: serverError(13, 'not authorized') } },
    );
    const { deps } = makeDeps(db);
    await assert.rejects(
      runConverge(
        deps,
        { definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 }, unique: true }] }) },
        undefined,
      ),
      (error) =>
        error.context.restored === false &&
        /dbAdmin/.test(error.context.hint) &&
        error.context.restoreError === 'a_1: not authorized' &&
        /could not be put back \(a_1: not authorized\)/.test(error.message),
    );
  });

  it('should refuse to rebuild a unique index unless rebuildUnique says so', async () => {
    const live = { c: { indexes: [{ v: 2, key: { a: 1 }, name: 'a_1', unique: true }] } };
    const declared = { name: 'c', indexes: [{ key: { a: 1 }, unique: true, sparse: true }] };
    const refused = fakeDb(structuredClone(live));
    await assert.rejects(
      runConverge(makeDeps(refused).deps, { definitions: definitions(declared) }, undefined),
      (error) =>
        error.context.phase === 'plan' && /rebuildUnique/.test(error.context.conflicts[0].reason),
    );
    assert.deepStrictEqual(refused.ops, []);

    const allowed = fakeDb(structuredClone(live));
    const result = await runConverge(
      makeDeps(allowed).deps,
      { definitions: definitions(declared), rebuildUnique: true },
      undefined,
    );
    assert.strictEqual(result.changed, 1);
    assert.deepStrictEqual(allowed.ops, ['dropIndex c.a_1', 'createIndex c.a_1']);
  });

  it('should fail a rebuild whose drop fails, with nothing to restore', async () => {
    const db = fakeDb(
      { c: { indexes: [{ v: 2, key: { a: 1 }, name: 'a_1' }] } },
      { fail: { dropIndex: serverError(13, 'not authorized') } },
    );
    const { deps } = makeDeps(db);
    await assert.rejects(
      runConverge(
        deps,
        { definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 }, unique: true }] }) },
        undefined,
      ),
      (error) => error.context.mongoCode === 13 && !('restored' in error.context),
    );
  });
});

describe('runConverge — at scale', () => {
  it('should read every collection with one listCollections', async () => {
    const reads = [];
    const db = fakeDb({ a: { indexes: [] }, b: { indexes: [] }, c: { indexes: [] } }, { reads });
    const { deps } = makeDeps(db);
    await runConverge(
      deps,
      {
        definitions: definitions(
          { name: 'a', indexes: [] },
          { name: 'b', indexes: [] },
          { name: 'c', indexes: [] },
          { name: 'missing', indexes: [] },
        ),
        dryRun: true,
      },
      undefined,
    );
    assert.strictEqual(reads.filter(([read]) => read === 'listCollections').length, 1);
    assert.strictEqual(reads.filter(([read]) => read === 'listIndexes').length, 3);
  });

  it('should build the new indexes of a collection in one command', async () => {
    const db = fakeDb({ c: { indexes: [] } });
    const calls = [];
    const collection = db.collection;
    db.collection = (name) => {
      const handle = collection(name);
      return {
        ...handle,
        createIndexes: (specs) => {
          calls.push(specs.map((spec) => spec.name));
          return handle.createIndexes(specs);
        },
      };
    };
    const { deps, events } = makeDeps(db);
    const result = await runConverge(
      deps,
      {
        definitions: definitions({
          name: 'c',
          indexes: [{ key: { a: 1 } }, { key: { b: 1 } }, { key: { c: 1 } }],
        }),
      },
      undefined,
    );
    assert.deepStrictEqual(calls, [['a_1', 'b_1', 'c_1']]);
    assert.strictEqual(result.changed, 3);
    const applied = events.filter(
      ([event, e]) => event === 'converge:action' && e.status === 'applied',
    );
    assert.strictEqual(applied.length, 3, 'every row still settles on its own');
  });

  it('should fail every index of a batch the server refused, naming them all', async () => {
    const db = fakeDb(
      { c: { indexes: [] } },
      { fail: { createIndexes: serverError(67, 'cannot create index') } },
    );
    const { deps } = makeDeps(db);
    await assert.rejects(
      runConverge(
        deps,
        {
          definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 } }, { key: { b: 1 } }] }),
        },
        undefined,
      ),
      (error) => {
        assert.match(error.message, /Could not create indexes "a_1", "b_1" on c/);
        const statuses = error.context.converge.collections[0].actions.map((a) => a.status);
        assert.deepStrictEqual(statuses, ['failed', 'failed']);
        return true;
      },
    );
  });

  it('should not put an index back after the connection broke mid-rebuild', async () => {
    const lost = Object.assign(new Error('connection timed out'), {
      name: 'MongoNetworkTimeoutError',
    });
    const db = fakeDb(
      { c: { indexes: [{ v: 2, key: { a: 1 }, name: 'a_1' }] } },
      { fail: { createIndexes: lost } },
    );
    const { deps } = makeDeps(db);
    await assert.rejects(
      runConverge(
        deps,
        { definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 }, unique: true }] }) },
        undefined,
      ),
      (error) => {
        // The server may still be building: a restore would race it.
        assert.strictEqual(error.context.restored, false);
        assert.strictEqual(error.context.uncertain, true);
        assert.match(error.message, /connection failed mid-build/);
        return true;
      },
    );
    assert.deepStrictEqual(db.ops, ['dropIndex c.a_1', 'createIndex c.a_1']);
  });
});

describe('runConverge — in place, by server version', () => {
  const nonUnique = () => ({ c: { indexes: [{ v: 2, key: { a: 1 }, name: 'a_1' }] } });
  const declareUnique = () =>
    definitions({ name: 'c', indexes: [{ key: { a: 1 }, unique: true }] });

  it('should make an index unique in place on 7.0+, with prepareUnique first', async () => {
    const db = fakeDb(nonUnique(), { server: { version: [7, 0] } });
    const { deps } = makeDeps(db);
    const result = await runConverge(deps, { definitions: declareUnique() }, undefined);
    assert.deepStrictEqual(db.ops, ['collMod c a_1', 'collMod c a_1']);
    assert.strictEqual(result.collections[0].actions[0].action, 'modify');
    assert.strictEqual(db.state.c.indexes[1].unique, true);
  });

  it('should rebuild instead on an older or unknown server', async () => {
    // 6.0 has the commands but did not enforce the converted index in our tests.
    for (const server of [{ version: [6, 0] }, { version: [5, 0] }, undefined]) {
      const db = fakeDb(nonUnique(), server ? { server } : {});
      const { deps } = makeDeps(db);
      await runConverge(deps, { definitions: declareUnique() }, undefined);
      assert.deepStrictEqual(db.ops, ['dropIndex c.a_1', 'createIndex c.a_1']);
    }
  });

  it('should take prepareUnique back off when the data holds duplicates', async () => {
    const db = fakeDb(nonUnique(), {
      server: { version: [7, 0] },
      fail: { collModUnique: serverError(359, 'Cannot convert the index to unique') },
    });
    const { deps } = makeDeps(db);
    await assert.rejects(
      runConverge(deps, { definitions: declareUnique() }, undefined),
      (error) => error.context.mongoCode === 359 && /deduplicate/.test(error.context.hint),
    );
    assert.deepStrictEqual(db.ops, ['collMod c a_1', 'collMod c a_1', 'collMod c a_1']);
    assert.strictEqual(db.state.c.indexes[1].prepareUnique, false);
    assert.strictEqual(db.state.c.indexes[1].unique, undefined);
  });

  it('should add a TTL in place on 5.1+, single-field indexes only', async () => {
    const db = fakeDb(
      {
        c: {
          indexes: [
            { v: 2, key: { t: 1 }, name: 't_1' },
            { v: 2, key: { a: 1, t: 1 }, name: 'a_1_t_1' },
          ],
        },
      },
      { server: { version: [5, 1] } },
    );
    const { deps } = makeDeps(db);
    await runConverge(
      deps,
      {
        definitions: definitions({
          name: 'c',
          indexes: [
            { key: { t: 1 }, expireAfterSeconds: 60 },
            { key: { a: 1, t: 1 }, expireAfterSeconds: 60 },
          ],
        }),
      },
      undefined,
    );
    assert.deepStrictEqual(db.ops, [
      'collMod c t_1',
      'dropIndex c.a_1_t_1',
      'createIndex c.a_1_t_1',
    ]);
  });
});

describe('runConverge — sharded clusters', () => {
  it('should keep the index that backs a shard key when it can read the key', async () => {
    const db = fakeDb(
      { c: { indexes: [{ v: 2, key: { tenant: 1, at: 1 }, name: 'tenant_1_at_1' }] } },
      { server: { version: [7, 0], mongos: true } },
    );
    const { deps, lines } = makeDeps(db);
    deps.shardKeyOf = async () => ({ tenant: 1 });
    const result = await runConverge(
      deps,
      { definitions: definitions({ name: 'c', indexes: [], prune: true }) },
      undefined,
    );
    assert.deepStrictEqual(db.ops, []);
    assert.deepStrictEqual(
      result.collections[0].actions.map((a) => [a.name, a.action, a.reason]),
      [['tenant_1_at_1', 'keep', 'backs the shard key']],
    );
    // Kept under prune — "converge with prune to drop them" would be wrong advice.
    assert.ok(!lines.some((line) => /prune to drop/.test(line.message)));
  });

  it('should keep it, with a warning, when the server refuses the drop', async () => {
    const db = fakeDb(
      { c: { indexes: [{ v: 2, key: { tenant: 1 }, name: 'tenant_1' }] } },
      {
        server: { version: [7, 0], mongos: true },
        fail: { dropIndex: serverError(72, 'cannot drop index tenant_1: it backs the shard key') },
      },
    );
    const { deps, lines } = makeDeps(db);
    // config.collections not readable.
    deps.shardKeyOf = async () => {
      throw serverError(13, 'not authorized');
    };
    const result = await runConverge(
      deps,
      { definitions: definitions({ name: 'c', indexes: [], prune: true }) },
      undefined,
    );
    const [row] = result.collections[0].actions;
    assert.deepStrictEqual([row.action, row.status], ['keep', 'skipped']);
    assert.ok(lines.some((line) => line.level === 'warn' && /shard key/.test(line.message)));
    assert.ok(!lines.some((line) => /prune to drop/.test(line.message)));
    assert.strictEqual(result.unstable, undefined, 'kept on purpose, not unstable');
  });
});

describe('runConverge — history', () => {
  const withRecorder = (db, record) => {
    const made = makeDeps(db);
    made.deps.audit = () => ({ runId: 'run-1', executedBy: 'ci', host: 'h', environment: 'test' });
    made.deps.record = record;
    return made;
  };

  it('should record a converge that changed something, with who, why and every row', async () => {
    const entries = [];
    const { deps } = withRecorder(fakeDb({ c: { indexes: [] } }), async (entry) =>
      entries.push(entry),
    );
    await runConverge(
      deps,
      {
        definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 } }] }),
        requestedBy: 'alice',
        reason: 'TICKET-7',
      },
      undefined,
    );
    const [entry] = entries;
    assert.strictEqual(entry.success, true);
    assert.strictEqual(entry.trigger, 'converge');
    assert.deepStrictEqual([entry.requestedBy, entry.reason], ['alice', 'TICKET-7']);
    assert.deepStrictEqual([entry.runId, entry.executedBy, entry.host], ['run-1', 'ci', 'h']);
    assert.strictEqual(entry.changed, 1);
    assert.deepStrictEqual(
      entry.actions.map((a) => [a.collection, a.name, a.action, a.status]),
      [['c', 'a_1', 'create', 'applied']],
    );
    assert.deepStrictEqual(entry.actions[0].to, { key: { a: 1 }, name: 'a_1' });
    assert.ok(entry.finishedAt >= entry.startedAt);
  });

  it('should record a failed converge, and nothing for one that found everything in place', async () => {
    const entries = [];
    const record = async (entry) => entries.push(entry);
    const failing = withRecorder(
      fakeDb({ c: { indexes: [] } }, { fail: { createIndexes: serverError(13, 'denied') } }),
      record,
    );
    await assert.rejects(
      runConverge(
        failing.deps,
        { definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 } }] }) },
        undefined,
      ),
    );
    assert.strictEqual(entries[0].success, false);
    assert.match(entries[0].error, /denied/);
    assert.strictEqual(entries[0].actions[0].status, 'failed');

    const quiet = withRecorder(
      fakeDb({ c: { indexes: [{ v: 2, key: { a: 1 }, name: 'a_1' }] } }),
      record,
    );
    await runConverge(
      quiet.deps,
      { definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 } }] }) },
      undefined,
    );
    assert.strictEqual(entries.length, 1, 'an in-sync converge is not news');
  });

  it('should warn, not fail, when the history cannot be written', async () => {
    const { deps, lines } = withRecorder(fakeDb({ c: { indexes: [] } }), async () => {
      throw new Error('history collection not writable');
    });
    const result = await runConverge(
      deps,
      { definitions: definitions({ name: 'c', indexes: [{ key: { a: 1 } }] }) },
      undefined,
    );
    assert.strictEqual(result.changed, 1);
    assert.ok(lines.some((line) => line.level === 'warn' && /history/.test(line.message)));
  });
});

describe('runConverge — re-planned before each collection', () => {
  it('should stop before a collection that changed meanwhile into a conflict', async () => {
    const db = fakeDb({ a: { indexes: [] }, b: { indexes: [] } });
    // While a's index builds, someone creates an index b's declaration collides with.
    const collection = db.collection;
    db.collection = (name) => {
      const handle = collection(name);
      if (name !== 'a') return handle;
      return {
        ...handle,
        createIndexes: async (specs) => {
          db.state.b.indexes.push({ v: 2, key: { e: 1 }, name: 'by_e' });
          return handle.createIndexes(specs);
        },
      };
    };
    const { deps } = makeDeps(db);
    await assert.rejects(
      runConverge(
        deps,
        {
          definitions: definitions(
            { name: 'a', indexes: [{ key: { x: 1 } }] },
            { name: 'b', indexes: [{ key: { e: 1 }, unique: true }] },
          ),
        },
        undefined,
      ),
      (error) => {
        assert.ok(error instanceof ConvergeFailedError);
        assert.strictEqual(error.context.phase, 'replan');
        assert.strictEqual(error.context.collection, 'b');
        assert.deepStrictEqual(
          error.context.introduced.map((row) => [row.name, row.action]),
          [['e_1', 'conflict']],
        );
        return true;
      },
    );
    assert.deepStrictEqual(db.ops, ['createIndex a.x_1'], 'b was not touched');
  });

  it('should carry on when a collection only needs less than planned', async () => {
    const db = fakeDb({ a: { indexes: [] }, b: { indexes: [] } });
    const collection = db.collection;
    db.collection = (name) => {
      const handle = collection(name);
      if (name !== 'a') return handle;
      return {
        ...handle,
        createIndexes: async (specs) => {
          // Someone else built b's declared index already.
          db.state.b.indexes.push({ v: 2, key: { e: 1 }, name: 'e_1' });
          return handle.createIndexes(specs);
        },
      };
    };
    const { deps } = makeDeps(db);
    const result = await runConverge(
      deps,
      {
        definitions: definitions(
          { name: 'a', indexes: [{ key: { x: 1 } }] },
          { name: 'b', indexes: [{ key: { e: 1 } }] },
        ),
      },
      undefined,
    );
    assert.deepStrictEqual(db.ops, ['createIndex a.x_1']);
    assert.strictEqual(result.collections[1].actions[0].action, 'unchanged');
    assert.strictEqual(result.changed, 1);
  });
});

describe('runConverge — warnings', () => {
  it('should say out loud that indexes: [] with prune drops every index', async () => {
    const db = fakeDb({ c: { indexes: [{ v: 2, key: { a: 1 }, name: 'a_1' }] } });
    const { deps, lines } = makeDeps(db);
    await runConverge(
      deps,
      { definitions: definitions({ name: 'c', indexes: [], prune: true }), dryRun: true },
      undefined,
    );
    const warning = lines.find((line) => line.level === 'warn');
    assert.match(warning.message, /indexes: \[\] with prune drops every index but _id \(a_1\)/);
  });
});

describe('runConverge — tolerated races', () => {
  it('should set the validator on a collection created since it was read', async () => {
    const db = fakeDb({}, { fail: { createCollection: serverError(48, 'already exists') } });
    // createCollection "fails" without creating; collMod then needs the entry.
    db.state.c = { type: 'collection', options: {}, indexes: [] };
    const real = db.listCollections;
    let first = true;
    db.listCollections = (filter, options) => {
      if (first) {
        first = false;
        return { toArray: async () => [] };
      }
      return real(filter, options);
    };
    const { deps } = makeDeps(db);
    const result = await runConverge(
      deps,
      { definitions: definitions({ name: 'c', validator: { a: 1 } }) },
      undefined,
    );
    assert.deepStrictEqual(db.ops, ['createCollection c', 'collMod c validator']);
    assert.strictEqual(result.inSync, true);
  });

  it('should treat an index that is already gone as dropped', async () => {
    const db = fakeDb({ c: { indexes: [{ v: 2, key: { x: 1 }, name: 'x_1' }] } });
    const dropIndex = db.collection('c').dropIndex;
    const original = db.collection;
    db.collection = (name) => ({
      ...original(name),
      dropIndex: async (indexName) => {
        await dropIndex(indexName);
        throw serverError(27, 'index not found');
      },
    });
    const { deps } = makeDeps(db);
    const result = await runConverge(
      deps,
      { definitions: definitions({ name: 'c', indexes: [], prune: true }) },
      undefined,
    );
    assert.deepStrictEqual(statuses(result), ['c/x_1:drop:applied']);
  });
});

describe('runConverge — the fixed-point check', () => {
  it('should report what still differs after being applied, instead of looping', async () => {
    const db = fakeDb({
      c: { indexes: [{ v: 2, key: { t: 1 }, name: 't_1', expireAfterSeconds: 9 }] },
    });
    // A server that acknowledges the TTL change but keeps the old value.
    db.command = async (spec) => {
      db.ops.push(`collMod ${spec.collMod} ignored`);
      return { ok: 1 };
    };
    const { deps, lines } = makeDeps(db);
    const result = await runConverge(
      deps,
      {
        definitions: definitions({
          name: 'c',
          indexes: [{ key: { t: 1 }, expireAfterSeconds: 5 }],
        }),
      },
      undefined,
    );
    assert.deepStrictEqual(result.unstable, [
      {
        collection: 'c',
        target: 'index',
        name: 't_1',
        action: 'modify',
        reason: 'expireAfterSeconds',
      },
    ]);
    assert.strictEqual(result.inSync, false);
    assert.strictEqual(result.changed, 1);
    assert.ok(
      lines.some(
        (line) => line.level === 'warn' && /would change again on every run/.test(line.message),
      ),
    );
  });
});
