const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
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
  isEsmProject,
  maskUriCredentials,
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
    assert.ok(tpl.includes('async function up'));
    assert.ok(tpl.includes('async function down'));
    assert.ok(tpl.includes('MigrationContext'));
  });

  it('should include up and down in the JS template', () => {
    const tpl = defaultTemplateJs();
    assert.ok(tpl.includes('async function up'));
    assert.ok(tpl.includes('async function down'));
  });

  it('should default to CommonJS and switch to ESM for a module project', () => {
    // An ESM migration in a CommonJS project makes Node reparse it and warn on
    // every run — the generator follows the project instead of assuming.
    assert.ok(defaultTemplateJs().includes('module.exports = { description, up, down };'));
    assert.ok(defaultTemplateTs().includes('module.exports = { description, up, down };'));
    assert.ok(defaultTemplateJs(true).includes('export async function up'));
    assert.ok(defaultTemplateTs(true).includes('export async function up'));
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

  it('should refuse a template file with an unsupported extension', async () => {
    const secret = path.join(tmp, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY');
    await assert.rejects(() => resolveTemplateContent(secret, false), ConfigInvalidError);
  });

  it('should refuse a template file larger than the size cap', async () => {
    const big = path.join(tmp, 'huge.js');
    writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(() => resolveTemplateContent(big, true), ConfigInvalidError);
  });

  it('should accept every supported template extension', async () => {
    for (const ext of ['.ts', '.js', '.cjs', '.mjs']) {
      const file = path.join(tmp, `tpl${ext}`);
      writeFileSync(file, `// ${ext}`);
      assert.strictEqual(await resolveTemplateContent(file, false), `// ${ext}`);
    }
  });
});

describe('maskUriCredentials', () => {
  it('should mask the password while keeping the username', () => {
    const result = maskUriCredentials('mongodb://alice:s3cret@db.example.com:27017/shop');
    assert.strictEqual(result.uri, 'mongodb://alice:****@db.example.com:27017/shop');
    assert.strictEqual(result.hasCredentials, true);
    assert.strictEqual(result.masked, true);
  });

  it('should mask mongodb+srv URIs', () => {
    assert.strictEqual(
      maskUriCredentials('mongodb+srv://u:p@cluster.mongodb.net/db').uri,
      'mongodb+srv://u:****@cluster.mongodb.net/db',
    );
  });

  it('should leave a credential-free URI untouched', () => {
    const uri = 'mongodb://localhost:27017/shop';
    assert.deepStrictEqual(maskUriCredentials(uri), {
      uri,
      hasCredentials: false,
      masked: false,
    });
  });

  it('should not mangle a multi-host URI (unparseable by new URL)', () => {
    const uri = 'mongodb://h1:27017,h2:27017/db?replicaSet=rs0';
    assert.strictEqual(maskUriCredentials(uri).uri, uri);
    assert.strictEqual(maskUriCredentials(uri).hasCredentials, false);
  });

  it('should report a username-only URI as credentialed but unmasked', () => {
    const result = maskUriCredentials('mongodb://alice@db:27017/shop');
    assert.strictEqual(result.hasCredentials, true);
    assert.strictEqual(result.masked, false);
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
    assert.ok(readFileSync(file, 'utf8').includes('async function up'));
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
    assert.ok(tpl.includes('uri: "mongodb://db:1"'));
    assert.ok(tpl.includes('dbName: "shop"'));
    // CommonJS by default; the ESM form is covered below.
    assert.ok(tpl.includes('module.exports = config'));
  });

  it('should fall back to defaults for omitted values', () => {
    const tpl = defaultConfigTs();
    assert.ok(tpl.includes('uri: "mongodb://localhost:27017"'));
    assert.ok(tpl.includes('dbName: "myapp"'));
    assert.ok(tpl.includes('migrationsDir: "./migrations"'));
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

describe('config template injection safety', () => {
  // A generated config is later import()ed and executed, so a value that breaks
  // out of its string literal is arbitrary code execution.
  const payload = "x', evil: (() => { throw new Error('INJECTED'); })(), z: '";

  for (const [name, render] of [
    ['ts', (v, esm) => defaultConfigTs(v, esm)],
    ['js', (v, esm) => defaultConfigJs(v, esm)],
  ]) {
    it(`should neutralize a quote-breaking dbName in the ${name} template`, () => {
      const tpl = render({ dbName: payload });
      // The payload survives as inert data on one line, never as a second key.
      assert.ok(tpl.includes(`dbName: ${JSON.stringify(payload)},`));
      assert.match(tpl, /^\s*dbName: .*,$/m);
      assert.ok(!/^\s*evil:/m.test(tpl));
    });

    it(`should keep the ${name} template loadable for quote/newline/backtick values`, async () => {
      // Built by concatenation so the placeholder reaches the template as data.
      const dangerousName = 'line1\nline2`' + '${' + 'danger}';
      const dangerousDir = './a"b\\c\'d/migrations';
      const tpl = render(
        {
          uri: 'mongodb://plain-host:27017',
          dbName: dangerousName,
          migrationsDir: dangerousDir,
        },
        // Written out as .mjs below, so render the ESM export form.
        true,
      );
      // Strip the TS-only bits so both variants load as plain ESM, then import
      // the file the way loadConfigFile does in production.
      const body = tpl.replace(/^import type .*$/m, '').replace(': Partial<MigronautConfig>', '');
      const file = path.join(tmp, `loaded-${name}.mjs`);
      writeFileSync(file, body);
      const loaded = await import(pathToFileURL(file).href);
      assert.strictEqual(loaded.default.dbName, dangerousName);
      assert.strictEqual(loaded.default.migrationsDir, dangerousDir);
      assert.strictEqual(loaded.default.uri, 'mongodb://plain-host:27017');
    });
  }

  it('should neutralize a quote-breaking migrationsDir in secret-provider templates', () => {
    const tpl = secretConfigJs({ migrationsDir: payload });
    assert.ok(tpl.includes(`migrationsDir: ${JSON.stringify(payload)},`));
    assert.ok(!/^\s*evil:/m.test(tpl));
  });
});

describe('config template credential masking', () => {
  it('should mask the password in the generated js/ts config and explain why', () => {
    const tpl = defaultConfigJs({ uri: 'mongodb://admin:hunter2@db:27017' });
    assert.ok(tpl.includes('uri: "mongodb://admin:****@db:27017"'));
    assert.ok(!tpl.includes('hunter2'));
    assert.ok(tpl.includes('masked at generation time'));
  });

  it('should mask the password in the generated json config', () => {
    const parsed = JSON.parse(defaultConfigJson({ uri: 'mongodb://admin:hunter2@db:27017' }));
    assert.strictEqual(parsed.uri, 'mongodb://admin:****@db:27017');
  });

  it('should not add the masking note when the URI carries no password', () => {
    assert.ok(!defaultConfigJs({ uri: 'mongodb://localhost:27017' }).includes('masked at'));
  });
});

describe('secret-provider config templates', () => {
  it('should emit an async factory that fetches from a secret manager (JS)', () => {
    const tpl = secretConfigJs();
    assert.ok(tpl.includes('async function loadMongoSecret'));
    assert.ok(tpl.includes('module.exports = async () =>'));
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
        'migrationsDir: "./db/migrations"',
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
    assert.ok(readFileSync(file, 'utf8').includes('dbName: "fresh"'));
  });
});

describe('config template module system', () => {
  it('should default to CommonJS, matching a project with no "type" field', () => {
    // An ESM-syntax config in a CommonJS project makes Node reparse the file
    // and warn on every command.
    assert.ok(defaultConfigJs().includes('module.exports = config;'));
    assert.ok(defaultConfigTs().includes('module.exports = config;'));
    assert.ok(secretConfigJs().includes('module.exports = async () =>'));
    assert.ok(secretConfigTs().includes('module.exports = async ('));
  });

  it('should emit ESM syntax for a "type": "module" project', () => {
    assert.ok(defaultConfigJs({}, true).includes('export default config;'));
    assert.ok(defaultConfigTs({}, true).includes('export default config;'));
    assert.ok(secretConfigJs({}, true).includes('export default async () =>'));
  });
});

describe('isEsmProject', () => {
  it('should report false when package.json has no type field', async () => {
    writeFileSync(path.join(tmp, 'package.json'), '{"name":"app"}');
    assert.strictEqual(await isEsmProject(tmp), false);
  });

  it('should report true for "type": "module"', async () => {
    writeFileSync(path.join(tmp, 'package.json'), '{"name":"app","type":"module"}');
    assert.strictEqual(await isEsmProject(tmp), true);
  });

  it('should walk up to the nearest package.json', async () => {
    writeFileSync(path.join(tmp, 'package.json'), '{"name":"app","type":"module"}');
    const nested = path.join(tmp, 'db', 'config');
    mkdirSync(nested, { recursive: true });
    assert.strictEqual(await isEsmProject(nested), true);
  });

  it('should surface a malformed manifest instead of walking past it', async () => {
    // Silently continuing to the parent would adopt the *grandparent's*
    // "type" and emit ESM into a CommonJS project — the exact failure this
    // detection exists to prevent. The broken file is the user's to fix.
    writeFileSync(path.join(tmp, 'package.json'), 'not json at all');
    await assert.rejects(isEsmProject(tmp), (error) => {
      assert.strictEqual(error.code, 'CONFIG_INVALID');
      assert.match(error.message, /package\.json/);
      return true;
    });
  });
});
