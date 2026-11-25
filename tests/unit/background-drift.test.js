const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { verify } = require('../../src/core/background-drift.js');

/** A completed forward migration over its own collection, as the store lists it */
const completed = (name, collection) => ({
  _id: name,
  status: 'completed',
  direction: 'forward',
  spec: { mode: 'declarative', collection, field: '__v', from: 1, to: 2 },
});

/**
 * What the kit injects, over a database where every collection holds one
 * old-shape document. `now` is what each state reads as by the time it is
 * to be reopened — someone may have moved it since the list was read.
 */
const makeDeps = (states, now) => {
  const events = [];
  const lines = [];
  const moves = [];
  return {
    events,
    lines,
    moves,
    store: {
      list: async () => states,
      get: async (name) => now[name] ?? null,
      move: async (name, change) => {
        moves.push([name, change.from, change.to]);
        return { ...now[name], status: change.to };
      },
    },
    db: {
      collection: () => ({
        listIndexes: () => ({ toArray: async () => [{ key: { __v: 1, _id: 1 } }] }),
        findOne: async () => ({ _id: 'old' }),
      }),
    },
    logger: {
      debug: (message) => lines.push(['debug', message]),
      info: (message) => lines.push(['info', message]),
      warn: (message) => lines.push(['warn', message]),
    },
    fields: (extra) => extra,
    emit: (event, payload) => events.push([event, payload]),
  };
};

describe('verify — a state that moved since the list was read', () => {
  it('should leave the ones it may not reopen and still check the ones after them', async () => {
    const states = [
      completed('a.js', 'orders'),
      completed('b.js', 'users'),
      completed('c.js', 'carts'),
    ];
    const deps = makeDeps(states, {
      // Paused by an operator in between: a retry does not fit it.
      'a.js': { ...states[0], status: 'paused' },
      // Reopened by another runner's watch first: it is running already.
      'b.js': { ...states[1], status: 'running' },
      // Still as the list said.
      'c.js': states[2],
    });
    // It used to throw at a.js: nothing after it was looked at this round.
    const result = await verify(deps);
    assert.deepStrictEqual(result, {
      checked: 3,
      skipped: 0,
      drift: [{ migration: 'c.js', collection: 'carts', action: 'reopened' }],
    });
    assert.deepStrictEqual(deps.moves, [['c.js', ['completed'], 'running']]);
    const drifts = deps.events.filter(([event]) => event === 'background:drift');
    assert.deepStrictEqual(
      drifts.map(([, payload]) => payload.migration),
      ['c.js'],
    );
    const debug = deps.lines.filter(([level]) => level === 'debug').map(([, line]) => line);
    assert.strictEqual(debug.length, 2);
    assert.match(debug[0], /a\.js: not reopened/);
    assert.match(debug[1], /b\.js: not reopened/);
  });

  it('should still throw what is not a conflict', async () => {
    const states = [completed('a.js', 'orders')];
    const deps = makeDeps(states, {});
    deps.store.get = async () => {
      throw new Error('connection reset');
    };
    await assert.rejects(verify(deps), /connection reset/);
  });
});
