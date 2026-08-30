const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { errorText } = require('../../src/utils/error.js');
const { redactDeep, redactUris } = require('../../src/utils/redact.js');

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
