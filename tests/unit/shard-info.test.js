const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { isUnauthorized, readChunks, readShardKey } = require('../../src/core/shard-info.js');

const unauthorized = () => Object.assign(new Error('not authorized on config'), { code: 13 });

/** A client whose `config` collections answer what a test scripts */
function fakeClient({ entry, chunks = {}, error } = {}) {
  const calls = [];
  const client = {
    calls,
    db: (name) => {
      assert.strictEqual(name, 'config');
      return {
        collection: (collection) => ({
          findOne: mock.fn(async (filter, options) => {
            calls.push({ collection, filter, options });
            if (error) throw error;
            return entry ?? null;
          }),
          find: (filter, options) => {
            calls.push({ collection, filter, options });
            return {
              sort: () => ({
                toArray: async () => {
                  if (error) throw error;
                  return chunks[filter.uuid !== undefined ? 'uuid' : 'ns'] ?? [];
                },
              }),
            };
          },
        }),
      };
    },
  };
  return client;
}

describe('readShardKey', () => {
  it('should read a sharded collection from config.collections', async () => {
    const client = fakeClient({ entry: { key: { region: 1 }, uuid: 'u', timestamp: 't' } });
    assert.deepStrictEqual(await readShardKey(client, 'app', 'orders'), {
      key: { region: 1 },
      uuid: 'u',
      timestamp: 't',
    });
    assert.deepStrictEqual(client.calls[0].filter, { _id: 'app.orders' });
    assert.strictEqual(client.calls[0].options.readPreference, 'primary');
  });

  it('should call a collection that is not sharded — or only unsplittable — not sharded', async () => {
    assert.strictEqual(await readShardKey(fakeClient(), 'app', 'orders'), null);
    const tracked = fakeClient({ entry: { key: { _id: 1 }, uuid: 'u', unsplittable: true } });
    assert.strictEqual(await readShardKey(tracked, 'app', 'orders'), null);
    assert.deepStrictEqual(
      await readShardKey(fakeClient({ entry: { key: { a: 1 }, uuid: 'u' } }), 'app', 'x'),
      { key: { a: 1 }, uuid: 'u' },
    );
  });

  it('should answer undefined to a user who may not read config, and rethrow anything else', async () => {
    assert.strictEqual(
      await readShardKey(fakeClient({ error: unauthorized() }), 'a', 'b'),
      undefined,
    );
    await assert.rejects(readShardKey(fakeClient({ error: new Error('down') }), 'a', 'b'), /down/);
    assert.ok(isUnauthorized(unauthorized()));
    assert.ok(!isUnauthorized(new Error('x')));
  });
});

describe('readChunks', () => {
  const sharding = { key: { region: 1 }, uuid: 'u' };

  it('should read the chunks by uuid, keeping hashed bounds as Longs', async () => {
    const rows = [{ min: { region: 'a' }, max: { region: 'm' }, shard: 's1' }];
    const client = fakeClient({ chunks: { uuid: rows } });
    assert.deepStrictEqual(await readChunks(client, 'app', 'orders', sharding), rows);
    assert.deepStrictEqual(client.calls[0].filter, { uuid: 'u' });
    assert.strictEqual(client.calls[0].options.promoteLongs, false);
  });

  it('should fall back to the namespace for chunks that predate uuids', async () => {
    const rows = [{ min: {}, max: {}, shard: 's2' }];
    const client = fakeClient({ chunks: { ns: rows } });
    assert.deepStrictEqual(await readChunks(client, 'app', 'orders', sharding), rows);
    assert.deepStrictEqual(client.calls[1].filter, { ns: 'app.orders' });
  });

  it('should answer undefined to a user who may not read config, and rethrow anything else', async () => {
    assert.strictEqual(
      await readChunks(fakeClient({ error: unauthorized() }), 'a', 'b', sharding),
      undefined,
    );
    await assert.rejects(readChunks(fakeClient({ error: new Error('down') }), 'a', 'b', sharding));
  });
});
