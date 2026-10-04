const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  SEARCH_STEPS,
  isSearchUnavailable,
  listSearchIndexes,
  probeSearch,
  runSearchStep,
  searchHint,
} = require('../../src/core/converge-search.js');

const serverError = (code, message = `server error ${code}`, fields = {}) =>
  Object.assign(new Error(message), { code, ...fields });

/**
 * A database with one collection's `$listSearchIndexes` answer (or error) and
 * a `getParameter` answer (a value, or an error code) — what the probe asks.
 */
function probeDb({ listed = [], listError, parameter, noAdmin = false } = {}) {
  const calls = [];
  return {
    calls,
    collection: (name) => ({
      aggregate: (pipeline, options) => ({
        toArray: async () => {
          calls.push(['aggregate', name, pipeline, options]);
          if (listError) throw listError;
          return listed;
        },
      }),
    }),
    ...(noAdmin
      ? {}
      : {
          admin: () => ({
            command: async (command) => {
              calls.push(['admin', command]);
              if (typeof parameter === 'number') throw serverError(parameter);
              if (parameter instanceof Error) throw parameter;
              return parameter === undefined
                ? { ok: 1 }
                : { searchIndexManagementHostAndPort: parameter };
            },
          }),
        }),
  };
}

const probe = (db, version) =>
  probeSearch(
    db,
    { version },
    { collection: 'movies', readOptions: { readPreference: 'primary' } },
  );

describe('isSearchUnavailable', () => {
  for (const [label, error] of [
    ['SearchNotEnabled (7.3+)', serverError(31082, 'Using Atlas Search Database Commands …')],
    [
      'CommandNotSupported (6.0/7.0)',
      serverError(115, 'Search index commands are only supported with Atlas.'),
    ],
    [
      'the $listSearchIndexes refusal of 7.0',
      serverError(6047401, 'only allowed on MongoDB Atlas'),
    ],
    ['no such command', serverError(59, "no such command: 'createSearchIndexes'")],
    [
      'an unknown pipeline stage',
      serverError(40324, "Unrecognized pipeline stage name: '$listSearchIndexes'"),
    ],
    ['the code name alone', serverError(undefined, 'nope', { codeName: 'SearchNotEnabled' })],
    [
      'the message alone',
      new Error(
        '… $listSearchIndexes aggregation stage requires additional configuration. Please connect to Atlas',
      ),
    ],
  ]) {
    it(`should recognize ${label}`, () => {
      assert.strictEqual(isSearchUnavailable(error), true);
    });
  }

  it('should not take any other error for it', () => {
    assert.strictEqual(isSearchUnavailable(serverError(13, 'not authorized')), false);
    assert.strictEqual(isSearchUnavailable(new Error('connection reset')), false);
    assert.strictEqual(isSearchUnavailable(undefined), false);
  });
});

describe('searchHint', () => {
  for (const [label, error, pattern] of [
    ['a server without Search', serverError(31082), /mongodb-atlas-local/],
    [
      'a missing privilege',
      serverError(13, 'not authorized'),
      /createSearchIndexes, updateSearchIndex/,
    ],
    [
      'the tier limit',
      serverError(8, 'The maximum number of FTS indexes has been reached for this instance size.'),
      /Free: 3, Flex: 10/,
    ],
    ['a taken name', serverError(68, 'Index already exists'), /still being deleted/],
    ['a duplicate name', serverError(8, 'Duplicate Index'), /already exists/],
  ]) {
    it(`should explain ${label}`, () => {
      assert.match(searchHint(error), pattern);
    });
  }

  it('should have nothing to say about anything else', () => {
    assert.strictEqual(searchHint(serverError(8, 'Invalid mapping for field "title"')), undefined);
    assert.strictEqual(searchHint(serverError(10334, 'BSONObj size exceeds the limit')), undefined);
  });
});

describe('listSearchIndexes', () => {
  it('should run $listSearchIndexes with the read options given', async () => {
    const db = probeDb({ listed: [{ name: 'default' }] });
    assert.deepStrictEqual(await listSearchIndexes(db, 'movies', { readPreference: 'primary' }), [
      { name: 'default' },
    ]);
    assert.deepStrictEqual(db.calls[0], [
      'aggregate',
      'movies',
      [{ $listSearchIndexes: {} }],
      { readPreference: 'primary' },
    ]);
  });

  it('should list nothing for a collection that does not exist', async () => {
    const db = probeDb({ listError: serverError(26, 'ns does not exist') });
    assert.deepStrictEqual(await listSearchIndexes(db, 'movies', {}), []);
  });
});

describe('probeSearch', () => {
  for (const [label, options, version, outcome, asked] of [
    [
      'a server older than 6.0, without asking it',
      {},
      { major: 5, minor: 0 },
      { available: false, evidence: 'version' },
      [],
    ],
    [
      'an "unavailable" refusal',
      { listError: serverError(31082, 'requires additional configuration') },
      { major: 8, minor: 0, patch: 4 },
      { available: false, evidence: 'error' },
      ['aggregate'],
    ],
    [
      'a list with an index in it',
      { listed: [{ name: 'default' }] },
      { major: 7, minor: 0, patch: 2 },
      { available: true, evidence: 'listed' },
      ['aggregate'],
    ],
    [
      'an empty list from 7.2.1 or later',
      {},
      { major: 7, minor: 2, patch: 1 },
      { available: true, evidence: 'listed' },
      ['aggregate'],
    ],
    [
      'an empty list from 8.0',
      {},
      { major: 8, minor: 0 },
      { available: true, evidence: 'listed' },
      ['aggregate'],
    ],
    [
      'an empty list from 7.0, on a server wired to a search index manager',
      { parameter: 'localhost:27027' },
      { major: 7, minor: 0, patch: 14 },
      { available: true, evidence: 'parameter' },
      ['aggregate', 'admin'],
    ],
    [
      'an empty list from 7.0, on a server with no search index manager',
      { parameter: '' },
      { major: 7, minor: 0, patch: 14 },
      { available: false, evidence: 'parameter' },
      ['aggregate', 'admin'],
    ],
    [
      'an empty list from a server without the setting at all',
      { parameter: 72 },
      { major: 6, minor: 0, patch: 3 },
      { available: false, evidence: 'parameter' },
      ['aggregate', 'admin'],
    ],
    [
      'an empty list from a server whose refusal of the setting has no code (5.0/6.0)',
      { parameter: new Error('no option found to get') },
      { major: 6, minor: 0, patch: 3 },
      { available: false, evidence: 'parameter' },
      ['aggregate', 'admin'],
    ],
    [
      'an empty list from a server that will not say (Atlas restricts getParameter)',
      { parameter: 8000 },
      { major: 7, minor: 0, patch: 14 },
      { available: true, evidence: 'assumed' },
      ['aggregate', 'admin'],
    ],
    [
      'an empty list from a server that answers without the setting',
      { parameter: undefined },
      undefined,
      { available: true, evidence: 'assumed' },
      ['aggregate', 'admin'],
    ],
    [
      'an empty list where there is no admin handle',
      { noAdmin: true },
      undefined,
      { available: true, evidence: 'assumed' },
      ['aggregate'],
    ],
  ]) {
    it(`should decide on ${label}`, async () => {
      const db = probeDb(options);
      const result = await probe(db, version);
      assert.strictEqual(result.available, outcome.available);
      assert.strictEqual(result.evidence, outcome.evidence);
      assert.deepStrictEqual(
        db.calls.map(([kind]) => kind),
        asked,
      );
      if (!result.available) assert.ok(result.reason);
    });
  }

  it('should hand the list it read back for reuse', async () => {
    const listed = [{ name: 'default' }];
    assert.strictEqual((await probe(probeDb({ listed }), undefined)).listed, listed);
  });

  it('should rethrow any other error', async () => {
    const db = probeDb({ listError: serverError(13, 'not authorized') });
    await assert.rejects(probe(db, { major: 8, minor: 0 }), /not authorized/);
  });
});

describe('runSearchStep', () => {
  function commandDb(fail) {
    const commands = [];
    return {
      commands,
      command: async (command) => {
        commands.push(command);
        const error = fail?.(command, commands.length);
        if (error) throw error;
        return { ok: 1 };
      },
    };
  }

  it('should know its three ops', () => {
    assert.deepStrictEqual(
      [...SEARCH_STEPS],
      ['createSearchIndexes', 'updateSearchIndex', 'dropSearchIndex'],
    );
  });

  it('should create every index of the step in one command', async () => {
    const db = commandDb();
    const specs = [{ name: 'default', definition: { mappings: {} } }];
    await runSearchStep(db, 'movies', { op: 'createSearchIndexes', specs });
    assert.deepStrictEqual(db.commands, [{ createSearchIndexes: 'movies', indexes: specs }]);
  });

  it('should update without a type, and restate it once for a vector index the server asks about', async () => {
    const search = commandDb();
    await runSearchStep(search, 'movies', {
      op: 'updateSearchIndex',
      name: 'default',
      type: 'search',
      definition: { mappings: {} },
    });
    assert.deepStrictEqual(search.commands, [
      { updateSearchIndex: 'movies', name: 'default', definition: { mappings: {} } },
    ]);

    const vector = commandDb((command, count) =>
      count === 1 ? serverError(8, '"userCommand.mappings" is required') : undefined,
    );
    const step = {
      op: 'updateSearchIndex',
      name: 'v',
      type: 'vectorSearch',
      definition: { fields: [] },
    };
    await runSearchStep(vector, 'movies', step);
    assert.deepStrictEqual(vector.commands, [
      { updateSearchIndex: 'movies', name: 'v', definition: { fields: [] } },
      { updateSearchIndex: 'movies', name: 'v', definition: { fields: [] }, type: 'vectorSearch' },
    ]);
  });

  it('should not retry a search index update, nor any other failure', async () => {
    const search = commandDb(() => serverError(8, '"userCommand.mappings" is required'));
    await assert.rejects(
      runSearchStep(search, 'movies', {
        op: 'updateSearchIndex',
        name: 'default',
        type: 'search',
        definition: {},
      }),
      /mappings/,
    );
    assert.strictEqual(search.commands.length, 1);
    const vector = commandDb(() => serverError(8, 'Invalid definition'));
    await assert.rejects(
      runSearchStep(vector, 'movies', {
        op: 'updateSearchIndex',
        name: 'v',
        type: 'vectorSearch',
        definition: {},
      }),
      /Invalid definition/,
    );
    assert.strictEqual(vector.commands.length, 1);
  });

  it('should take an index or collection that is already gone as dropped', async () => {
    for (const error of [
      serverError(26, 'ns not found'),
      serverError(27, 'index not found'),
      serverError(8, 'Search index "x" does not exist'),
    ]) {
      const db = commandDb(() => error);
      await runSearchStep(db, 'movies', { op: 'dropSearchIndex', name: 'x' });
      assert.deepStrictEqual(db.commands, [{ dropSearchIndex: 'movies', name: 'x' }]);
    }
    const refused = commandDb(() => serverError(13, 'not authorized'));
    await assert.rejects(
      runSearchStep(refused, 'movies', { op: 'dropSearchIndex', name: 'x' }),
      /not authorized/,
    );
  });
});
