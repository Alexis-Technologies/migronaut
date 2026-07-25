import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../../src/core/config.js';
import { ConfigInvalidError } from '../../src/errors/index.js';

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

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

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
    expect(config.migrationsDir).toBe(DEFAULT_CONFIG.migrationsDir);
    expect(config.migrationsCollection).toBe('_migronaut_migrations');
    expect(config.lockCollection).toBe('_migronaut_locks');
    expect(config.lockTTLSeconds).toBe(60);
    expect(config.strict).toBe(false);
    expect(config.useTransaction).toBe(false);
    expect(config.fileExtensions).toEqual(['.ts', '.js']);
    expect(config.createExtension).toBe('js');
    expect(config.sequential).toBe(false);
  });

  it('should default uri and dbName to empty strings when requireDb is false', async () => {
    const config = await loadConfig({ cwd: tmp, requireDb: false });
    expect(config.uri).toBe('');
    expect(config.dbName).toBe('');
  });

  it('should let MIGRONAUT_CREATE_EXTENSION override the default', async () => {
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    process.env.MIGRONAUT_DB = 'env-db';
    process.env.MIGRONAUT_CREATE_EXTENSION = 'ts';
    const config = await loadConfig({ cwd: tmp });
    expect(config.createExtension).toBe('ts');
  });

  it('should throw ConfigInvalidError on an invalid createExtension', async () => {
    await expect(
      loadConfig({
        cwd: tmp,
        // biome-ignore lint/suspicious/noExplicitAny: testing an invalid value
        flags: { uri: 'mongodb://x:27017', dbName: 'x', createExtension: 'py' as any },
      }),
    ).rejects.toBeInstanceOf(ConfigInvalidError);
  });

  it('should work entirely from env vars with no config file', async () => {
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    process.env.MIGRONAUT_DB = 'env-db';
    const config = await loadConfig({ cwd: tmp });
    expect(config.uri).toBe('mongodb://env-host:27017');
    expect(config.dbName).toBe('env-db');
  });

  it('should let CLI flags override env vars', async () => {
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    process.env.MIGRONAUT_DB = 'env-db';
    const config = await loadConfig({
      cwd: tmp,
      flags: { uri: 'mongodb://flag-host:27017' },
    });
    expect(config.uri).toBe('mongodb://flag-host:27017');
    expect(config.dbName).toBe('env-db');
  });

  it('should let env vars override config file', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.json'),
      JSON.stringify({ uri: 'mongodb://file-host:27017', dbName: 'file-db' }),
    );
    process.env.MIGRONAUT_DB = 'env-db';
    const config = await loadConfig({ cwd: tmp });
    expect(config.uri).toBe('mongodb://file-host:27017');
    expect(config.dbName).toBe('env-db');
  });

  it('should treat the config file as optional', async () => {
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    process.env.MIGRONAUT_DB = 'env-db';
    const config = await loadConfig({ cwd: tmp });
    expect(config.uri).toBe('mongodb://env-host:27017');
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
    expect(config.uri).toBe('mongodb://file-host:27017');
    expect(config.lockTTLSeconds).toBe(120);
    expect(config.strict).toBe(true);
  });

  it('should honor an explicit configPath over auto-discovery', async () => {
    const explicit = path.join(tmp, 'custom.config.json');
    writeFileSync(explicit, JSON.stringify({ uri: 'mongodb://x:27017', dbName: 'x' }));
    const config = await loadConfig({ cwd: tmp, configPath: 'custom.config.json' });
    expect(config.dbName).toBe('x');
  });

  it('should throw ConfigInvalidError when required fields are missing', async () => {
    await expect(loadConfig({ cwd: tmp })).rejects.toBeInstanceOf(ConfigInvalidError);
  });

  it('should throw ConfigInvalidError when lockTTLSeconds is not positive', async () => {
    await expect(
      loadConfig({
        cwd: tmp,
        flags: { uri: 'mongodb://x:27017', dbName: 'x', lockTTLSeconds: -1 },
      }),
    ).rejects.toBeInstanceOf(ConfigInvalidError);
  });

  it('should throw ConfigInvalidError when configPath does not exist', async () => {
    await expect(
      loadConfig({ cwd: tmp, configPath: 'does-not-exist.json' }),
    ).rejects.toBeInstanceOf(ConfigInvalidError);
  });

  it('should parse boolean env vars', async () => {
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    process.env.MIGRONAUT_DB = 'env-db';
    process.env.MIGRONAUT_STRICT = 'true';
    process.env.MIGRONAUT_USE_TRANSACTION = '1';
    process.env.MIGRONAUT_SEQUENTIAL = 'no';
    const config = await loadConfig({ cwd: tmp });
    expect(config.strict).toBe(true);
    expect(config.useTransaction).toBe(true);
    expect(config.sequential).toBe(false);
  });

  it('should resolve a synchronous function (factory) config file', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.js'),
      "module.exports = () => ({ uri: 'mongodb://fn-host:27017', dbName: 'fn-db' });\n",
    );
    const config = await loadConfig({ cwd: tmp });
    expect(config.uri).toBe('mongodb://fn-host:27017');
    expect(config.dbName).toBe('fn-db');
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
    expect(config.uri).toBe('mongodb://secret-host:27017');
    expect(config.strict).toBe(true);
  });

  it('should let env vars override a value returned by a function config', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.js'),
      "module.exports = () => ({ uri: 'mongodb://fn-host:27017', dbName: 'fn-db' });\n",
    );
    process.env.MIGRONAUT_URI = 'mongodb://env-host:27017';
    const config = await loadConfig({ cwd: tmp });
    expect(config.uri).toBe('mongodb://env-host:27017');
    expect(config.dbName).toBe('fn-db');
  });

  it('should wrap a throwing config factory in ConfigInvalidError', async () => {
    writeFileSync(
      path.join(tmp, 'migronaut.config.js'),
      "module.exports = async () => { throw new Error('secret fetch failed'); };\n",
    );
    await expect(loadConfig({ cwd: tmp })).rejects.toBeInstanceOf(ConfigInvalidError);
  });

  it('should load env vars from a .env file via dotenv', async () => {
    writeFileSync(
      path.join(tmp, '.env'),
      'MIGRONAUT_URI=mongodb://dotenv-host:27017\nMIGRONAUT_DB=dotenv-db\n',
    );
    const config = await loadConfig({ cwd: tmp });
    expect(config.uri).toBe('mongodb://dotenv-host:27017');
    expect(config.dbName).toBe('dotenv-db');
  });
});
