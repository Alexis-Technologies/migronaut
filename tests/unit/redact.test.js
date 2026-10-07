const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { errorText } = require('../../src/utils/error.js');
const {
  BOUNDS,
  redactBounded,
  redactDeep,
  redactOutbound,
  redactUris,
} = require('../../src/utils/redact.js');

describe('redactUris', () => {
  it('should mask the password in a URI anywhere inside a message', () => {
    const masked = redactUris(
      'Protocol and host list are required in "mongodb://ci-user:sup3rSecret@"',
    );
    assert.strictEqual(masked, 'Protocol and host list are required in "mongodb://ci-user:****@"');
  });

  it('should mask multi-host and srv URIs', () => {
    assert.strictEqual(
      redactUris('mongodb://u:p@h1:27017,h2:27017/db'),
      'mongodb://u:****@h1:27017,h2:27017/db',
    );
    assert.strictEqual(
      redactUris('failed: mongodb+srv://user:pass@cluster.example.com/db'),
      'failed: mongodb+srv://user:****@cluster.example.com/db',
    );
  });

  it('should mask every occurrence, not just the first', () => {
    const masked = redactUris('a mongodb://u:one@h b mongodb://u:two@h');
    assert.ok(!masked.includes('one'));
    assert.ok(!masked.includes('two'));
  });

  it('should leave URIs without credentials alone', () => {
    const text = 'connect to mongodb://localhost:27017/db failed';
    assert.strictEqual(redactUris(text), text);
  });

  it('should pass non-strings through unchanged', () => {
    assert.strictEqual(redactUris(undefined), undefined);
    assert.strictEqual(redactUris(42), 42);
  });
});

describe('redactDeep', () => {
  it('should redact strings nested in plain objects and arrays', () => {
    const input = {
      cause: 'bad uri mongodb://u:hunter2@host',
      issues: [{ message: 'saw mongodb://u:hunter2@host' }],
      count: 3,
    };
    const output = redactDeep(input);
    assert.ok(!JSON.stringify(output).includes('hunter2'));
    assert.strictEqual(output.count, 3);
    // Never mutates the input.
    assert.ok(input.cause.includes('hunter2'));
  });

  it('should leave class instances alone', () => {
    const date = new Date();
    assert.strictEqual(redactDeep(date), date);
  });
});

describe('errorText', () => {
  it('should stringify Errors and non-Errors with credentials masked', () => {
    assert.strictEqual(
      errorText(new Error('Invalid URL: mongodb://u:s3cret@:27017')),
      'Invalid URL: mongodb://u:****@:27017',
    );
    assert.strictEqual(errorText('plain string'), 'plain string');
    assert.strictEqual(errorText(7), '7');
  });
});

describe('redactUris — query-string secrets', () => {
  it('should mask secret-bearing query parameters', () => {
    assert.strictEqual(
      redactUris('mongodb://host/db?proxyPassword=hunter2&tlsCertificateKeyFilePassword=pemPw'),
      'mongodb://host/db?proxyPassword=****&tlsCertificateKeyFilePassword=****',
    );
    assert.strictEqual(
      redactUris('mongodb://host/db?sslKeyPassword=legacy&retryWrites=true'),
      'mongodb://host/db?sslKeyPassword=****&retryWrites=true',
    );
  });

  it('should mask only the secret pairs inside authMechanismProperties', () => {
    assert.strictEqual(
      redactUris(
        'mongodb+srv://c/?authMechanismProperties=SERVICE_NAME:mongodb,AWS_SESSION_TOKEN:FQoGtoken',
      ),
      'mongodb+srv://c/?authMechanismProperties=SERVICE_NAME:mongodb,AWS_SESSION_TOKEN:****',
    );
  });

  it('should mask a password behind an empty username', () => {
    assert.strictEqual(redactUris('mongodb://:pw@host/db'), 'mongodb://:****@host/db');
  });
});

describe('redactOutbound', () => {
  const E11000 =
    'E11000 duplicate key error collection: app.users index: email_1 dup key: ' +
    '{ email: "alice@example.com" }';

  it('should mask the data values a duplicate-key error quotes, keeping the index', () => {
    assert.strictEqual(
      redactOutbound(E11000),
      'E11000 duplicate key error collection: app.users index: email_1 dup key: { <redacted> }',
    );
    // A compound key, and values with braces inside strings, all go.
    assert.strictEqual(
      redactOutbound('… dup key: { a: "x}y", b: { c: 1 } }'),
      '… dup key: { <redacted> }',
    );
  });

  it('should still mask credentials, and leave a message without data alone', () => {
    assert.strictEqual(
      redactOutbound(`mongodb://u:pw@h failed — ${E11000}`),
      'mongodb://u:****@h failed — E11000 duplicate key error collection: app.users index: ' +
        'email_1 dup key: { <redacted> }',
    );
    assert.strictEqual(redactOutbound('lock held'), 'lock held');
    assert.strictEqual(redactOutbound(undefined), undefined);
  });

  it('should keep the rest of a multi-line stack', () => {
    const stack = `MongoServerError: ${E11000}\n    at insertOne (driver.js:1:1)`;
    assert.strictEqual(redactOutbound(stack).split('\n')[1], '    at insertOne (driver.js:1:1)');
  });
});

describe('redactBounded', () => {
  it('should copy plain objects and arrays with every string redacted', () => {
    const input = { uri: 'mongodb://u:secret@h/db', nested: { list: ['mongodb://a:b@h', 2] } };
    const { value, truncated } = redactBounded(input);
    assert.deepStrictEqual(value, {
      uri: 'mongodb://u:****@h/db',
      nested: { list: ['mongodb://a:****@h', 2] },
    });
    assert.strictEqual(truncated, false);
    assert.notStrictEqual(value.nested, input.nested, 'a copy, not the input');
    assert.strictEqual(input.uri, 'mongodb://u:secret@h/db', 'never mutated');
  });

  it('should keep class instances, null-prototype objects and scalars as they are', () => {
    const at = new Date(0);
    const id = { _bsontype: 'ObjectId' };
    Object.setPrototypeOf(id, class ObjectId {}.prototype);
    const bare = Object.create(null);
    bare.k = 'mongodb://u:p@h';
    const { value } = redactBounded({ at, id, bare, n: 1n, ok: true, none: null });
    assert.strictEqual(value.at, at);
    assert.strictEqual(value.id, id);
    assert.deepStrictEqual({ ...value.bare }, { k: 'mongodb://u:****@h' });
    assert.strictEqual(value.n, 1n);
    assert.strictEqual(value.none, null);
  });

  it('should leave the omitted key out of the top level only', () => {
    const { value } = redactBounded(
      { userland: true, data: { userland: true } },
      { omit: 'userland' },
    );
    assert.deepStrictEqual(value, { data: { userland: true } });
  });

  it('should clip a long string and say so', () => {
    const { value, truncated } = redactBounded({ text: 'x'.repeat(BOUNDS.string + 10) });
    assert.strictEqual(value.text.length, BOUNDS.string + 1);
    assert.ok(value.text.endsWith('…'));
    assert.strictEqual(truncated, true);
  });

  it('should end a cycle at the depth bound', () => {
    const cyclic = { name: 'a' };
    cyclic.self = cyclic;
    const { value, truncated } = redactBounded(cyclic);
    let level = value;
    let depth = 0;
    while (typeof level.self === 'object') {
      level = level.self;
      depth += 1;
    }
    assert.strictEqual(level.self, '[truncated]');
    assert.strictEqual(depth, BOUNDS.depth - 1);
    assert.strictEqual(truncated, true);
  });

  it('should stop copying entries past the budget', () => {
    const many = Array.from({ length: BOUNDS.entries + 50 }, (_, index) => index);
    const { value, truncated } = redactBounded({ many });
    // The `many` key itself takes one entry from the budget.
    assert.strictEqual(value.many.length, BOUNDS.entries - 1);
    assert.strictEqual(truncated, true);
  });
});
