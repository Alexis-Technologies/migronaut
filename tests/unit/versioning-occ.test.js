const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  ConfigInvalidError,
  RevisionConflictError,
  ShapeVersionError,
} = require('../../src/errors/index.js');
const {
  bumpRevision,
  defineShapes,
  isVersion,
  findOneAndUpdateWithRevision,
  replaceWithRevision,
  retryOnConflict,
  updateWithRevision,
} = require('../../src/versioning/index.js');

/**
 * A collection double: `matched` decides whether a write matches, `current`
 * what the follow-up read finds. Every call is recorded in `calls`.
 */
function fakeCollection({ matched = true, current = null, readFails = false } = {}) {
  const calls = [];
  return {
    calls,
    collectionName: 'orders',
    updateOne: async (filter, update, options) => {
      calls.push(['updateOne', filter, update, options]);
      return { acknowledged: true, matchedCount: matched ? 1 : 0, modifiedCount: matched ? 1 : 0 };
    },
    replaceOne: async (filter, replacement, options) => {
      calls.push(['replaceOne', filter, replacement, options]);
      return { acknowledged: true, matchedCount: matched ? 1 : 0, modifiedCount: matched ? 1 : 0 };
    },
    findOneAndUpdate: async (filter, update, options) => {
      calls.push(['findOneAndUpdate', filter, update, options]);
      return { ok: 1, value: matched ? { _id: 1, __rev: 4 } : null };
    },
    findOne: async (filter, options) => {
      calls.push(['findOne', filter, options]);
      if (readFails) throw new Error('read failed');
      return current;
    },
  };
}

const conflict =
  (reason, extra = {}) =>
  (error) => {
    assert.ok(error instanceof RevisionConflictError);
    assert.strictEqual(error.code, 'REVISION_CONFLICT');
    assert.strictEqual(error.context.reason, reason);
    for (const [key, value] of Object.entries(extra)) {
      assert.deepStrictEqual(error.context[key], value);
    }
    return true;
  };

describe('updateWithRevision', () => {
  it('should guard the filter with the revision and bump it', async () => {
    const orders = fakeCollection();
    const result = await updateWithRevision(
      orders,
      { _id: 1 },
      3,
      { $set: { status: 'paid' } },
      { session: 's', version: 2 },
    );
    assert.deepStrictEqual(orders.calls[0], [
      'updateOne',
      { _id: 1, __rev: 3 },
      { $set: { status: 'paid', __v: 2 }, $inc: { __rev: 1 } },
      { session: 's' },
    ]);
    assert.strictEqual(result.revision, 4);
    assert.strictEqual(result.matchedCount, 1);
  });

  it('should match a legacy document without a revision as revision 0', async () => {
    const orders = fakeCollection();
    await updateWithRevision(orders, { _id: 1 }, 0, [{ $set: { a: 1 } }]);
    assert.deepStrictEqual(orders.calls[0][1], { _id: 1, __rev: { $in: [null, 0] } });
    assert.deepStrictEqual(orders.calls[0][2].at(-1), {
      $set: { __rev: { $add: [{ $ifNull: ['$__rev', 0] }, 1] } },
    });
  });

  it('should say whether a miss is a conflict, a missing document, or unknown', async () => {
    await assert.rejects(
      updateWithRevision(fakeCollection({ matched: false, current: { __rev: 5 } }), { _id: 1 }, 3, {
        $set: { a: 1 },
      }),
      conflict('conflict', { expected: 3, actual: 5, collection: 'orders' }),
    );
    await assert.rejects(
      updateWithRevision(fakeCollection({ matched: false }), { _id: 1 }, 3, { $set: { a: 1 } }),
      conflict('not-found'),
    );
    await assert.rejects(
      updateWithRevision(fakeCollection({ matched: false, current: { __rev: 3 } }), { _id: 1 }, 3, {
        $set: { a: 1 },
      }),
      conflict('unknown'),
    );
    await assert.rejects(
      updateWithRevision(fakeCollection({ matched: false, readFails: true }), { _id: 1 }, 3, {
        $set: { a: 1 },
      }),
      conflict('unknown'),
    );
    const unverified = fakeCollection({ matched: false, current: { __rev: 9 } });
    await assert.rejects(
      updateWithRevision(unverified, { _id: 1 }, 3, { $set: { a: 1 } }, { verify: false }),
      conflict('unknown'),
    );
    assert.strictEqual(unverified.calls.length, 1, 'no follow-up read');
  });

  it('should read the conflict without the revision guard, in the same session, keeping the filter out', async () => {
    const orders = fakeCollection({ matched: false, current: { __rev: 7 } });
    await assert.rejects(
      updateWithRevision(
        orders,
        { email: 'pii@example.com' },
        1,
        { $set: { a: 1 } },
        { session: 's' },
      ),
      (error) => {
        assert.ok(!JSON.stringify(error.context).includes('pii@example.com'));
        assert.ok(!error.message.includes('pii@example.com'));
        return true;
      },
    );
    assert.deepStrictEqual(orders.calls[1], [
      'findOne',
      { email: 'pii@example.com' },
      { projection: { __rev: 1 }, readPreference: 'primary', session: 's' },
    ]);
  });

  it('should refuse what would hide a conflict', async () => {
    const orders = fakeCollection();
    const refuse = (promise, pattern) =>
      assert.rejects(
        promise,
        (error) => error instanceof ConfigInvalidError && pattern.test(error.message),
      );
    await refuse(
      updateWithRevision(orders, {}, 1, { $set: {} }, { upsert: true }),
      /cannot upsert/,
    );
    await refuse(
      updateWithRevision(orders, {}, 1, { $set: {} }, { writeConcern: { w: 0 } }),
      /w: 0/,
    );
    await refuse(updateWithRevision(orders, {}, 1, { $set: {} }, { w: 0 }), /w: 0/);
    await refuse(updateWithRevision(orders, { __rev: 1 }, 1, { $set: {} }), /must not constrain/);
    await refuse(updateWithRevision(orders, {}, 1, { $inc: { __rev: 1 } }), /revision field/);
    await refuse(updateWithRevision(orders, {}, 1, { a: 1 }), /replaceWithRevision/);
    await refuse(updateWithRevision(orders, {}, -1, { $set: {} }), /expectedRevision/);
    await refuse(updateWithRevision(orders, {}, 1.5, { $set: {} }), /expectedRevision/);
    await refuse(updateWithRevision(orders, 'x', 1, { $set: {} }), /filter must be an object/);
    await refuse(updateWithRevision(orders, {}, 1, { $set: {} }, 'x'), /options must be an object/);
    await refuse(
      updateWithRevision(orders, {}, 1, { $set: {} }, { revisionField: 'a.b' }),
      /top-level/,
    );
    assert.strictEqual(orders.calls.length, 0);
  });

  it('should honour custom field names', async () => {
    const orders = fakeCollection();
    await updateWithRevision(
      orders,
      { _id: 1 },
      2,
      { $set: { a: 1 } },
      {
        field: 'v',
        revisionField: 'rev',
        version: 3,
      },
    );
    assert.deepStrictEqual(orders.calls[0].slice(1, 3), [
      { _id: 1, rev: 2 },
      { $set: { a: 1, v: 3 }, $inc: { rev: 1 } },
    ]);
  });
});

describe('replaceWithRevision', () => {
  it('should overwrite the stale revision of the replacement with the next one', async () => {
    const orders = fakeCollection();
    const result = await replaceWithRevision(
      orders,
      { _id: 1 },
      4,
      { _id: 1, name: 'x', __v: 1, __rev: 4 },
      { version: 2 },
    );
    assert.deepStrictEqual(orders.calls[0].slice(1), [
      { _id: 1, __rev: 4 },
      { _id: 1, name: 'x', __v: 2, __rev: 5 },
      {},
    ]);
    assert.strictEqual(result.revision, 5);
    await replaceWithRevision(orders, { _id: 1 }, 0, {});
    assert.deepStrictEqual(orders.calls[1][2], { __rev: 1 });
  });

  it('should refuse an operator update and report a miss', async () => {
    const orders = fakeCollection();
    await assert.rejects(
      replaceWithRevision(orders, {}, 1, { $set: { a: 1 } }),
      ConfigInvalidError,
    );
    await assert.rejects(replaceWithRevision(orders, {}, 1, [{ a: 1 }]), ConfigInvalidError);
    await assert.rejects(
      replaceWithRevision(orders, {}, 1, { a: 1 }, { version: -2 }),
      ConfigInvalidError,
    );
    await assert.rejects(
      replaceWithRevision(fakeCollection({ matched: false, current: { __rev: 2 } }), {}, 1, {
        a: 1,
      }),
      conflict('conflict', { actual: 2 }),
    );
  });
});

describe('findOneAndUpdateWithRevision', () => {
  it('should return the document after the update, whatever the driver version', async () => {
    const orders = fakeCollection();
    const doc = await findOneAndUpdateWithRevision(orders, { _id: 1 }, 3, { $set: { a: 1 } });
    assert.deepStrictEqual(doc, { _id: 1, __rev: 4 });
    assert.deepStrictEqual(orders.calls[0][3], {
      returnDocument: 'after',
      includeResultMetadata: true,
    });
    await findOneAndUpdateWithRevision(
      orders,
      { _id: 1 },
      3,
      { $set: { a: 1 } },
      {
        returnDocument: 'before',
        includeResultMetadata: false,
      },
    );
    assert.deepStrictEqual(orders.calls[1][3], {
      returnDocument: 'before',
      includeResultMetadata: true,
    });
  });

  it('should report a miss as a conflict', async () => {
    await assert.rejects(
      findOneAndUpdateWithRevision(fakeCollection({ matched: false }), { _id: 1 }, 3, {
        $set: { a: 1 },
      }),
      conflict('not-found'),
    );
    const nothing = { ...fakeCollection(), findOneAndUpdate: async () => null };
    await assert.rejects(
      findOneAndUpdateWithRevision(nothing, { _id: 1 }, 3, { $set: { a: 1 } }),
      RevisionConflictError,
    );
  });
});

describe('retryOnConflict', () => {
  const conflictError = (reason) => new RevisionConflictError('x', { reason });

  it('should retry conflicts up to the attempt budget', async () => {
    const waits = [];
    let calls = 0;
    const value = await retryOnConflict(
      async (attempt) => {
        calls += 1;
        if (attempt < 2) throw conflictError(attempt === 0 ? 'conflict' : 'unknown');
        return 'done';
      },
      {
        attempts: 3,
        backoff: (attempt) => {
          waits.push(attempt);
          return 0;
        },
      },
    );
    assert.strictEqual(value, 'done');
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(waits, [0, 1]);
    await assert.rejects(
      retryOnConflict(() => Promise.reject(conflictError('conflict')), {
        attempts: 2,
        backoff: { baseMs: 0 },
      }),
      RevisionConflictError,
    );
  });

  it('should never retry a missing document or another error', async () => {
    let calls = 0;
    await assert.rejects(
      retryOnConflict(() => {
        calls += 1;
        throw conflictError('not-found');
      }),
      RevisionConflictError,
    );
    await assert.rejects(
      retryOnConflict(() => {
        calls += 1;
        throw new TypeError('bug');
      }),
      TypeError,
    );
    assert.strictEqual(calls, 2);
  });

  it('should stop a wait on abort, and validate its arguments', async () => {
    const controller = new AbortController();
    const pending = retryOnConflict(() => Promise.reject(conflictError('conflict')), {
      backoff: () => 60_000,
      signal: controller.signal,
    });
    setImmediate(() => controller.abort(new Error('stopped')));
    await assert.rejects(pending, /stopped/);
    const aborted = AbortSignal.abort(new Error('already'));
    await assert.rejects(
      retryOnConflict(() => Promise.reject(conflictError('conflict')), { signal: aborted }),
      /already/,
    );
    await assert.rejects(retryOnConflict('x'), ConfigInvalidError);
    await assert.rejects(
      retryOnConflict(() => 1, { attempts: 0 }),
      ConfigInvalidError,
    );
    assert.strictEqual(await retryOnConflict(() => 7), 7);
  });
});

describe('bumpRevision', () => {
  it('should add the revision bump to an update or a pipeline', () => {
    assert.deepStrictEqual(bumpRevision({ $set: { a: 1 } }), {
      $set: { a: 1 },
      $inc: { __rev: 1 },
    });
    assert.deepStrictEqual(bumpRevision({}, { revisionField: 'rev' }), { $inc: { rev: 1 } });
    assert.strictEqual(bumpRevision([]).length, 1);
  });
});

describe('defineShapes', () => {
  const orders = { versioning: { current: 2 } };

  it('should read versioning from a map or a definition list', () => {
    const shapes = defineShapes({ orders, users: { default: { versioning: { current: 1 } } } });
    assert.deepStrictEqual(shapes.names, ['orders', 'users']);
    assert.ok(shapes.has('orders') && !shapes.has('nope'));
    assert.strictEqual(shapes.current('users'), 1);
    assert.strictEqual(shapes.get('orders').revisionField, '__rev');
    const fromList = defineShapes([
      { name: 'orders', ...orders },
      { name: 'logs', indexes: [] },
    ]);
    assert.deepStrictEqual(fromList.names, ['orders']);
    assert.ok(Object.isFrozen(fromList));
  });

  it('should refuse what it cannot read', () => {
    assert.throws(() => defineShapes('x'), ConfigInvalidError);
    assert.throws(() => defineShapes({ logs: { indexes: [] } }), /declares no versioning/);
    assert.throws(() => defineShapes([{ versioning: { current: 1 } }]), /needs a name/);
    assert.throws(
      () =>
        defineShapes([
          { name: 'a', ...orders },
          { name: 'a', ...orders },
        ]),
      /declared twice/,
    );
    assert.throws(
      () => defineShapes({ orders: { versioning: { current: 0 } } }),
      /orders\.versioning/,
    );
    assert.throws(() => defineShapes({ orders }).current('users'), /not a versioned collection/);
    assert.throws(() => defineShapes([]).get('x'), /known: none/);
  });

  it('should read, compare and stamp versions', () => {
    const shapes = defineShapes({ orders });
    assert.strictEqual(shapes.versionOf('orders', {}), 0);
    assert.ok(shapes.isCurrent('orders', { __v: 2 }));
    assert.ok(!shapes.isCurrent('orders', { __v: 1 }));
    assert.throws(
      () => shapes.versionOf('orders', { __v: 'x' }),
      (error) => error instanceof ShapeVersionError && error.context.reason === 'invalid',
    );
    assert.deepStrictEqual(shapes.stamp('orders', { a: 1 }), { a: 1, __v: 2, __rev: 0 });
    assert.deepStrictEqual(shapes.onInsert('orders', [{ a: 1 }, { __v: 1 }]), [
      { a: 1, __v: 2, __rev: 0 },
      { __v: 1, __rev: 0 },
    ]);
    assert.deepStrictEqual(shapes.onInsert('orders', {}), { __v: 2, __rev: 0 });
  });

  it('should stamp an upsert on insert only', () => {
    const shapes = defineShapes({ orders });
    assert.deepStrictEqual(
      shapes.stampUpsert('orders', { $set: { a: 1 }, $setOnInsert: { b: 1 } }),
      {
        $set: { a: 1 },
        $setOnInsert: { b: 1, __v: 2 },
        $inc: { __rev: 1 },
      },
    );
    assert.deepStrictEqual(shapes.stampUpsert('orders', { $set: { __v: 2 } }), {
      $set: { __v: 2 },
      $inc: { __rev: 1 },
    });
    const noRevision = defineShapes({ orders: { versioning: { current: 1, revision: false } } });
    assert.deepStrictEqual(noRevision.stampUpsert('orders', {}), { $setOnInsert: { __v: 1 } });
    assert.throws(() => shapes.stampUpsert('orders', [{ $set: {} }]), /not a pipeline/);
    assert.throws(() => shapes.stampUpsert('orders', { a: 1 }), /not a replacement/);
    assert.throws(() => shapes.stampUpsert('orders', { $inc: { __rev: 1 } }), /revision field/);
  });
});

describe('isVersion and the typed form of defineShapes', () => {
  it('should compare a document version, a missing field being 0', () => {
    assert.ok(isVersion({}, 0));
    assert.ok(isVersion({ __v: null }, 0));
    assert.ok(isVersion({ __v: 2 }, 2));
    assert.ok(!isVersion({ __v: 2 }, 1));
    assert.ok(isVersion({ schemaVersion: 3 }, 3, { field: 'schemaVersion' }));
    assert.ok(!isVersion({ __v: 'x' }, 0));
  });

  it('should return itself when called without arguments, for defineShapes<Shapes>()(…)', () => {
    const typed = defineShapes()({ orders: { versioning: { current: 2 } } });
    assert.strictEqual(typed.current('orders'), 2);
    assert.ok(typed.isVersion('orders', { __v: 1 }, 1));
    assert.ok(!typed.isVersion('orders', { __v: 1 }, 2));
    assert.throws(() => defineShapes(undefined), ConfigInvalidError);
  });
});

describe('revision guards — hardening', () => {
  it('should refuse an _id given as an operator, and take a plain $eq', async () => {
    const orders = fakeCollection();
    for (const _id of [{ $ne: null }, { $in: [1, 2] }, { $eq: { $gt: 1 } }]) {
      await assert.rejects(
        updateWithRevision(orders, { _id }, 0, { $set: { a: 1 } }),
        (error) => error instanceof ConfigInvalidError && /operator/.test(error.message),
      );
    }
    await updateWithRevision(orders, { _id: { $eq: 7 } }, 0, { $set: { a: 1 } });
    assert.deepStrictEqual(orders.calls.at(-1)[1], { _id: { $eq: 7 }, __rev: { $in: [null, 0] } });
  });

  it('should take only a revision field — Mongoose keeping __v as its revision', async () => {
    const orders = fakeCollection();
    await updateWithRevision(orders, { _id: 1 }, 3, { $set: { a: 1 } }, { revisionField: '__v' });
    assert.deepStrictEqual(orders.calls.at(-1)[1], { _id: 1, __v: 3 });
    assert.deepStrictEqual(orders.calls.at(-1)[2], { $set: { a: 1 }, $inc: { __v: 1 } });
    assert.deepStrictEqual(bumpRevision({ $set: { a: 1 } }, { revisionField: '__v' }), {
      $set: { a: 1 },
      $inc: { __v: 1 },
    });
    // Setting the version too needs two different fields.
    await assert.rejects(
      updateWithRevision(orders, { _id: 1 }, 3, {}, { revisionField: '__v', version: 2 }),
      /must differ/,
    );
  });

  it('should take a revision read as a Long, an Int32 or a bigint', async () => {
    const { Int32, Long } = require('mongodb');
    const orders = fakeCollection();
    for (const revision of [Long.fromNumber(5), new Int32(5), 5n]) {
      const result = await updateWithRevision(orders, { _id: 1 }, revision, { $set: { a: 1 } });
      assert.strictEqual(result.revision, 6);
      assert.deepStrictEqual(orders.calls.at(-1)[1], { _id: 1, __rev: 5 });
    }
    await assert.rejects(updateWithRevision(orders, { _id: 1 }, -1n, {}), /expectedRevision/);
  });

  it('should refuse a write the server did not acknowledge', async () => {
    const orders = fakeCollection();
    orders.updateOne = async () => ({ acknowledged: false });
    await assert.rejects(
      updateWithRevision(orders, { _id: 1 }, 0, { $set: { a: 1 } }),
      /acknowledged/,
    );
  });

  it('should re-read a miss the way the write matched', async () => {
    const orders = fakeCollection({ matched: false, current: { __rev: 9 } });
    const collation = { locale: 'en', strength: 2 };
    await assert.rejects(
      updateWithRevision(orders, { email: 'A@B' }, 1, { $set: { a: 1 } }, { collation, hint: 'h' }),
      conflict('conflict', { actual: 9 }),
    );
    assert.deepStrictEqual(orders.calls[1][2], {
      projection: { __rev: 1 },
      readPreference: 'primary',
      collation,
      hint: 'h',
    });
  });

  it('should name the version when it is the version that is wrong', async () => {
    await assert.rejects(
      replaceWithRevision(fakeCollection(), { _id: 1 }, 0, { a: 1 }, { version: -1 }),
      /^ConfigInvalidError: version must be/,
    );
  });
});

describe('shapes.occ — guards bound to a collection', () => {
  const shapes = defineShapes({
    orders: { versioning: { current: 2, field: 'schemaVersion', revisionField: 'rev' } },
    flat: { versioning: { current: 1, revision: false } },
  });

  it('should write with the collection field names, whatever the call forgets', async () => {
    const orders = fakeCollection();
    const occ = shapes.occ('orders');
    await occ.updateWithRevision(orders, { _id: 1 }, 2, { $set: { a: 1 } }, { version: 2 });
    const [, filter, update] = orders.calls.at(-1);
    assert.deepStrictEqual(filter, { _id: 1, rev: 2 });
    assert.deepStrictEqual(update, { $set: { a: 1, schemaVersion: 2 }, $inc: { rev: 1 } });
    await occ.replaceWithRevision(orders, { _id: 1 }, 0, { a: 1 });
    assert.deepStrictEqual(orders.calls.at(-1)[2], { a: 1, rev: 1 });
    assert.deepStrictEqual(occ.bumpRevision({ $set: { a: 1 } }), {
      $set: { a: 1 },
      $inc: { rev: 1 },
    });
    await assert.rejects(
      occ.updateWithRevision(orders, { _id: 1 }, 0, {}, { revisionField: '__rev' }),
      /take no other/,
    );
    assert.throws(() => shapes.occ('flat'), /revision: false/);
  });
});
