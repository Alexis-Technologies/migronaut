const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildContext } = require('../../src/core/context.js');

const client = {};
const db = {};

describe('buildContext', () => {
  it('should include client and db', () => {
    const ctx = buildContext(client, db);
    assert.strictEqual(ctx.client, client);
    assert.strictEqual(ctx.db, db);
  });

  it('should omit mongoose when not provided', () => {
    const ctx = buildContext(client, db);
    assert.strictEqual('mongoose' in ctx, false);
  });

  it('should attach mongoose when provided', () => {
    const mongoose = {};
    const ctx = buildContext(client, db, mongoose);
    assert.strictEqual(ctx.mongoose, mongoose);
  });
});
