const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { planFingerprint } = require('../../src/core/converge/converge.js');
const { ConvergeLog } = require('../../src/core/converge/log.js');

/** A database with one collection that keeps its documents in memory, newest last */
const fakeDb = () => {
  const docs = [];
  const indexes = [];
  let nextId = 1;
  const collection = {
    createIndex: async (key, options) => {
      indexes.push([key, options]);
    },
    insertOne: async (doc) => {
      docs.push({ _id: nextId++, ...doc });
    },
    updateOne: async (filter, update) => {
      const doc = docs.find((candidate) => candidate._id === filter._id);
      if (doc === undefined) return { matchedCount: 0 };
      for (const [key, by] of Object.entries(update.$inc ?? {})) doc[key] = (doc[key] ?? 0) + by;
      Object.assign(doc, update.$set);
      return { matchedCount: 1 };
    },
    find: () => {
      let rows = [...docs];
      const cursor = {
        sort: () => {
          rows = rows.sort((a, b) => b.startedAt - a.startedAt);
          return cursor;
        },
        limit: (n) => {
          rows = rows.slice(0, n);
          return cursor;
        },
        project: () => cursor,
        toArray: async () => rows,
      };
      return cursor;
    },
  };
  return { docs, indexes, db: { collection: () => collection } };
};

let clock = 0;
/** A history entry as converge.js builds it — each one later than the last */
const entry = (overrides = {}) => {
  clock += 1000;
  return {
    trigger: 'converge',
    startedAt: new Date(clock),
    finishedAt: new Date(clock + 50),
    success: false,
    error: 'Converge refused: 1 conflict',
    fingerprint: 'plan-a',
    changed: 0,
    actions: [],
    ...overrides,
  };
};

describe('ConvergeLog', () => {
  it('should create its index with the first entry, once', async () => {
    const { db, docs, indexes } = fakeDb();
    const log = new ConvergeLog('_migronaut_converge');
    await log.append(db, entry({ success: true, error: undefined }));
    await log.append(db, entry({ success: true, error: undefined }));
    assert.deepStrictEqual(indexes, [[{ startedAt: -1 }, { name: 'startedAt' }]]);
    assert.strictEqual(docs.length, 2);
  });

  it('should leave the index to the user under ensureIndexes: false, and still write', async () => {
    const { db, docs, indexes } = fakeDb();
    const log = new ConvergeLog('_migronaut_converge');
    // It used to create the index whatever the config said: without the right
    // to, every converge that changed something lost its history entry.
    await log.append(db, entry({ success: true, error: undefined }), { ensureIndex: false });
    assert.deepStrictEqual(indexes, []);
    assert.strictEqual(docs.length, 1);
  });

  it('should count a failure that repeats the newest entry on that entry', async () => {
    const { db, docs } = fakeDb();
    const log = new ConvergeLog('_migronaut_converge');
    const first = entry();
    await log.append(db, first);
    const again = entry();
    await log.append(db, again);
    await log.append(db, entry());
    // One document for a failure a schedule ran into three times.
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].repeats, 2);
    assert.deepStrictEqual(docs[0].startedAt, first.startedAt, 'when it first happened');
    assert.ok(docs[0].lastAt > again.finishedAt, 'when it last happened');
  });

  it('should append what is news: another plan, another error, a success, no fingerprint', async () => {
    const { db, docs } = fakeDb();
    const log = new ConvergeLog('_migronaut_converge');
    await log.append(db, entry());
    await log.append(db, entry({ fingerprint: 'plan-b' }));
    await log.append(db, entry({ fingerprint: 'plan-b', error: 'another error' }));
    await log.append(db, entry({ fingerprint: 'plan-b', success: true, error: undefined }));
    // The newest entry is a success now: the failure after it is a new one.
    await log.append(db, entry({ fingerprint: 'plan-b', error: 'another error' }));
    await log.append(db, entry({ fingerprint: undefined }));
    await log.append(db, entry({ fingerprint: undefined }));
    assert.strictEqual(docs.length, 7);
    assert.ok(docs.every((doc) => doc.repeats === undefined));
  });

  it('should list the newest entries first', async () => {
    const { db } = fakeDb();
    const log = new ConvergeLog('_migronaut_converge');
    await log.append(db, entry({ fingerprint: 'one' }));
    await log.append(db, entry({ fingerprint: 'two' }));
    const [newest] = await log.list(db, 1);
    assert.strictEqual(newest.fingerprint, 'two');
  });
});

describe('planFingerprint', () => {
  const row = (overrides) => ({ target: 'index', name: 'a_1', action: 'create', ...overrides });
  const plan = (name, ...actions) => ({ name, actions });

  it('should be undefined for a plan that asks for nothing', () => {
    assert.strictEqual(planFingerprint([]), undefined);
    assert.strictEqual(
      planFingerprint([
        plan(
          'users',
          row({ action: 'unchanged' }),
          row({ action: 'keep', reason: 'not declared' }),
        ),
      ]),
      undefined,
    );
  });

  it('should be the same for the same asks, in whatever order they were planned', () => {
    const a = planFingerprint([
      plan('users', row({ name: 'a_1' }), row({ name: 'b_1', action: 'conflict', reason: 'x' })),
      plan('orders', row({ name: 'c_1', action: 'drop' })),
    ]);
    const b = planFingerprint([
      plan('orders', row({ name: 'c_1', action: 'drop' })),
      plan(
        'users',
        row({ name: 'b_1', action: 'conflict', reason: 'x' }),
        row({ action: 'unchanged', name: 'z_1' }),
        row({ name: 'a_1' }),
      ),
    ]);
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.strictEqual(a, b);
  });

  it('should differ when anything asked of the database does', () => {
    const base = [plan('users', row())];
    const seen = new Set([planFingerprint(base)]);
    for (const changed of [
      [plan('orders', row())],
      [plan('users', row({ name: 'b_1' }))],
      [plan('users', row({ action: 'recreate' }))],
      [plan('users', row({ target: 'searchIndex' }))],
      [plan('users', row({ reason: 'unique' }))],
      [plan('users', row(), row({ name: 'b_1' }))],
    ]) {
      seen.add(planFingerprint(changed));
    }
    assert.strictEqual(seen.size, 7);
  });
});
