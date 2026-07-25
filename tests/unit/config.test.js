const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');
const { DEFAULT_CONFIG, loadConfig } = require('../../src/core/config.js');
const { ConfigInvalidError } = require('../../src/errors/index.js');

const MIGRONAUT_ENV_KEYS = [
  'MIGRONAUT_URI',
  'MIGRONAUT_DB',
  'MIGRONAUT_MIGRATIONS_DIR',
  'MIGRONAUT_COLLECTION',
  'MIGRONAUT_LOCK_COLLECTION',
  'MIGRONAUT_LOCK_TTL',
  'MIGRONAUT_STRICT',
  'MIGRONAUT_USE_TRANSACTION',
  'MIGRONAUT_SEQUENTIAL',
  'MIGRONAUT_CREATE_EXTENSION',
];

let tmp;
const savedEnv = {};

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'migronaut-config-'));
  for (const key of MIGRONAUT_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const key of MIGRONAUT_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe('loadConfig', () => {
  it('should apply defaults when only required fields are provided', async () => {
    const config = await loadConfig({
      cwd: tmp,
      flags: { uri: 'mongodb://localhost:27017', dbName: 'test' },
    });
    assert.strictEqual(config.migrationsDir, DEFAULT_CONFIG.migrationsDir);
    assert.strictEqual(config.migrationsCollection, '_migronaut_migrations');
    assert.strictEqual(config.lockCollection, '_migronaut_locks');
    assert.strictEqual(config.lockTTLSeconds, 60);
    assert.strictEqual(config.strict, false);
    assert.strictEqual(config.useTransaction, false);
    assert.deepStrictEqual(config.fileExtensions, ['.ts', '.js']);
    assert.strictEqual(config.createExtension, 'js');
    assert.strictEqual(config.sequential, false);
  });

  it('should default uri and dbName to empty strings when requireDb is false', async () => {
    const config = await loadConfig({ cwd: tmp, requireDb: false });
    assert.strictEqual(config.uri, '');
    assert.strictEqual(config.dbName, '');
  });

  it('should let MIGRONAUT_CREATE_EXTENSION override the default', async () => {
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    process.env.MIGRONAUT_DB = 'env-db';
    process.env.MIGRONAUT_CREATE_EXTENSION = 'ts';
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.createExtension, 'ts');
  });

  it('should throw ConfigInvalidError on an invalid createExtension', async () => {
    await assert.rejects(
      loadConfig({
        cwd: tmp,
        flags: { uri: 'mongodb://x:27017', dbName: 'x', createExtension: 'py' },
      }),
      ConfigInvalidError,
    );
  });

  it('should work entirely from env vars with no config file', async () => {
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    process.env.MIGRONAUT_DB = 'env-db';
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.uri, 'mongodb://env-host:27017');
    assert.strictEqual(config.dbName, 'env-db');
  });

  it('should let CLI flags override env vars', async () => {
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    process.env.MIGRONAUT_DB = 'env-db';
    const config = await loadConfig({
      cwd: tmp,
      flags: { uri: 'mongodb://flag-host:27017' },
    });
    assert.strictEqual(config.uri, 'mongodb://flag-host:27017');
    assert.strictEqual(config.dbName, 'env-db');
  });

  it('should let env vars override config file', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.json'),
      JSON.stringify({ uri: 'mongodb://file-host:27017', dbName: 'file-db' }),
    );
    process.env.MIGRONAUT_DB = 'env-db';
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.uri, 'mongodb://file-host:27017');
    assert.strictEqual(config.dbName, 'env-db');
  });

  it('should treat the config file as optional', async () => {
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    process.env.MIGRONAUT_DB = 'env-db';
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.uri, 'mongodb://env-host:27017');
  });

  it('should load values from a JSON config file', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.json'),
      JSON.stringify({
        uri: 'mongodb://file-host:27017',
        dbName: 'file-db',
        lockTTLSeconds: 120,
        strict: true,
      }),
    );
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.uri, 'mongodb://file-host:27017');
    assert.strictEqual(config.lockTTLSeconds, 120);
    assert.strictEqual(config.strict, true);
  });

  it('should honor an explicit configPath over auto-discovery', async () => {
    const explicit = path.join(tmp, 'custom.config.json');
    writeFileSync(explicit, JSON.stringify({ uri: 'mongodb://x:27017', dbName: 'x' }));
    const config = await loadConfig({ cwd: tmp, configPath: 'custom.config.json' });
    assert.strictEqual(config.dbName, 'x');
  });

  it('should throw ConfigInvalidError when required fields are missing', async () => {
    await assert.rejects(loadConfig({ cwd: tmp }), ConfigInvalidError);
  });

  it('should throw ConfigInvalidError when lockTTLSeconds is not positive', async () => {
    await assert.rejects(
      loadConfig({
        cwd: tmp,
        flags: { uri: 'mongodb://x:27017', dbName: 'x', lockTTLSeconds: -1 },
      }),
      ConfigInvalidError,
    );
  });

  it('should throw ConfigInvalidError when configPath does not exist', async () => {
    await assert.rejects(
      loadConfig({ cwd: tmp, configPath: 'does-not-exist.json' }),
      ConfigInvalidError,
    );
  });

  it('should parse boolean env vars', async () => {
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    process.env.MIGRONAUT_DB = 'env-db';
    process.env.MIGRONAUT_STRICT = 'true';
    process.env.MIGRONAUT_USE_TRANSACTION = '1';
    process.env.MIGRONAUT_SEQUENTIAL = 'no';
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.strict, true);
    assert.strictEqual(config.useTransaction, true);
    assert.strictEqual(config.sequential, false);
  });

  it('should resolve a synchronous function (factory) config file', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.js'),
      "module.exports = () => ({ uri: 'mongodb://fn-host:27017', dbName: 'fn-db' });\n",
    );
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.uri, 'mongodb://fn-host:27017');
    assert.strictEqual(config.dbName, 'fn-db');
  });

  it('should resolve an async function config file (e.g. a secret fetch)', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.js'),
      `module.exports = async () => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return { uri: 'mongodb://secret-host:27017', dbName: 'secret-db', strict: true };
};
`,
    );
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.uri, 'mongodb://secret-host:27017');
    assert.strictEqual(config.strict, true);
  });

  it('should let env vars override a value returned by a function config', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.js'),
      "module.exports = () => ({ uri: 'mongodb://fn-host:27017', dbName: 'fn-db' });\n",
    );
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.uri, 'mongodb://env-host:27017');
    assert.strictEqual(config.dbName, 'fn-db');
  });

  it('should wrap a throwing config factory in ConfigInvalidError', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.js'),
      "module.exports = async () => { throw new Error('secret fetch failed'); };\n",
    );
    await assert.rejects(loadConfig({ cwd: tmp }), ConfigInvalidError);
  });

  it('should load env vars from a .env file via dotenv', async () => {
    writeFileSync(
      path.join(tmp, '.env'),
      'MIGRONAUT_URI=mongodb://dotenv-host:27017\nMIGRONAUT_DB=dotenv-db\n',
    );
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.uri, 'mongodb://dotenv-host:27017');
    assert.strictEqual(config.dbName, 'dotenv-db');
  });
});
