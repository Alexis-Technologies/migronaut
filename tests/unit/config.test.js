const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');
const {
  DEFAULT_CONFIG,
  isCollectionName,
  loadConfig,
  validateConfig,
} = require('../../src/core/config.js');
const { ConfigInvalidError } = require('../../src/errors/index.js');

/** A fully valid config for validateConfig tests — override per case */
const validConfig = (overrides = {}) => ({
  ...DEFAULT_CONFIG,
  uri: 'mongodb://localhost:27017',
  dbName: 'app',
  ...overrides,
});

const MIGRONAUT_ENV_KEYS = [
  'MIGRONAUT_ENV_FILE',
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

  it('should accept every documented boolean spelling', async () => {
    for (const [value, expected] of [
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['yes', true],
      [' Yes ', true],
      ['false', false],
      ['0', false],
      ['no', false],
    ]) {
      process.env.MIGRONAUT_STRICT = value;
      const config = await loadConfig({
        cwd: tmp,
        flags: { uri: 'mongodb://x:27017', dbName: 'x' },
      });
      assert.strictEqual(config.strict, expected, `MIGRONAUT_STRICT=${value}`);
    }
  });

  it('should reject an unrecognized boolean env var instead of silently disabling it', async () => {
    // Fail closed: `MIGRONAUT_STRICT=on` must never quietly turn checksum
    // enforcement off.
    process.env.MIGRONAUT_STRICT = 'on';
    await assert.rejects(
      loadConfig({ cwd: tmp, flags: { uri: 'mongodb://x:27017', dbName: 'x' } }),
      (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.strictEqual(error.context.name, 'MIGRONAUT_STRICT');
        assert.strictEqual(error.context.value, 'on');
        return true;
      },
    );
  });

  it('should reject unrecognized values for every boolean env var', async () => {
    for (const key of ['MIGRONAUT_STRICT', 'MIGRONAUT_USE_TRANSACTION', 'MIGRONAUT_SEQUENTIAL']) {
      process.env[key] = 'maybe';
      await assert.rejects(
        loadConfig({ cwd: tmp, flags: { uri: 'mongodb://x:27017', dbName: 'x' } }),
        ConfigInvalidError,
      );
      delete process.env[key];
    }
  });

  it('should not let a JSON config poison the prototype via __proto__', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.json'),
      JSON.stringify({ __proto__: { uri: 'mongodb://attacker:27017' }, dbName: 'shop' }),
    );
    const config = await loadConfig({ cwd: tmp, flags: { uri: 'mongodb://legit:27017' } });
    assert.strictEqual(config.uri, 'mongodb://legit:27017');
    assert.strictEqual(config.dbName, 'shop');
    assert.strictEqual(Object.getPrototypeOf(config), Object.prototype);
    assert.strictEqual({}.uri, undefined);
  });

  it('should ignore constructor/prototype keys from a JSON config', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.json'),
      '{"constructor": "boom", "prototype": "boom", "dbName": "shop"}',
    );
    const config = await loadConfig({ cwd: tmp, flags: { uri: 'mongodb://legit:27017' } });
    assert.strictEqual(config.dbName, 'shop');
    assert.strictEqual(typeof config.constructor, 'function');
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

  it('should load env vars from a .env file', async () => {
    writeFileSync(
      path.join(tmp, '.env'),
      'MIGRONAUT_URI=mongodb://dotenv-host:27017\nMIGRONAUT_DB=dotenv-db\n',
    );
    const config = await loadConfig({ cwd: tmp });
    assert.strictEqual(config.uri, 'mongodb://dotenv-host:27017');
    assert.strictEqual(config.dbName, 'dotenv-db');
  });
});

describe('isCollectionName', () => {
  it('should accept ordinary collection names', () => {
    for (const name of ['changelog', '_migronaut_migrations', 'a.b', 'Mixed-Case_1']) {
      assert.strictEqual(isCollectionName(name), true, name);
    }
  });

  it('should reject empty, $-bearing, NUL-bearing and system.* names', () => {
    for (const name of ['', 'a$b', 'a\0b', 'system.users', 'system.', null, 42, undefined]) {
      assert.strictEqual(isCollectionName(name), false, String(name));
    }
  });
});

describe('validateConfig', () => {
  it('should return no issues for a valid config', () => {
    assert.deepStrictEqual(validateConfig(validConfig()), []);
  });

  it('should report a missing or empty uri and dbName', () => {
    const issues = validateConfig(validConfig({ uri: '', dbName: undefined }));
    assert.deepStrictEqual(issues, [
      { path: 'uri', message: 'uri is required' },
      { path: 'dbName', message: 'dbName is required' },
    ]);
  });

  it('should report a non-positive lockTTLSeconds', () => {
    const issues = validateConfig(validConfig({ lockTTLSeconds: -1 }));
    assert.deepStrictEqual(issues, [
      { path: 'lockTTLSeconds', message: 'must be a positive integer' },
    ]);
  });

  it('should report a non-integer lockTTLSeconds', () => {
    const issues = validateConfig(validConfig({ lockTTLSeconds: 1.5 }));
    assert.strictEqual(issues[0].path, 'lockTTLSeconds');
  });

  it('should report an invalid createExtension', () => {
    const issues = validateConfig(validConfig({ createExtension: 'py' }));
    assert.deepStrictEqual(issues, [{ path: 'createExtension', message: "must be 'ts' or 'js'" }]);
  });

  it('should report an empty fileExtensions array', () => {
    const issues = validateConfig(validConfig({ fileExtensions: [] }));
    assert.deepStrictEqual(issues, [
      { path: 'fileExtensions', message: 'must be a non-empty array of non-empty strings' },
    ]);
  });

  it('should report a non-boolean strict', () => {
    const issues = validateConfig(validConfig({ strict: 'yes' }));
    assert.deepStrictEqual(issues, [{ path: 'strict', message: 'must be a boolean' }]);
  });

  it('should reject bookkeeping collections in the system namespace', () => {
    for (const key of ['migrationsCollection', 'lockCollection']) {
      const issues = validateConfig(validConfig({ [key]: 'system.users' }));
      assert.strictEqual(issues.length, 1);
      assert.strictEqual(issues[0].path, key);
    }
  });

  it('should reject collection names containing $ or NUL', () => {
    assert.strictEqual(validateConfig(validConfig({ lockCollection: 'a$b' })).length, 1);
    assert.strictEqual(validateConfig(validConfig({ lockCollection: 'a\0b' })).length, 1);
  });

  it('should report an empty templatePath but allow an absent one', () => {
    assert.deepStrictEqual(validateConfig(validConfig()), []);
    const issues = validateConfig(validConfig({ templatePath: '' }));
    assert.deepStrictEqual(issues, [
      { path: 'templatePath', message: 'must be a non-empty string' },
    ]);
  });

  it('should allow empty uri and dbName when requireDb is false', () => {
    const issues = validateConfig(validConfig({ uri: '', dbName: '' }), { requireDb: false });
    assert.deepStrictEqual(issues, []);
  });

  it('should still require string uri and dbName when requireDb is false', () => {
    const issues = validateConfig(validConfig({ uri: 42, dbName: '' }), { requireDb: false });
    assert.deepStrictEqual(issues, [{ path: 'uri', message: 'must be a string' }]);
  });

  it('should tolerate unknown keys and live instances', () => {
    const config = validConfig({
      unknownKey: 'anything',
      mongoose: { model: () => {} },
      hooks: { beforeAll: () => {} },
      logger: null,
    });
    assert.deepStrictEqual(validateConfig(config), []);
  });

  it('should surface issues through loadConfig as ConfigInvalidError context', async () => {
    try {
      await loadConfig({
        cwd: tmp,
        flags: { uri: 'mongodb://x:27017', dbName: 'x', createExtension: 'py' },
      });
      assert.fail('expected loadConfig to reject');
    } catch (error) {
      assert.ok(error instanceof ConfigInvalidError);
      assert.deepStrictEqual(error.context.issues, [
        { path: 'createExtension', message: "must be 'ts' or 'js'" },
      ]);
    }
  });
});

describe('envFile control', () => {
  it('should load .env from the working directory by default', async () => {
    writeFileSync(path.join(tmp, '.env'), 'MIGRONAUT_DB=from-dotenv\n');
    const config = await loadConfig({ cwd: tmp, flags: { uri: 'mongodb://x:27017' } });
    assert.strictEqual(config.dbName, 'from-dotenv');
  });

  it('should load an alternative file when envFile names one', async () => {
    writeFileSync(path.join(tmp, '.env.ci'), 'MIGRONAUT_DB=from-ci\n');
    const config = await loadConfig({
      cwd: tmp,
      flags: { uri: 'mongodb://x:27017', envFile: '.env.ci' },
    });
    assert.strictEqual(config.dbName, 'from-ci');
  });

  it('should skip .env entirely when envFile is false', async () => {
    // A stray .env must not silently outrank an explicit value.
    writeFileSync(path.join(tmp, '.env'), 'MIGRONAUT_DB=from-dotenv\n');
    const config = await loadConfig({
      cwd: tmp,
      flags: { uri: 'mongodb://x:27017', dbName: 'explicit', envFile: false },
    });
    assert.strictEqual(config.dbName, 'explicit');
    assert.strictEqual(process.env.MIGRONAUT_DB, undefined);
  });

  it('should honor MIGRONAUT_ENV_FILE', async () => {
    writeFileSync(path.join(tmp, 'custom.env'), 'MIGRONAUT_DB=from-custom\n');
    process.env.MIGRONAUT_ENV_FILE = 'custom.env';
    const config = await loadConfig({ cwd: tmp, flags: { uri: 'mongodb://x:27017' } });
    assert.strictEqual(config.dbName, 'from-custom');
  });

  it('should reject an envFile that is neither a string nor false', () => {
    assert.strictEqual(validateConfig(validConfig({ envFile: 42 })).length, 1);
  });
});
