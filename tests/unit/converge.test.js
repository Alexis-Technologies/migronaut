const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { normalizeDefinition } = require('../../src/core/collections.js');
const { readLiveState, runConverge } = require('../../src/core/converge.js');
const { READ_OPTIONS } = require('../../src/core/server-info.js');
const { ConvergeFailedError, RunAbortedError } = require('../../src/errors/index.js');

const serverError = (code, message = `server error ${code}`) =>
  Object.assign(new Error(message), { code });

/** A search index as the fake stores it: what `$listSearchIndexes` is built from */
const searchIndex = (name, definition, fields = {}) => ({
  name,
  type: Array.isArray(definition.fields) ? 'vectorSearch' : 'search',
  definition,
  status: 'READY',
  queryable: true,
  version: 0,
  ...fields,
});

/**
 * An in-memory stand-in for the few database calls converge makes. It stores
 * indexes the way the server reports them (`v`, a plain key object, options
 * as given), records every write in `ops`, and lets a test make any call fail.
 *
 * Search, when `search` is set: `'atlas'` (the commands work; `parameter`
 * answers getParameter), `{ unavailable: code }` (every search call fails
 * like a plain mongod), or `'empty'` (lists answer `[]`, commands fail — a
 * plain mongod of 7.0). `lag` makes the first read after a search write stale,
 * `normalize` is what the server does to a stored definition, `readyAfter`
 * how many list reads a created or updated index takes to become READY.
 */
function fakeDb(
  collections = {},
  {
    fail = {},
    reads = [],
    server,
    search,
    parameter = 'localhost:27027',
    lag = 0,
    normalize = (definition) => definition,
    readyAfter,
  } = {},
) {
  const state = {};
  for (const [name, spec] of Object.entries(collections)) {
    state[name] = {
      type: spec.type ?? 'collection',
      options: spec.options ?? {},
      indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }, ...(spec.indexes ?? [])],
      searchIndexes: (spec.searchIndexes ?? []).map((index) => ({ ...index })),
    };
  }
  const unavailable = () =>
    search === 'empty'
      ? serverError(59, "no such command: 'createSearchIndexes'")
      : serverError(search.unavailable, search.message ?? 'Search is not enabled');
  const listed = (index) => ({
    id: `id-${index.name}`,
    name: index.name,
    ...(index.hideType ? {} : { type: index.type }),
    status: index.status,
    queryable: index.queryable,
    latestDefinitionVersion: { version: index.version },
    latestDefinition: index.definition,
    ...(index.message ? { message: index.message } : {}),
  });
  // Stale reads: the list a collection showed before its last search write.
  const stale = new Map();
  const searchWrite = (name) => {
    if (lag > 0) stale.set(name, { left: lag, snapshot: state[name].searchIndexes.map(listed) });
  };
  const listSearch = (name) => {
    const entry = stale.get(name);
    if (entry && entry.left > 0) {
      entry.left -= 1;
      return entry.snapshot;
    }
    const indexes = state[name]?.searchIndexes ?? [];
    for (const index of indexes) {
      if (index.pendingReads === undefined) continue;
      index.pendingReads -= 1;
      if (index.pendingReads <= 0) {
        index.status = 'READY';
        index.queryable = true;
        delete index.pendingReads;
      }
    }
    return indexes.map(listed);
  };
  const building = () => ({
    status: 'PENDING',
    queryable: false,
    ...(readyAfter !== undefined ? { pendingReads: readyAfter } : {}),
  });
  const searchCommand = (command) => {
    if (search !== 'atlas') throw unavailable();
    if (command.createSearchIndexes !== undefined) {
      const name = command.createSearchIndexes;
      for (const spec of command.indexes) ops.push(`createSearchIndex ${name}.${spec.name}`);
      maybeFail('createSearchIndexes');
      if (!state[name]) throw serverError(26, `Collection ${name} does not exist`);
      searchWrite(name);
      for (const spec of command.indexes) {
        state[name].searchIndexes.push({
          name: spec.name,
          type: spec.type ?? 'search',
          definition: normalize(spec.definition),
          version: 0,
          ...building(),
        });
      }
      return { ok: 1, indexesCreated: command.indexes.map((spec) => ({ name: spec.name })) };
    }
    if (command.updateSearchIndex !== undefined) {
      const name = command.updateSearchIndex;
      ops.push(
        `updateSearchIndex ${name}.${command.name}${command.type ? ` (${command.type})` : ''}`,
      );
      maybeFail('updateSearchIndex');
      const index = state[name].searchIndexes.find((candidate) => candidate.name === command.name);
      searchWrite(name);
      index.definition = normalize(command.definition);
      index.version += 1;
      if (readyAfter !== undefined) {
        index.status = 'BUILDING';
        index.pendingReads = readyAfter;
      }
      return { ok: 1 };
    }
    const name = command.dropSearchIndex;
    ops.push(`dropSearchIndex ${name}.${command.name}`);
    maybeFail('dropSearchIndex');
    const indexes = state[name]?.searchIndexes ?? [];
    const position = indexes.findIndex((index) => index.name === command.name);
    if (position === -1) throw serverError(27, 'index not found');
    searchWrite(name);
    indexes.splice(position, 1);
    return { ok: 1 };
  };
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
    ...(server || search
      ? {
          admin: () => ({
            command: async (command) => {
              if (command.getParameter) {
                reads.push(['getParameter']);
                if (typeof parameter === 'number') throw serverError(parameter, 'getParameter');
                return { searchIndexManagementHostAndPort: parameter, ok: 1 };
              }
              if (!server) throw serverError(13, 'not authorized');
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
        searchIndexes: [],
      };
    },
    command: async (command) => {
      if (
        command.createSearchIndexes !== undefined ||
        command.updateSearchIndex !== undefined ||
        command.dropSearchIndex !== undefined
      ) {
        return searchCommand(command);
      }
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
      aggregate: (pipeline, options) => ({
        toArray: async () => {
          reads.push(['aggregate', name, options]);
          assert.deepStrictEqual(pipeline, [{ $listSearchIndexes: {} }]);
          maybeFail('listSearchIndexes');
          if (search === undefined) throw new Error('this fake has no search');
          if (search === 'empty') return [];
          if (search !== 'atlas') throw unavailable();
          return listSearch(name);
        },
      }),
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
          searchIndexes: [],
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
      sleep: overrides.sleep ?? (async () => undefined),
      ...(overrides.now ? { now: overrides.now } : {}),
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

describe('runConverge — search indexes', () => {
  const DYNAMIC = { mappings: { dynamic: true } };
  const VECTOR = {
    fields: [{ type: 'vector', path: 'embedding', numDimensions: 3, similarity: 'cosine' }],
  };
  const run = (deps, list, options = {}) =>
    runConverge(deps, { definitions: definitions(...list), ...options }, undefined);
  const rowsOf = (result) =>
    result.collections.flatMap((collection) =>
      collection.actions.map(
        (action) => `${collection.name}:${action.target}:${action.name}:${action.action}`,
      ),
    );

  it('should make no search call at all when no definition declares search indexes', async () => {
    const reads = [];
    const db = fakeDb({ c: { indexes: [] } }, { reads, search: 'atlas' });
    const { deps } = makeDeps(db);
    const result = await run(deps, [{ name: 'c', indexes: [{ key: { a: 1 } }] }]);
    assert.ok(!reads.some(([kind]) => kind === 'aggregate' || kind === 'getParameter'));
    assert.ok(!('search' in result), 'no search summary without declared search indexes');
  });

  it('should create search indexes — on a missing collection too — and say they are building', async () => {
    const db = fakeDb({ movies: {} }, { search: 'atlas' });
    const { deps, events, lines } = makeDeps(db);
    const result = await run(deps, [
      {
        name: 'movies',
        searchIndexes: [
          { definition: DYNAMIC },
          { name: 'plot', type: 'vectorSearch', definition: VECTOR },
        ],
      },
      { name: 'shows', searchIndexes: [{ definition: DYNAMIC }] },
    ]);
    assert.deepStrictEqual(db.ops, [
      'createSearchIndex movies.default',
      'createSearchIndex movies.plot',
      'createCollection shows',
      'createSearchIndex shows.default',
    ]);
    assert.strictEqual(db.state.movies.searchIndexes[1].type, 'vectorSearch');
    assert.strictEqual(result.changed, 4);
    assert.strictEqual(result.inSync, true, 'a build under way is not drift');
    assert.deepStrictEqual(result.collections[0].actions[0].build, {
      status: 'PENDING',
      queryable: false,
    });
    assert.deepStrictEqual(result.search, {
      available: true,
      evidence: 'parameter',
      notReady: [
        { collection: 'movies', name: 'default', status: 'PENDING', queryable: false },
        { collection: 'movies', name: 'plot', status: 'PENDING', queryable: false },
        { collection: 'shows', name: 'default', status: 'PENDING', queryable: false },
      ],
    });
    const applied = events.filter(
      ([event, payload]) => event === 'converge:action' && payload.status === 'applied',
    );
    assert.deepStrictEqual(
      applied.map(([, payload]) => `${payload.target}:${payload.name}`),
      ['searchIndex:default', 'searchIndex:plot', 'collection:shows', 'searchIndex:default'],
    );
    assert.ok(
      lines.some((line) =>
        /Created {2}search index default on movies .*building on the server/.test(line.message),
      ),
    );
    assert.ok(lines.some((line) => /3 search index\(es\) still building/.test(line.message)));
  });

  it('should update in place without a type, and restate the type only when the server asks', async () => {
    const db = fakeDb(
      {
        movies: {
          searchIndexes: [
            searchIndex('default', { mappings: { dynamic: false } }, { version: 2 }),
            searchIndex('plot', VECTOR),
          ],
        },
      },
      {
        search: 'atlas',
        fail: {
          updateSearchIndex: () =>
            db.ops.at(-1) === 'updateSearchIndex movies.plot'
              ? serverError(8, '"userCommand.mappings" is required')
              : undefined,
        },
      },
    );
    const { deps } = makeDeps(db);
    const result = await run(deps, [
      {
        name: 'movies',
        searchIndexes: [
          { definition: DYNAMIC },
          {
            name: 'plot',
            type: 'vectorSearch',
            definition: { fields: [{ ...VECTOR.fields[0], similarity: 'dotProduct' }] },
          },
        ],
      },
    ]);
    assert.deepStrictEqual(db.ops, [
      'updateSearchIndex movies.default',
      'updateSearchIndex movies.plot',
      'updateSearchIndex movies.plot (vectorSearch)',
    ]);
    assert.deepStrictEqual(rowsOf(result), [
      'movies:searchIndex:default:modify',
      'movies:searchIndex:plot:modify',
    ]);
    assert.strictEqual(result.collections[0].actions[0].reason, 'mappings.dynamic');
    assert.strictEqual(db.state.movies.searchIndexes[0].version, 3);
  });

  it('should drop an undeclared search index under prune, last, and keep it otherwise', async () => {
    const collections = () => ({
      movies: {
        indexes: [{ v: 2, key: { old: 1 }, name: 'old_1' }],
        searchIndexes: [searchIndex('legacy', DYNAMIC)],
      },
    });
    const pruned = fakeDb(collections(), { search: 'atlas' });
    await run(makeDeps(pruned).deps, [
      { name: 'movies', indexes: [{ key: { a: 1 } }], searchIndexes: [], prune: true },
    ]);
    assert.deepStrictEqual(pruned.ops, [
      'createIndex movies.a_1',
      'dropIndex movies.old_1',
      'dropSearchIndex movies.legacy',
    ]);

    const kept = fakeDb(collections(), { search: 'atlas' });
    const { deps, lines } = makeDeps(kept);
    const result = await run(deps, [
      { name: 'movies', indexes: [{ key: { a: 1 } }], searchIndexes: [] },
    ]);
    assert.deepStrictEqual(kept.ops, ['createIndex movies.a_1']);
    assert.ok(rowsOf(result).includes('movies:searchIndex:legacy:keep'));
    assert.ok(
      lines.some(
        (line) =>
          line.message ===
          '• Kept 1 undeclared index(es) and 1 search index(es) — converge with prune to drop them',
      ),
    );
  });

  it('should say out loud that searchIndexes: [] with prune drops every search index', async () => {
    const db = fakeDb(
      { movies: { searchIndexes: [searchIndex('a', DYNAMIC), searchIndex('b', DYNAMIC)] } },
      { search: 'atlas' },
    );
    const { deps, lines } = makeDeps(db);
    await run(deps, [{ name: 'movies', searchIndexes: [], prune: true }], { dryRun: true });
    const warning = lines.find((line) => line.level === 'warn');
    assert.match(
      warning.message,
      /searchIndexes: \[\] with prune drops every search index \(a, b\)/,
    );
  });

  it('should refuse the whole run before any write where Search is unavailable', async () => {
    const db = fakeDb({ users: { indexes: [] }, movies: {} }, { search: { unavailable: 31082 } });
    const { deps } = makeDeps(db);
    await assert.rejects(
      run(deps, [
        { name: 'users', indexes: [{ key: { email: 1 } }] },
        { name: 'movies', searchIndexes: [{ definition: DYNAMIC }] },
      ]),
      (error) => {
        assert.ok(error instanceof ConvergeFailedError);
        assert.strictEqual(error.context.phase, 'plan');
        assert.deepStrictEqual(
          error.context.conflicts.map((conflict) => [conflict.collection, conflict.target]),
          [['movies', 'searchIndex']],
        );
        assert.match(error.context.hint, /mongodb-atlas-local.*onSearchUnavailable: 'skip'/);
        assert.match(error.message, /Atlas Search is not available on this server — use Atlas/);
        assert.strictEqual(error.context.converge.search.available, false);
        return true;
      },
    );
    assert.deepStrictEqual(db.ops, [], 'nothing written, in any collection');
  });

  it('should show the refusal in a dry run without throwing', async () => {
    const db = fakeDb({ movies: {} }, { search: { unavailable: 115 } });
    const result = await run(
      makeDeps(db).deps,
      [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }],
      {
        dryRun: true,
      },
    );
    assert.deepStrictEqual(rowsOf(result), ['movies:searchIndex:default:conflict']);
    assert.strictEqual(result.inSync, false);
    assert.deepStrictEqual(result.search, { available: false, evidence: 'error', notReady: [] });
  });

  it("should converge everything else and skip search indexes with onSearchUnavailable: 'skip'", async () => {
    const db = fakeDb({ movies: { indexes: [] } }, { search: { unavailable: 31082 } });
    const { deps, lines } = makeDeps(db);
    const result = await run(
      deps,
      [
        {
          name: 'movies',
          indexes: [{ key: { title: 1 } }],
          searchIndexes: [
            { definition: DYNAMIC },
            { name: 'plot', type: 'vectorSearch', definition: VECTOR },
          ],
        },
      ],
      { search: { onUnavailable: 'skip' } },
    );
    assert.deepStrictEqual(db.ops, ['createIndex movies.title_1']);
    assert.deepStrictEqual(rowsOf(result), [
      'movies:index:title_1:create',
      'movies:searchIndex:default:skip',
      'movies:searchIndex:plot:skip',
    ]);
    assert.strictEqual(result.collections[0].actions[1].status, 'skipped');
    assert.strictEqual(result.inSync, true);
    assert.ok(
      lines.some(
        (line) =>
          line.level === 'warn' &&
          /not available on this server — skipping 2 declared search index\(es\)/.test(
            line.message,
          ),
      ),
    );
  });

  it('should skip at apply time when Search turns out to be missing after all', async () => {
    // An empty list from an old server, and a server that will not say more:
    // Search is assumed — until the create is refused.
    const db = fakeDb({ movies: {}, shows: {} }, { search: 'empty', parameter: 13 });
    const { deps, lines } = makeDeps(db);
    const result = await run(
      deps,
      [
        { name: 'movies', searchIndexes: [{ definition: DYNAMIC }] },
        { name: 'shows', indexes: [{ key: { a: 1 } }], searchIndexes: [{ definition: DYNAMIC }] },
      ],
      { search: { onUnavailable: 'skip' } },
    );
    assert.deepStrictEqual(rowsOf(result), [
      'movies:searchIndex:default:skip',
      'shows:index:a_1:create',
      'shows:searchIndex:default:skip',
    ]);
    assert.deepStrictEqual(
      db.ops,
      ['createIndex shows.a_1'],
      'the second collection is not asked again',
    );
    assert.strictEqual(result.search.available, false);
    assert.ok(
      lines.some((line) =>
        /Atlas Search refused search index "default" — skipped/.test(line.message),
      ),
    );
  });

  it('should fail with the hint when the server refuses a search index in fail mode', async () => {
    const db = fakeDb({ movies: {} }, { search: 'empty', parameter: 13 });
    await assert.rejects(
      run(makeDeps(db).deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }]),
      (error) => {
        assert.strictEqual(error.context.phase, 'apply');
        assert.strictEqual(error.context.target, 'searchIndex');
        assert.strictEqual(error.context.mongoCode, 59);
        assert.match(error.message, /Could not create search index "default" on movies/);
        assert.match(error.context.hint, /onSearchUnavailable: 'skip'/);
        return true;
      },
    );
  });

  it('should leave a FAILED build with the declared definition alone, and say why', async () => {
    const db = fakeDb(
      {
        movies: {
          searchIndexes: [
            searchIndex('default', DYNAMIC, {
              status: 'FAILED',
              queryable: false,
              message: 'too many fields',
            }),
          ],
        },
      },
      { search: 'atlas' },
    );
    const { deps, lines } = makeDeps(db);
    const result = await run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }]);
    assert.deepStrictEqual(db.ops, []);
    assert.deepStrictEqual(rowsOf(result), ['movies:searchIndex:default:unchanged']);
    assert.strictEqual(result.inSync, true);
    assert.deepStrictEqual(result.search.notReady, [
      {
        collection: 'movies',
        name: 'default',
        status: 'FAILED',
        queryable: false,
        message: 'too many fields',
      },
    ]);
    assert.ok(
      lines.some(
        (line) =>
          line.level === 'warn' &&
          /search index "default" failed to build: too many fields — converge does not resubmit/.test(
            line.message,
          ),
      ),
    );
  });

  it('should read a lagging list again before calling anything unstable', async () => {
    const pauses = [];
    const db = fakeDb({ movies: {} }, { search: 'atlas', lag: 2 });
    const { deps } = makeDeps(db, { sleep: async (ms) => pauses.push(ms) });
    const result = await run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }]);
    assert.strictEqual(result.unstable, undefined);
    assert.deepStrictEqual(pauses, [250, 500]);
  });

  it('should stop re-reading a lagging list when the run is aborted', async () => {
    const db = fakeDb({ movies: {}, shows: {} }, { search: 'atlas', lag: 2 });
    let aborted = false;
    const { deps } = makeDeps(db, {
      sleep: async (ms, signal) => {
        assert.strictEqual(signal, 'the-signal', 'the pause is given the run signal');
        aborted = true;
      },
      assertNotAborted: () => {
        if (aborted) throw new RunAbortedError('Stopped', { reason: 'Stopped' });
      },
    });
    await assert.rejects(
      runConverge(
        deps,
        {
          definitions: definitions(
            { name: 'movies', searchIndexes: [{ definition: DYNAMIC }] },
            { name: 'shows', indexes: [{ key: { a: 1 } }] },
          ),
        },
        'the-signal',
      ),
      (error) => {
        assert.ok(error instanceof RunAbortedError);
        const rows = error.context.converge.collections;
        assert.strictEqual(rows[0].actions[0].status, 'applied');
        assert.strictEqual(rows[1].actions[0].status, 'skipped');
        return true;
      },
    );
    assert.deepStrictEqual(db.ops, ['createSearchIndex movies.default']);
  });

  it('should warn about a STALE index — queryable, but not replicating', async () => {
    const db = fakeDb(
      { movies: { searchIndexes: [searchIndex('default', DYNAMIC, { status: 'STALE' })] } },
      { search: 'atlas' },
    );
    const { deps, lines } = makeDeps(db);
    const result = await run(deps, [
      { name: 'movies', indexes: [{ key: { a: 1 } }], searchIndexes: [{ definition: DYNAMIC }] },
    ]);
    assert.deepStrictEqual(
      result.search.notReady.map((index) => `${index.name}:${index.status}`),
      ['default:STALE'],
    );
    assert.ok(
      lines.some(
        (line) =>
          line.level === 'warn' &&
          /search index "default" is STALE — queryable, but no longer replicating/.test(
            line.message,
          ),
      ),
    );
    assert.ok(!lines.some((line) => /still building/.test(line.message)));
  });

  it('should not update for an option only the server reports — and say it left it out', async () => {
    const db = fakeDb(
      {
        movies: {
          searchIndexes: [
            searchIndex('default', { mappings: { dynamic: true }, sortOrder: 'new' }),
          ],
        },
      },
      { search: 'atlas' },
    );
    const { deps, lines } = makeDeps(db);
    const result = await run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }]);
    assert.deepStrictEqual(db.ops, []);
    assert.deepStrictEqual(result.collections[0].actions[0].ignored, ['sortOrder']);
    const warned = lines.filter((line) => /left out of the comparison/.test(line.message));
    assert.strictEqual(warned.length, 1);
    assert.match(warned[0].message, /movies\.default \(sortOrder\)/);
  });

  it('should report a definition the server keeps differently as unstable, not loop', async () => {
    const db = fakeDb(
      { movies: {} },
      { search: 'atlas', normalize: (definition) => ({ ...definition, numPartitions: 2 }) },
    );
    const pauses = [];
    const { deps, lines } = makeDeps(db, { sleep: async (ms) => pauses.push(ms) });
    const result = await run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }]);
    assert.deepStrictEqual(result.unstable, [
      {
        collection: 'movies',
        target: 'searchIndex',
        name: 'default',
        action: 'modify',
        reason: 'numPartitions',
      },
    ]);
    assert.deepStrictEqual(pauses, [250, 500, 1000], 'a bounded number of re-reads');
    assert.strictEqual(result.inSync, false);
    assert.ok(
      lines.some((line) =>
        /search index "default" still differs after converge \(numPartitions\) — .*every update builds the search index again/.test(
          line.message,
        ),
      ),
    );
  });

  it('should stop before a collection that gained an undeclared search index meanwhile', async () => {
    const db = fakeDb({ a: { indexes: [] }, b: { searchIndexes: [] } }, { search: 'atlas' });
    const collection = db.collection;
    db.collection = (name) => {
      const handle = collection(name);
      if (name !== 'a') return handle;
      return {
        ...handle,
        createIndexes: async (specs) => {
          db.state.b.searchIndexes.push(searchIndex('surprise', DYNAMIC));
          return handle.createIndexes(specs);
        },
      };
    };
    await assert.rejects(
      run(makeDeps(db).deps, [
        { name: 'a', indexes: [{ key: { x: 1 } }] },
        { name: 'b', searchIndexes: [], prune: true },
      ]),
      (error) => {
        assert.strictEqual(error.context.phase, 'replan');
        assert.deepStrictEqual(error.context.introduced, [
          { target: 'searchIndex', name: 'surprise', action: 'drop', reason: 'not declared' },
        ]);
        return true;
      },
    );
    assert.deepStrictEqual(db.ops, ['createIndex a.x_1']);
  });

  it('should record search index changes with their from and to', async () => {
    const entries = [];
    const db = fakeDb(
      { movies: { searchIndexes: [searchIndex('default', { mappings: { dynamic: false } })] } },
      { search: 'atlas' },
    );
    const { deps } = makeDeps(db);
    deps.record = async (entry) => entries.push(entry);
    deps.audit = () => ({ runId: 'run-1' });
    await run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }]);
    const [entry] = entries;
    assert.strictEqual(entry.changed, 1);
    assert.deepStrictEqual(entry.actions[0].from, {
      name: 'default',
      type: 'search',
      definition: { mappings: { dynamic: false } },
    });
    assert.deepStrictEqual(entry.actions[0].to, {
      name: 'default',
      type: 'search',
      definition: DYNAMIC,
    });
  });

  it('should wrap a search index list that cannot be read, with what usually fixes it', async () => {
    const db = fakeDb(
      { movies: {}, shows: {} },
      {
        search: 'atlas',
        fail: {
          listSearchIndexes: () =>
            db.ops.length === 0 && probes++ > 0
              ? serverError(13, 'not authorized on app')
              : undefined,
        },
      },
    );
    let probes = 0;
    await assert.rejects(
      run(makeDeps(db).deps, [
        { name: 'movies', searchIndexes: [{ definition: DYNAMIC }] },
        { name: 'shows', searchIndexes: [{ definition: DYNAMIC }] },
      ]),
      (error) => {
        assert.ok(error instanceof ConvergeFailedError);
        assert.strictEqual(error.context.phase, 'plan');
        assert.strictEqual(error.context.collection, 'shows');
        assert.strictEqual(error.context.mongoCode, 13);
        assert.match(error.context.hint, /listSearchIndexes/);
        assert.deepStrictEqual(error.context.converge.collections, []);
        return true;
      },
    );
  });

  it('should wrap a probe that fails for a reason other than "no Search here"', async () => {
    const db = fakeDb(
      { movies: {} },
      { search: 'atlas', fail: { listSearchIndexes: serverError(13, 'not authorized on app') } },
    );
    await assert.rejects(
      run(makeDeps(db).deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], {
        dryRun: true,
      }),
      (error) => {
        assert.ok(error instanceof ConvergeFailedError);
        assert.strictEqual(error.context.phase, 'plan');
        assert.strictEqual(error.context.collection, 'movies');
        assert.strictEqual(error.context.converge.dryRun, true);
        return true;
      },
    );
  });

  it('should say in which phase a later search index read failed', async () => {
    // Reads, in order: the probe (movies), shows; the verify of movies; the replan of shows.
    const failAt = (failing) => {
      let reads = 0;
      return () => {
        reads += 1;
        return reads === failing ? serverError(13, 'not authorized on app') : undefined;
      };
    };
    const list = [
      { name: 'movies', searchIndexes: [{ definition: DYNAMIC }] },
      { name: 'shows', searchIndexes: [{ definition: DYNAMIC }] },
    ];
    for (const [failing, phase, collection] of [
      [3, 'apply', 'movies'],
      [4, 'replan', 'shows'],
    ]) {
      const db = fakeDb(
        { movies: {}, shows: {} },
        { search: 'atlas', fail: { listSearchIndexes: failAt(failing) } },
      );
      await assert.rejects(run(makeDeps(db).deps, list), (error) => {
        assert.ok(error instanceof ConvergeFailedError);
        assert.strictEqual(error.context.phase, phase);
        assert.strictEqual(error.context.collection, collection);
        assert.strictEqual(error.context.converge.collections[0].actions[0].status, 'applied');
        const statuses = error.context.converge.collections.flatMap((entry) =>
          entry.actions.map((action) => action.status),
        );
        assert.ok(!statuses.includes('planned'), 'no row is left planned');
        return true;
      });
    }
  });

  it('should fail the wait as unreadable when the server refuses the list', async () => {
    let reads = 0;
    const db = fakeDb(
      { movies: {} },
      {
        search: 'atlas',
        readyAfter: 1000,
        fail: {
          listSearchIndexes: () => {
            reads += 1;
            return reads > 2 ? serverError(13, 'not authorized on app') : undefined;
          },
        },
      },
    );
    await assert.rejects(
      run(makeDeps(db).deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], {
        search: { onUnavailable: 'fail', wait: true, waitTimeoutMs: 60_000 },
      }),
      (error) => {
        assert.strictEqual(error.context.phase, 'wait');
        assert.strictEqual(error.context.reason, 'unreadable');
        assert.strictEqual(error.context.mongoCode, 13);
        assert.match(error.context.hint, /listSearchIndexes actions/);
        assert.strictEqual(error.context.converge.collections[0].actions[0].status, 'applied');
        return true;
      },
    );
  });

  it('should not probe for collections the planner refuses anyway', async () => {
    const reads = [];
    const db = fakeDb({ recent: { type: 'view' } }, { reads, search: 'atlas' });
    const result = await run(
      makeDeps(db).deps,
      [{ name: 'recent', searchIndexes: [{ definition: DYNAMIC }] }],
      { dryRun: true },
    );
    assert.ok(!reads.some(([kind]) => kind === 'aggregate'));
    assert.deepStrictEqual(rowsOf(result), ['recent:collection:recent:conflict']);
  });

  it('should infer the type of a live index the server reports without one', async () => {
    const db = fakeDb(
      { movies: { searchIndexes: [searchIndex('plot', VECTOR, { hideType: true })] } },
      { search: 'atlas' },
    );
    const result = await run(
      makeDeps(db).deps,
      [
        {
          name: 'movies',
          searchIndexes: [{ name: 'plot', type: 'vectorSearch', definition: VECTOR }],
        },
      ],
      { dryRun: true },
    );
    assert.deepStrictEqual(rowsOf(result), ['movies:searchIndex:plot:unchanged']);
    assert.strictEqual(result.inSync, true);
  });
});

describe('runConverge — waiting for search indexes', () => {
  const DYNAMIC = { mappings: { dynamic: true } };
  /** A clock that only moves when the run sleeps */
  function clock() {
    const state = { now: 0, pauses: [] };
    return {
      state,
      sleep: async (ms) => {
        state.pauses.push(ms);
        state.now += ms;
      },
      now: () => state.now,
    };
  }
  const waiting = (waitTimeoutMs = 60_000) => ({
    search: { onUnavailable: 'fail', wait: true, waitTimeoutMs },
  });
  const run = (deps, list, options) =>
    runConverge(deps, { definitions: definitions(...list), ...options }, undefined);

  it('should poll, backing off, until a new index is queryable', async () => {
    // Read once by the verify phase, then by each poll: READY on the third.
    const db = fakeDb({ movies: {} }, { search: 'atlas', readyAfter: 4 });
    const time = clock();
    const { deps, lines } = makeDeps(db, time);
    const result = await run(
      deps,
      [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }],
      waiting(),
    );
    assert.deepStrictEqual(time.state.pauses, [1000, 1500]);
    assert.deepStrictEqual(result.search.notReady, []);
    assert.deepStrictEqual(result.collections[0].actions[0].build, {
      status: 'READY',
      queryable: true,
    });
    assert.ok(
      lines.some((line) =>
        /Waiting for 1 search index\(es\) to become queryable \(up to 60s\)/.test(line.message),
      ),
    );
    assert.ok(
      lines.some((line) => /✔ Search index\(es\) queryable: 1 {3}\[2500ms\]/.test(line.message)),
    );
    assert.ok(!lines.some((line) => /still building/.test(line.message)));
  });

  it('should fail the run when the budget runs out, and record it', async () => {
    const entries = [];
    const db = fakeDb({ movies: {} }, { search: 'atlas', readyAfter: 1000 });
    const time = clock();
    const { deps } = makeDeps(db, time);
    deps.record = async (entry) => entries.push(entry);
    deps.audit = () => ({ runId: 'run-1' });
    await assert.rejects(
      run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], waiting(5000)),
      (error) => {
        assert.ok(error instanceof ConvergeFailedError);
        assert.strictEqual(error.context.phase, 'wait');
        assert.strictEqual(error.context.reason, 'timeout');
        assert.strictEqual(error.context.timeoutMs, 5000);
        assert.strictEqual(error.context.waitedMs, 5000);
        assert.deepStrictEqual(error.context.notReady, [
          { collection: 'movies', name: 'default', status: 'PENDING', queryable: false },
        ]);
        assert.match(error.message, /not queryable after 5s: movies\.default \(PENDING\)/);
        assert.match(error.message, /raise searchIndexWaitTimeoutMs/);
        assert.strictEqual(error.context.converge.collections[0].actions[0].status, 'applied');
        return true;
      },
    );
    assert.deepStrictEqual(time.state.pauses, [1000, 1500, 2250, 250], 'never past the budget');
    assert.strictEqual(entries[0].success, false);
    assert.strictEqual(entries[0].changed, 1, 'the create was applied all the same');
  });

  it('should wait for a declared index that is still building even when nothing changed', async () => {
    const db = fakeDb(
      {
        movies: {
          searchIndexes: [
            searchIndex('default', DYNAMIC, {
              status: 'BUILDING',
              queryable: false,
              pendingReads: 3,
            }),
          ],
        },
      },
      { search: 'atlas' },
    );
    const time = clock();
    const result = await run(
      makeDeps(db, time).deps,
      [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }],
      waiting(),
    );
    assert.deepStrictEqual(db.ops, []);
    assert.deepStrictEqual(time.state.pauses, [1000]);
    assert.deepStrictEqual(result.search.notReady, []);
  });

  it('should not hold the wait for a FAILED index the run did not change — only say so', async () => {
    const db = fakeDb(
      {
        movies: {
          searchIndexes: [
            searchIndex('default', DYNAMIC, {
              status: 'FAILED',
              queryable: false,
              message: 'too many fields',
            }),
          ],
        },
      },
      { search: 'atlas', readyAfter: 2 },
    );
    const time = clock();
    const { deps, lines } = makeDeps(db, time);
    const result = await run(
      deps,
      [
        {
          name: 'movies',
          searchIndexes: [{ definition: DYNAMIC }, { name: 'more', definition: DYNAMIC }],
        },
      ],
      waiting(),
    );
    assert.deepStrictEqual(db.ops, ['createSearchIndex movies.more']);
    assert.ok(
      lines.some((line) =>
        /Not waiting for 1 search index\(es\) this run did not change.*movies\.default \(FAILED: too many fields\)/.test(
          line.message,
        ),
      ),
    );
    assert.ok(lines.some((line) => /✔ Search index\(es\) queryable: 1 /.test(line.message)));
    assert.ok(
      lines.some(
        (line) =>
          line.level === 'warn' && /"default" failed to build: too many fields/.test(line.message),
      ),
    );
    assert.deepStrictEqual(
      result.search.notReady.map((index) => `${index.name}:${index.status}`),
      ['default:FAILED'],
      'still reported — the --check gate fails on it',
    );
  });

  it('should stop at once when an index the run created fails to build', async () => {
    const db = fakeDb({ movies: {} }, { search: 'atlas', readyAfter: 1000 });
    const time = clock();
    const { deps } = makeDeps(db, {
      ...time,
      sleep: async (ms) => {
        await time.sleep(ms);
        const index = db.state.movies.searchIndexes[0];
        Object.assign(index, { status: 'FAILED', message: 'too many fields' });
        delete index.pendingReads;
      },
    });
    await assert.rejects(
      run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], waiting()),
      (error) => {
        assert.strictEqual(error.context.phase, 'wait');
        assert.strictEqual(error.context.reason, 'failed');
        assert.match(
          error.message,
          /movies\.default \(FAILED: too many fields\) — fix the definition/,
        );
        return true;
      },
    );
    assert.deepStrictEqual(time.state.pauses, [1000], 'the poll that saw FAILED ended the wait');
  });

  it('should ride out a blip while reading, and say so', async () => {
    let reads = 0;
    const db = fakeDb(
      { movies: {} },
      {
        search: 'atlas',
        readyAfter: 3,
        fail: {
          listSearchIndexes: () => {
            reads += 1;
            // The read phase, the verify phase, then the first poll fails.
            return reads === 3
              ? Object.assign(new Error('connection reset'), { name: 'MongoNetworkError' })
              : undefined;
          },
        },
      },
    );
    const time = clock();
    const { deps, lines } = makeDeps(db, time);
    const result = await run(
      deps,
      [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }],
      waiting(),
    );
    assert.deepStrictEqual(result.search.notReady, []);
    assert.ok(
      lines.some(
        (line) =>
          line.level === 'warn' &&
          /Could not read the search indexes \(1 in a row\) — trying again/.test(line.message),
      ),
    );
  });

  it('should cut a pause short when the run is aborted', async () => {
    const db = fakeDb({ movies: {} }, { search: 'atlas', readyAfter: 1000 });
    const controller = new AbortController();
    const { deps } = makeDeps(db, {
      assertNotAborted: (signal) => {
        if (signal?.aborted) throw signal.reason;
      },
    });
    delete deps.sleep; // the real pause: a second before the second poll
    setTimeout(() => controller.abort(new RunAbortedError('Stopped', { reason: 'Stopped' })), 20);
    const startedAt = Date.now();
    await assert.rejects(
      runConverge(
        deps,
        {
          definitions: definitions({ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }),
          ...waiting(),
        },
        controller.signal,
      ),
      RunAbortedError,
    );
    assert.ok(Date.now() - startedAt < 500, 'the 1s pause was not waited out');
  });

  it('should not take the old definition reading READY for an update that has landed', async () => {
    const db = fakeDb(
      {
        movies: {
          searchIndexes: [searchIndex('default', { mappings: { dynamic: false } }, { version: 2 })],
        },
      },
      { search: 'atlas' },
    );
    // The verify read and the first poll still report the version the update started from.
    let behind = 2;
    const collection = db.collection;
    db.collection = (name) => {
      const handle = collection(name);
      return {
        ...handle,
        aggregate: (pipeline, options) => ({
          toArray: async () => {
            const docs = await handle.aggregate(pipeline, options).toArray();
            if (db.ops.length === 0 || behind-- <= 0) return docs;
            return docs.map((doc) => ({ ...doc, latestDefinitionVersion: { version: 2 } }));
          },
        }),
      };
    };
    const time = clock();
    await run(
      makeDeps(db, time).deps,
      [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }],
      waiting(),
    );
    assert.deepStrictEqual(db.ops, ['updateSearchIndex movies.default']);
    assert.deepStrictEqual(time.state.pauses, [1000], 'one more poll, until the version moved');
  });

  it('should stop between polls when aborted, keeping what was applied', async () => {
    const db = fakeDb({ movies: {} }, { search: 'atlas', readyAfter: 1000 });
    let aborted = false;
    const time = clock();
    const { deps } = makeDeps(db, {
      ...time,
      sleep: async (ms) => {
        await time.sleep(ms);
        aborted = true;
      },
      assertNotAborted: () => {
        if (aborted) throw new RunAbortedError('Stopped', { reason: 'Stopped' });
      },
    });
    await assert.rejects(
      run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], waiting()),
      (error) => {
        assert.ok(error instanceof RunAbortedError);
        assert.strictEqual(error.context.converge.collections[0].actions[0].status, 'applied');
        return true;
      },
    );
    assert.deepStrictEqual(time.state.pauses, [1000], 'no poll after the abort');
  });

  it('should give the lock up before the first poll — once, and only to wait', async () => {
    const db = fakeDb({ movies: {} }, { search: 'atlas', readyAfter: 3 });
    const time = clock();
    const order = [];
    const { deps, lines } = makeDeps(db, time);
    deps.releaseLock = async () => {
      order.push(`release after ${db.ops.length} op(s)`);
      return true;
    };
    const read = db.collection;
    db.collection = (name) => {
      const handle = read(name);
      return {
        ...handle,
        aggregate: (pipeline, options) => {
          order.push('read');
          return handle.aggregate(pipeline, options);
        },
      };
    };
    await run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], waiting());
    // The read phase, the verify phase — then the release, then the polls.
    assert.deepStrictEqual(order.slice(0, 3), ['read', 'read', 'release after 1 op(s)']);
    assert.strictEqual(order.filter((entry) => entry.startsWith('release')).length, 1);
    assert.ok(
      lines.some((line) =>
        /Waiting for 1 search index\(es\).* — the migration lock is released meanwhile/.test(
          line.message,
        ),
      ),
    );
  });

  it('should keep the lock when there is nothing to wait for', async () => {
    const released = [];
    const releaseLock = async () => released.push('released');
    const quiet = fakeDb({ movies: {} }, { search: 'atlas' });
    const noWait = makeDeps(quiet);
    noWait.deps.releaseLock = releaseLock;
    await run(noWait.deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }]);
    const none = fakeDb({ movies: {} }, { search: 'atlas' });
    const nothing = makeDeps(none);
    nothing.deps.releaseLock = releaseLock;
    await run(nothing.deps, [{ name: 'movies', indexes: [{ key: { a: 1 } }] }], waiting());
    const plain = fakeDb({ movies: {} }, { search: { unavailable: 31082 } });
    const skipped = makeDeps(plain);
    skipped.deps.releaseLock = releaseLock;
    await run(skipped.deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], {
      search: { onUnavailable: 'skip', wait: true, waitTimeoutMs: 60_000 },
    });
    assert.deepStrictEqual(released, []);
  });

  it('should tell the wait through events, the result, the history and one metric point', async () => {
    const db = fakeDb({ movies: {} }, { search: 'atlas', readyAfter: 30 });
    const time = clock();
    const { deps, events } = makeDeps(db, time);
    const entries = [];
    const points = [];
    deps.record = async (entry) => entries.push(entry);
    deps.audit = () => ({});
    deps.releaseLock = async () => true;
    deps.recordSearchWait = (waitedMs, outcome) => points.push([waitedMs, outcome]);
    const result = await run(
      deps,
      [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }],
      waiting(600_000),
    );
    const waits = events.filter(([name]) => name === 'converge:wait').map(([, event]) => event);
    assert.deepStrictEqual(waits[0], {
      status: 'started',
      searchIndexes: 1,
      lockReleased: true,
      timeoutMs: 600_000,
    });
    assert.ok(waits.some((event) => event.status === 'progress' && event.waitedMs >= 30_000));
    const last = waits.at(-1);
    assert.strictEqual(last.status, 'ready');
    assert.strictEqual(last.waitedMs, result.search.wait.waitedMs);
    assert.deepStrictEqual(result.search.wait.outcome, 'ready');
    assert.deepStrictEqual(points, [[result.search.wait.waitedMs, 'ready']]);
    assert.deepStrictEqual(entries[0].search, result.search);
    const order = events.map(([name]) => name);
    assert.ok(order.lastIndexOf('converge:wait') < order.indexOf('converge:end'));
  });

  it('should record how a wait that failed ended — timeout, unreadable, aborted', async () => {
    const cases = [
      ['timeout', {}, waiting(5000)],
      [
        'unreadable',
        {
          fail: {
            listSearchIndexes: (() => {
              let reads = 0;
              return () => ((reads += 1) > 2 ? serverError(13, 'not authorized') : undefined);
            })(),
          },
        },
        waiting(),
      ],
    ];
    for (const [outcome, extra, options] of cases) {
      const db = fakeDb({ movies: {} }, { search: 'atlas', readyAfter: 1000, ...extra });
      const { deps, events } = makeDeps(db, clock());
      const points = [];
      deps.recordSearchWait = (waitedMs, ended) => points.push(ended);
      await assert.rejects(
        run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], options),
        (error) => {
          assert.strictEqual(error.context.converge.search.wait.outcome, outcome);
          return true;
        },
      );
      assert.deepStrictEqual(points, [outcome]);
      const last = events.filter(([name]) => name === 'converge:wait').at(-1)[1];
      assert.strictEqual(last.status, outcome);
    }

    const db = fakeDb({ movies: {} }, { search: 'atlas', readyAfter: 1000 });
    let aborted = false;
    const time = clock();
    const { deps } = makeDeps(db, {
      ...time,
      sleep: async (ms) => {
        await time.sleep(ms);
        aborted = true;
      },
      assertNotAborted: () => {
        if (aborted) throw new RunAbortedError('Stopped', { reason: 'Stopped' });
      },
    });
    const points = [];
    deps.recordSearchWait = (waitedMs, ended) => points.push([waitedMs, ended]);
    await assert.rejects(
      run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], waiting()),
      RunAbortedError,
    );
    assert.deepStrictEqual(points, [[1000, 'aborted']]);
  });

  it('should say at info, not debug, that Search was assumed when it is about to wait on it', async () => {
    const db = fakeDb({ movies: {} }, { search: 'atlas', parameter: 8000, readyAfter: 1 });
    const { deps, lines } = makeDeps(db, clock());
    await run(deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], waiting());
    const assumed = lines.find((line) => /Atlas Search assumed available/.test(line.message));
    assert.strictEqual(assumed?.level, 'info');
  });

  it('should say how long it has been waiting, every 30 seconds', async () => {
    const db = fakeDb({ movies: {} }, { search: 'atlas', readyAfter: 12 });
    const time = clock();
    const { deps, lines } = makeDeps(db, time);
    await run(
      deps,
      [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }],
      waiting(600_000),
    );
    const progress = lines.filter((line) => /Still waiting for search indexes/.test(line.message));
    assert.ok(progress.length >= 1);
    assert.match(progress[0].message, /\[\d+s\]/);
  });

  it('should not wait in a dry run, in skip mode, or for nothing', async () => {
    const time = clock();
    const dry = fakeDb({ movies: {} }, { search: 'atlas' });
    await run(
      makeDeps(dry, time).deps,
      [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }],
      {
        ...waiting(),
        dryRun: true,
      },
    );
    const skipped = fakeDb({ movies: {} }, { search: { unavailable: 31082 } });
    const skip = makeDeps(skipped, time);
    await run(skip.deps, [{ name: 'movies', searchIndexes: [{ definition: DYNAMIC }] }], {
      search: { onUnavailable: 'skip', wait: true, waitTimeoutMs: 1000 },
    });
    const none = fakeDb({ movies: {} }, { search: 'atlas' });
    const nothing = makeDeps(none, time);
    await run(nothing.deps, [{ name: 'movies', searchIndexes: [] }], waiting());
    assert.deepStrictEqual(time.state.pauses, []);
    for (const lines of [skip.lines, nothing.lines]) {
      assert.ok(!lines.some((line) => /Waiting for/.test(line.message)));
    }
  });
});
