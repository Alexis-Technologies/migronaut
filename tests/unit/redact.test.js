const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { errorText } = require('../../src/utils/error.js');
const { redactDeep, redactOutbound, redactUris } = require('../../src/utils/redact.js');

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
