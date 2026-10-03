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
function fakeDb(collections = {}, { fail = {}, reads = [] } = {}) {
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
    listCollections: (filter, options) => ({
      toArray: async () => {
        reads.push(['listCollections', options]);
        const entry = state[filter.name];
        return entry ? [{ name: filter.name, type: entry.type, options: entry.options }] : [];
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
      createIndexes: async ([spec]) => {
        const { key, ...options } = spec;
        ops.push(`createIndex ${name}.${spec.name}`);
        maybeFail('createIndexes');
        state[name] ??= {
          type: 'collection',
          options: {},
          indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }],
        };
        const plainKey = key instanceof Map ? Object.fromEntries(key) : key;
        state[name].indexes.push({ v: 2, key: plainKey, ...options });
        return [spec.name];
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
    assert.strictEqual(names.filter((event) => event === 'converge:action').length, 7);
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
      (error) => error.context.restored === false && /dbAdmin/.test(error.context.hint),
    );
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

describe('runConverge — tolerated races', () => {
  it('should set the validator on a collection created since it was read', async () => {
    const db = fakeDb({}, { fail: { createCollection: serverError(48, 'already exists') } });
    // createCollection "fails" without creating; collMod then needs the entry.
    db.state.c = { type: 'collection', options: {}, indexes: [] };
    const real = db.listCollections;
    let first = true;
    db.listCollections = (filter, options) => {
      if (first && filter.name === 'c') {
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
