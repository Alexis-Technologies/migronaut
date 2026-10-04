const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { ConvergeFailedError } = require('../../src/errors/index.js');
const { makeMigrator, makeProject } = require('../helpers/project.js');

const ATLAS_URI = process.env.MIGRONAUT_TEST_ATLAS_URI;
const DB = `migronaut_search_${process.pid}`;

/**
 * Declared search indexes against a server that has Atlas Search — the check
 * that the comparison rules (search-index-spec.js) hold against what a real
 * mongot reports, which no fake can prove: every scenario ends at a fixed
 * point, a second converge planning nothing.
 *
 * Opt-in and manual: it needs Atlas Search, which a plain `pnpm test` cannot
 * assume, and CI does not run it. An environment-capability skip with a
 * reason, like the real-Redis suite; the coverage gate passes without it. Run
 * it after a change to search-index-spec.js, converge-search.js or the search
 * planner:
 *
 *   docker run --rm -d --name migronaut-atlas -p 27018:27017 -e DO_NOT_TRACK=1 \
 *     mongodb/mongodb-atlas-local:8.0
 *   MIGRONAUT_TEST_ATLAS_URI="mongodb://127.0.0.1:27018/?directConnection=true" \
 *     node --test tests/integration/search-atlas.test.js
 */
describe(
  'converge against Atlas Search (integration, opt-in)',
  {
    skip: ATLAS_URI ? false : 'set MIGRONAUT_TEST_ATLAS_URI to run against Atlas Search',
    timeout: 900_000,
  },
  () => {
    let client;
    let db;
    let project;
    const kits = [];
    let counter = 0;
    /** A collection name of its own per scenario: a dropped index's name stays taken a while */
    const fresh = (label) => `${label}_${(counter += 1)}`;

    before(async () => {
      const { MongoClient } = require('mongodb');
      client = await MongoClient.connect(ATLAS_URI);
      db = client.db(DB);
      project = makeProject();
    });

    after(async () => {
      for (const kit of kits) await kit.disconnect();
      await db?.dropDatabase().catch(() => undefined);
      await client?.close();
      project?.cleanup();
    });

    function kitWith(collections, overrides = {}) {
      const kit = makeMigrator(ATLAS_URI, DB, project.dir, {
        collections,
        searchIndexWaitTimeoutMs: 300_000,
        ...overrides,
      });
      kits.push(kit);
      return kit;
    }

    const rows = (result) =>
      result.collections.flatMap((collection) =>
        collection.actions.map(
          (action) => `${collection.name}/${action.target}:${action.name}:${action.action}`,
        ),
      );

    /** Converge and wait for the builds, then prove a fixed point: a second plan finds nothing */
    async function convergeToFixedPoint(collections, options = {}) {
      const result = await kitWith(collections).converge({
        waitForSearchIndexes: true,
        ...options,
      });
      assert.strictEqual(result.inSync, true, JSON.stringify(result.unstable));
      assert.deepStrictEqual(result.search?.notReady, [], JSON.stringify(result.search));
      const replan = await kitWith(collections).converge({ dryRun: true });
      assert.strictEqual(replan.changed, 0, JSON.stringify(rows(replan)));
      assert.strictEqual(replan.inSync, true);
      return { result, replan };
    }

    const listed = async (collection) =>
      db
        .collection(collection)
        .aggregate([{ $listSearchIndexes: {} }])
        .toArray();

    async function seed(collection) {
      await db.collection(collection).insertMany([
        { title: 'Alien', year: 1979, genre: 'sci-fi', embedding: [0.1, 0.2, 0.3] },
        { title: 'Heat', year: 1995, genre: 'crime', embedding: [0.3, 0.1, 0.2] },
      ]);
    }

    const VECTOR = {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: 3, similarity: 'cosine' },
        { type: 'filter', path: 'year' },
      ],
    };

    it('should create search and vector indexes, wait for them, and stay in sync', async () => {
      const name = fresh('movies');
      await seed(name);
      const collections = [
        {
          name,
          searchIndexes: [
            { definition: { mappings: { dynamic: true } } },
            { name: 'plot_vectors', type: 'vectorSearch', definition: VECTOR },
          ],
        },
      ];
      const created = await kitWith(collections).converge();
      assert.deepStrictEqual(rows(created), [
        `${name}/searchIndex:default:create`,
        `${name}/searchIndex:plot_vectors:create`,
      ]);
      assert.strictEqual(created.inSync, true);
      await convergeToFixedPoint(collections);
      const types = Object.fromEntries((await listed(name)).map((index) => [index.name, index]));
      assert.ok(types.default.queryable);
      assert.ok(types.plot_vectors.queryable);
    });

    it('should reach a fixed point for every kind of definition', async () => {
      const definitions = [
        {
          label: 'static_analyzer',
          index: {
            definition: {
              analyzer: 'lucene.english',
              mappings: {
                dynamic: false,
                fields: { title: { type: 'string' }, year: { type: 'number' } },
              },
            },
          },
        },
        {
          label: 'stored_source',
          index: {
            definition: {
              mappings: { dynamic: true },
              storedSource: { include: ['title', 'year'] },
            },
          },
        },
        {
          label: 'search_analyzer',
          index: {
            definition: {
              analyzer: 'lucene.standard',
              searchAnalyzer: 'lucene.keyword',
              mappings: { dynamic: false, fields: { genre: { type: 'token' } } },
            },
          },
        },
        {
          label: 'vector_scalar',
          index: {
            type: 'vectorSearch',
            definition: {
              fields: [
                {
                  type: 'vector',
                  path: 'embedding',
                  numDimensions: 3,
                  similarity: 'euclidean',
                  quantization: 'scalar',
                },
              ],
            },
          },
        },
        {
          label: 'vector_hnsw',
          index: {
            type: 'vectorSearch',
            definition: {
              fields: [
                {
                  type: 'vector',
                  path: 'embedding',
                  numDimensions: 3,
                  similarity: 'dotProduct',
                  hnswOptions: { maxEdges: 32 },
                },
                { type: 'filter', path: 'genre' },
                { type: 'filter', path: 'year' },
              ],
            },
          },
        },
      ];
      const collections = [];
      for (const { label, index } of definitions) {
        const name = fresh(label);
        await seed(name);
        collections.push({ name, searchIndexes: [index] });
      }
      await convergeToFixedPoint(collections);
    });

    it('should update a search index in place — still queryable meanwhile', async () => {
      const name = fresh('updated');
      await seed(name);
      await convergeToFixedPoint([
        { name, searchIndexes: [{ definition: { mappings: { dynamic: true } } }] },
      ]);
      const changed = [
        {
          name,
          searchIndexes: [
            {
              definition: { mappings: { dynamic: false, fields: { title: { type: 'string' } } } },
            },
          ],
        },
      ];
      const updated = await kitWith(changed).converge();
      assert.deepStrictEqual(rows(updated), [`${name}/searchIndex:default:modify`]);
      const [index] = await listed(name);
      assert.strictEqual(index.queryable, true, 'the old definition serves during the rebuild');
      await convergeToFixedPoint(changed);
    });

    it('should update a vector index in place', async () => {
      const name = fresh('vector_updated');
      await seed(name);
      const declare = (similarity) => [
        {
          name,
          searchIndexes: [
            {
              name: 'vectors',
              type: 'vectorSearch',
              definition: {
                fields: [{ type: 'vector', path: 'embedding', numDimensions: 3, similarity }],
              },
            },
          ],
        },
      ];
      await convergeToFixedPoint(declare('cosine'));
      const { result } = await convergeToFixedPoint(declare('dotProduct'));
      assert.deepStrictEqual(rows(result), [`${name}/searchIndex:vectors:modify`]);
    });

    it('should refuse a change of type before writing anything', async () => {
      const name = fresh('retyped');
      await seed(name);
      await convergeToFixedPoint([
        { name, searchIndexes: [{ definition: { mappings: { dynamic: true } } }] },
      ]);
      const retyped = [{ name, searchIndexes: [{ type: 'vectorSearch', definition: VECTOR }] }];
      const plan = await kitWith(retyped).converge({ dryRun: true });
      assert.deepStrictEqual(rows(plan), [`${name}/searchIndex:default:conflict`]);
      await assert.rejects(kitWith(retyped).converge(), (error) => {
        assert.ok(error instanceof ConvergeFailedError);
        assert.strictEqual(error.context.phase, 'plan');
        return true;
      });
      const [index] = await listed(name);
      assert.ok(index.latestDefinition.mappings, 'still the search index it was');
    });

    it('should drop an undeclared search index under prune, and keep one otherwise', async () => {
      const name = fresh('pruned');
      await seed(name);
      await db.command({
        createSearchIndexes: name,
        indexes: [{ name: 'legacy', definition: { mappings: { dynamic: true } } }],
      });
      const kept = await kitWith([{ name, searchIndexes: [] }]).converge();
      assert.deepStrictEqual(rows(kept), [`${name}/searchIndex:legacy:keep`]);
      assert.strictEqual(kept.inSync, true);

      const pruned = await kitWith([{ name, searchIndexes: [], prune: true }]).converge();
      assert.deepStrictEqual(rows(pruned), [`${name}/searchIndex:legacy:drop`]);
      const replan = await kitWith([{ name, searchIndexes: [], prune: true }]).converge({
        dryRun: true,
      });
      assert.strictEqual(replan.changed, 0, JSON.stringify(rows(replan)));
    });

    it('should leave search indexes alone where the definition does not declare any', async () => {
      const name = fresh('unmanaged');
      await seed(name);
      await db.command({
        createSearchIndexes: name,
        indexes: [{ name: 'theirs', definition: { mappings: { dynamic: true } } }],
      });
      const result = await kitWith([
        { name, indexes: [{ key: { title: 1 } }], prune: true },
      ]).converge();
      assert.deepStrictEqual(rows(result), [`${name}/index:title_1:create`]);
      assert.deepStrictEqual(
        (await listed(name)).map((index) => index.name),
        ['theirs'],
      );
    });

    it('should pass the audit search check', async () => {
      const name = fresh('audited');
      await seed(name);
      const report = await kitWith([
        { name, searchIndexes: [{ definition: { mappings: { dynamic: true } } }] },
      ]).audit();
      const search = report.checks.find((check) => check.name === 'search');
      assert.strictEqual(search?.status, 'pass', JSON.stringify(search));
    });
  },
);
