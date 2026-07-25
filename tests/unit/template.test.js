const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');
const {
  ConfigFileExistsError,
  ConfigInvalidError,
  MigrationFileNotFoundError,
} = require('../../src/errors/index.js');
const {
  buildPrefix,
  configTemplateContent,
  createConfigFile,
  createMigrationFile,
  defaultConfigJs,
  defaultConfigJson,
  defaultConfigTs,
  defaultTemplateJs,
  defaultTemplateTs,
  nextSequenceIndex,
  resolveTemplateContent,
  secretConfigJs,
  secretConfigTs,
  slugify,
} = require('../../src/utils/template.js');

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'migronaut-template-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('slugify', () => {
  it('should kebab-case a mixed-case spaced name', () => {
    assert.strictEqual(slugify('Add Users Index'), 'add-users-index');
  });

  it('should strip leading and trailing separators', () => {
    assert.strictEqual(slugify('  __Hello!! World__  '), 'hello-world');
  });
});

describe('buildPrefix', () => {
  it('should zero-pad sequential indexes to 4 digits', () => {
    assert.strictEqual(buildPrefix({ sequential: true, index: 7 }), '0007');
  });

  it('should produce a 14-digit timestamp when not sequential', () => {
    assert.match(buildPrefix({ sequential: false, index: 1 }), /^\d{14}$/);
  });
});

describe('nextSequenceIndex', () => {
  it('should return 1 for a missing directory', async () => {
    assert.strictEqual(await nextSequenceIndex(path.join(tmp, 'nope'), ['.ts', '.js']), 1);
  });

  it('should count existing migration files', async () => {
    writeFileSync(path.join(tmp, '0001-a.ts'), '');
    writeFileSync(path.join(tmp, '0002-b.js'), '');
    writeFileSync(path.join(tmp, 'README.md'), '');
    assert.strictEqual(await nextSequenceIndex(tmp, ['.ts', '.js']), 3);
  });
});

describe('default templates', () => {
  it('should include up and down in the TS template', () => {
    const tpl = defaultTemplateTs();
    assert.ok(tpl.includes('export async function up'));
    assert.ok(tpl.includes('export async function down'));
    assert.ok(tpl.includes('MigrationContext'));
  });

  it('should include up and down in the JS template', () => {
    const tpl = defaultTemplateJs();
    assert.ok(tpl.includes('export async function up'));
    assert.ok(tpl.includes('export async function down'));
  });
});

describe('resolveTemplateContent', () => {
  it('should read a custom template when provided', async () => {
    const custom = path.join(tmp, 'my-template.ts');
    writeFileSync(custom, '// custom');
    assert.strictEqual(await resolveTemplateContent(custom, false), '// custom');
  });

  it('should throw MigrationFileNotFoundError for a missing custom template', async () => {
    await assert.rejects(
      () => resolveTemplateContent(path.join(tmp, 'missing.ts'), false),
      MigrationFileNotFoundError,
    );
  });
});

describe('createMigrationFile', () => {
  it('should create a timestamped .ts file by default', async () => {
    const file = await createMigrationFile({
      dir: tmp,
      name: 'Add Index',
      sequential: false,
      js: false,
    });
    assert.strictEqual(existsSync(file), true);
    assert.match(file, /\d{14}-add-index\.ts$/);
    assert.ok(readFileSync(file, 'utf8').includes('export async function up'));
  });

  it('should create a sequential .js file when requested', async () => {
    const file = await createMigrationFile({ dir: tmp, name: 'First', sequential: true, js: true });
    assert.match(file, /0001-first\.js$/);
  });
});

describe('config templates', () => {
  it('should fill the TS template with provided values and the MigronautConfig type', () => {
    const tpl = defaultConfigTs({ uri: 'mongodb://db:1', dbName: 'shop' });
    assert.ok(tpl.includes("import type { MigronautConfig } from '@alexify/migronaut'"));
    assert.ok(tpl.includes("uri: 'mongodb://db:1'"));
    assert.ok(tpl.includes("dbName: 'shop'"));
    assert.ok(tpl.includes('export default config'));
  });

  it('should fall back to defaults for omitted values', () => {
    const tpl = defaultConfigTs();
    assert.ok(tpl.includes("uri: 'mongodb://localhost:27017'"));
    assert.ok(tpl.includes("dbName: 'myapp'"));
    assert.ok(tpl.includes("migrationsDir: './migrations'"));
  });

  it('should produce valid parseable JSON', () => {
    const parsed = JSON.parse(defaultConfigJson({ dbName: 'shop' }));
    assert.strictEqual(parsed.dbName, 'shop');
    assert.strictEqual(parsed.migrationsCollection, '_migronaut_migrations');
  });

  it('should dispatch on format', () => {
    assert.ok(configTemplateContent('js').includes('const config = {'));
    assert.ok(configTemplateContent('json').includes('"lockTTLSeconds": 60'));
    assert.ok(configTemplateContent('ts').includes('Partial<MigronautConfig>'));
  });

  it('should seed createExtension to match the config file language', () => {
    assert.ok(defaultConfigTs().includes("createExtension: 'ts'"));
    assert.ok(defaultConfigJs().includes("createExtension: 'js'"));
  });

  it('should document the full set of options, not just the required ones', () => {
    const tpl = defaultConfigTs();
    for (const key of [
      'fileExtensions',
      'createExtension',
      'sequential',
      'templatePath',
      'lockTTLSeconds',
      'strict',
      'useTransaction',
      'hooks',
    ]) {
      assert.ok(tpl.includes(key));
    }
  });

  it('should include createExtension in the JSON template', () => {
    assert.strictEqual(JSON.parse(defaultConfigJson()).createExtension, 'js');
  });
});

describe('secret-provider config templates', () => {
  it('should emit an async factory that fetches from a secret manager (JS)', () => {
    const tpl = secretConfigJs();
    assert.ok(tpl.includes('async function loadMongoSecret'));
    assert.ok(tpl.includes('export default async () =>'));
    assert.ok(tpl.includes('@aws-sdk/client-secrets-manager'));
    assert.ok(tpl.includes('uri: secret.uri'));
    assert.ok(tpl.includes("createExtension: 'js'"));
  });

  it('should be provider-agnostic — document swapping AWS for another provider', () => {
    const tpl = secretConfigJs();
    assert.ok(tpl.includes('Provider-agnostic'));
    assert.ok(tpl.includes('@google-cloud/secret-manager'));
  });

  it('should emit a typed async factory for TS with the MigronautConfig type', () => {
    const tpl = secretConfigTs();
    assert.ok(tpl.includes("import type { MigronautConfig } from '@alexify/migronaut'"));
    assert.ok(tpl.includes('async function loadMongoSecret(): Promise<{ uri: string'));
    assert.ok(tpl.includes('Promise<Partial<MigronautConfig>>'));
    assert.ok(tpl.includes("createExtension: 'ts'"));
  });

  it('should seed migrationsDir from provided values', () => {
    assert.ok(
      secretConfigJs({ migrationsDir: './db/migrations' }).includes(
        "migrationsDir: './db/migrations'",
      ),
    );
  });

  it('should dispatch to the secret template via configTemplateContent', () => {
    assert.ok(configTemplateContent('js', {}, true).includes('loadMongoSecret'));
    assert.ok(configTemplateContent('ts', {}, true).includes('loadMongoSecret'));
  });

  it('should throw ConfigInvalidError when secret-provider is requested for json', () => {
    assert.throws(() => configTemplateContent('json', {}, true), ConfigInvalidError);
  });
});

describe('createConfigFile', () => {
  it('should write migronaut.config.ts by default and return its path', async () => {
    const file = await createConfigFile({ dir: tmp, format: 'ts', force: false });
    assert.strictEqual(file, path.join(tmp, 'migronaut.config.ts'));
    assert.ok(readFileSync(file, 'utf8').includes('Partial<MigronautConfig>'));
  });

  it('should write migronaut.config.json when format is json', async () => {
    const file = await createConfigFile({ dir: tmp, format: 'json', force: false });
    assert.strictEqual(file, path.join(tmp, 'migronaut.config.json'));
  });

  it('should throw ConfigFileExistsError when the file exists without force', async () => {
    await createConfigFile({ dir: tmp, format: 'ts', force: false });
    await assert.rejects(
      () => createConfigFile({ dir: tmp, format: 'ts', force: false }),
      ConfigFileExistsError,
    );
  });

  it('should overwrite an existing file when force is true', async () => {
    const file = await createConfigFile({ dir: tmp, format: 'ts', force: false });
    writeFileSync(file, '// stale');
    await createConfigFile({ dir: tmp, format: 'ts', force: true, values: { dbName: 'fresh' } });
    assert.ok(readFileSync(file, 'utf8').includes("dbName: 'fresh'"));
  });
});
