const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');
const {
  collectionsIssues,
  definitionIssues,
  loadCollectionsDir,
  normalizeDefinition,
  resolveDefinitions,
} = require('../../src/core/collections.js');
const { validateConfig, DEFAULT_CONFIG } = require('../../src/core/config.js');
const { ConfigInvalidError } = require('../../src/errors/index.js');

const RESERVED = ['_migronaut_migrations', '_migronaut_locks'];
const issuesOf = (definition, options = {}) =>
  definitionIssues(definition, { path: 'collections[0]', reserved: RESERVED, ...options });
const pathsOf = (definition, options) => issuesOf(definition, options).map((issue) => issue.path);

describe('definitionIssues', () => {
  it('should accept indexes, a validator, or both', () => {
    assert.deepStrictEqual(issuesOf({ name: 'users', indexes: [] }), []);
    assert.deepStrictEqual(issuesOf({ name: 'users', validator: null }), []);
    assert.deepStrictEqual(
      issuesOf({
        name: 'users',
        indexes: [{ key: { email: 1 }, unique: true }],
        validator: { $jsonSchema: { required: ['email'] } },
        validationLevel: 'moderate',
        validationAction: 'errorAndLog',
        prune: true,
      }),
      [],
    );
  });

  it('should refuse a definition that manages nothing', () => {
    const [issue] = issuesOf({ name: 'users' });
    assert.strictEqual(issue.path, 'collections[0]');
    assert.match(issue.message, /nothing to manage/);
  });

  it('should refuse unknown keys — a typo must not read as "unmanaged"', () => {
    assert.deepStrictEqual(pathsOf({ name: 'users', indexs: [], validator: null }), [
      'collections[0].indexs',
    ]);
  });

  it('should refuse a missing, invalid or reserved name', () => {
    assert.deepStrictEqual(pathsOf({ indexes: [] }), ['collections[0].name']);
    assert.deepStrictEqual(pathsOf({ name: 'system.users', indexes: [] }), ['collections[0].name']);
    assert.deepStrictEqual(pathsOf({ name: 'a$b', indexes: [] }), ['collections[0].name']);
    const [reserved] = issuesOf({ name: '_migronaut_locks', indexes: [] });
    assert.match(reserved.message, /migronaut's own/);
  });

  it('should take a file-based name from the file and say so when it is unusable', () => {
    assert.deepStrictEqual(issuesOf({ indexes: [] }, { path: 'x.js:', fallbackName: 'users' }), []);
    const [issue] = issuesOf({ indexes: [] }, { path: 'system.x.js:', fallbackName: 'system.x' });
    assert.strictEqual(issue.path, 'system.x.js: name');
    assert.match(issue.message, /file name/);
  });

  it('should report index issues with their position', () => {
    assert.deepStrictEqual(pathsOf({ name: 'c', indexes: 'email' }), ['collections[0].indexes']);
    assert.deepStrictEqual(pathsOf({ name: 'c', indexes: [{ key: { a: 1 } }, { key: {} }] }), [
      'collections[0].indexes[1].key',
    ]);
  });

  it('should refuse two declarations of one index', () => {
    const name = issuesOf({
      name: 'c',
      indexes: [{ key: { a: 1 } }, { key: { b: 1 }, name: 'a_1' }],
    });
    assert.deepStrictEqual(
      name.map((issue) => issue.path),
      ['collections[0].indexes[1]'],
    );
    assert.match(name[0].message, /same name/);

    const text = issuesOf({ name: 'c', indexes: [{ key: { a: 'text' } }, { key: { b: 'text' } }] });
    assert.match(text[0].message, /second text index/);

    const signature = issuesOf({
      name: 'c',
      indexes: [{ key: { a: 1 } }, { key: { a: 1 }, name: 'a_unique', unique: true }],
    });
    assert.match(signature[0].message, /same key/);

    // A different collation or filter is a different index to the server.
    assert.deepStrictEqual(
      issuesOf({
        name: 'c',
        indexes: [{ key: { a: 1 } }, { key: { a: 1 }, name: 'a_ci', collation: { locale: 'en' } }],
      }),
      [],
    );
  });

  it('should check the validator and its settings', () => {
    assert.deepStrictEqual(pathsOf({ name: 'c', validator: 'x' }), ['collections[0].validator']);
    assert.deepStrictEqual(pathsOf({ name: 'c', validator: { $where: () => true } }), [
      'collections[0].validator',
    ]);
    const cyclic = { a: {} };
    cyclic.a.self = cyclic;
    assert.match(issuesOf({ name: 'c', validator: cyclic })[0].message, /circular/);
    assert.match(issuesOf({ name: 'c', validator: { s: Symbol('x') } })[0].message, /symbols/);
    assert.deepStrictEqual(pathsOf({ name: 'c', validator: { a: 1 }, validationLevel: 'loose' }), [
      'collections[0].validationLevel',
    ]);
    const [orphan] = issuesOf({ name: 'c', validator: null, validationAction: 'warn' });
    assert.strictEqual(orphan.path, 'collections[0].validationAction');
    assert.match(orphan.message, /without a validator/);
    assert.deepStrictEqual(pathsOf({ name: 'c', indexes: [], prune: 'yes' }), [
      'collections[0].prune',
    ]);
  });

  it('should refuse a non-object definition', () => {
    assert.deepStrictEqual(pathsOf(null), ['collections[0]']);
    assert.deepStrictEqual(definitionIssues([], { path: 'x.json:' })[0].path, 'x.json');
  });
});

describe('collectionsIssues', () => {
  it('should refuse a collection declared twice', () => {
    const issues = collectionsIssues(
      [
        { name: 'a', indexes: [] },
        { name: 'a', validator: null },
      ],
      { reserved: RESERVED },
    );
    assert.deepStrictEqual(
      issues.map((issue) => issue.path),
      ['collections[1].name'],
    );
  });

  it('should treat undefined as nothing declared and refuse a non-array', () => {
    assert.deepStrictEqual(collectionsIssues(undefined), []);
    assert.deepStrictEqual(
      collectionsIssues({}).map((issue) => issue.path),
      ['collections'],
    );
  });
});

describe('validateConfig and the collection keys', () => {
  const base = { ...DEFAULT_CONFIG, uri: 'mongodb://localhost', dbName: 'app' };

  it('should validate inline definitions with nested paths', () => {
    const issues = validateConfig({ ...base, collections: [{ name: 'c', indexes: [{ key: 1 }] }] });
    assert.deepStrictEqual(
      issues.map((issue) => issue.path),
      ['collections[0].indexes[0].key'],
    );
  });

  it("should refuse a definition named after migronaut's own collections", () => {
    const issues = validateConfig({
      ...base,
      lockCollection: 'locks',
      collections: [{ name: 'locks', indexes: [] }],
    });
    assert.deepStrictEqual(
      issues.map((issue) => issue.path),
      ['collections[0].name'],
    );
  });

  it('should check the outer shapes', () => {
    const issues = validateConfig({
      ...base,
      collections: 'users',
      collectionsDir: '',
      convergeAfterUp: 'yes',
    });
    assert.deepStrictEqual(
      issues.map((issue) => issue.path),
      ['collections', 'collectionsDir', 'convergeAfterUp'],
    );
  });
});

describe('normalizeDefinition', () => {
  it('should normalize indexes and keep unmanaged parts undefined', () => {
    const definition = normalizeDefinition(
      { indexes: [{ key: { a: 1 } }], prune: true },
      { name: 'from-file', source: 'from-file.js' },
    );
    assert.strictEqual(definition.name, 'from-file');
    assert.strictEqual(definition.indexes[0].name, 'a_1');
    assert.strictEqual(definition.validator, undefined);
    assert.strictEqual(definition.prune, true);
    assert.ok(!('validationLevel' in definition));
  });

  it('should clean the validator for the wire and keep null as "none"', () => {
    assert.deepStrictEqual(
      normalizeDefinition({ name: 'c', validator: { a: 1, b: undefined } }).validator,
      { a: 1 },
    );
    assert.strictEqual(normalizeDefinition({ name: 'c', validator: null }).validator, null);
    assert.strictEqual(
      normalizeDefinition({ name: 'c', validator: { a: 1 }, validationAction: 'warn' })
        .validationAction,
      'warn',
    );
  });
});

describe('collection definition files', () => {
  let dir;
  const write = (file, body) => writeFileSync(path.join(dir, file), body, 'utf8');

  beforeEach(() => {
    mkdirSync(path.join(process.cwd(), 'tests', '.tmp'), { recursive: true });
    dir = mkdtempSync(path.join(process.cwd(), 'tests', '.tmp', 'collections-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should load one definition per file, sorted, skipping what is not one', async () => {
    write('users.js', 'module.exports = { indexes: [{ key: { email: 1 }, unique: true }] };\n');
    write('orders.json', '{ "indexes": [{ "key": { "total": -1 } }] }\n');
    write('events.mjs', "export default { name: 'audit.events', validator: null };\n");
    write('named.mjs', 'export const indexes = [{ key: { a: 1 } }];\n');
    write('.hidden.js', 'throw new Error("dotfiles are skipped");\n');
    write('types.d.ts', 'export {};\n');
    write('README.md', '# not a definition\n');
    mkdirSync(path.join(dir, 'nested.js'));

    const files = await loadCollectionsDir(dir, { extensions: ['.js', '.mjs'] });
    assert.deepStrictEqual(
      files.map((file) => [file.file, file.name]),
      [
        ['events.mjs', 'events'],
        ['named.mjs', 'named'],
        ['orders.json', 'orders'],
        ['users.js', 'users'],
      ],
    );
    assert.deepStrictEqual(files[1].definition, { indexes: [{ key: { a: 1 } }] });

    const definitions = await resolveDefinitions({
      dir,
      extensions: ['.js', '.mjs'],
      reserved: RESERVED,
    });
    assert.deepStrictEqual(
      definitions.map((definition) => [definition.name, definition.source]),
      [
        ['audit.events', 'events.mjs'],
        ['named', 'named.mjs'],
        ['orders', 'orders.json'],
        ['users', 'users.js'],
      ],
    );
  });

  it('should accept extensions written without the dot', async () => {
    write('a.js', 'module.exports = { indexes: [] };\n');
    const files = await loadCollectionsDir(dir, { extensions: ['js'] });
    assert.deepStrictEqual(
      files.map((file) => file.name),
      ['a'],
    );
  });

  it('should put inline definitions first and refuse a name declared twice', async () => {
    write('users.js', 'module.exports = { indexes: [] };\n');
    write('again.js', "module.exports = { name: 'users', validator: null };\n");
    await assert.rejects(
      resolveDefinitions({
        inline: [{ name: 'orders', indexes: [] }],
        dir,
        extensions: ['.js'],
      }),
      (error) =>
        error instanceof ConfigInvalidError &&
        error.context.issues.length === 1 &&
        error.context.issues[0].path === 'users.js: name' &&
        /already again\.js/.test(error.context.issues[0].message),
    );
    await assert.rejects(
      resolveDefinitions({ inline: [{ name: 'users', indexes: [] }], dir, extensions: ['.js'] }),
      (error) =>
        error.context.issues.some((issue) => /already collections\[0\]/.test(issue.message)),
    );
  });

  it('should collect every invalid file in one error', async () => {
    write('a.js', 'module.exports = { indexes: [{ key: { a: 1 }, uniqe: true }] };\n');
    write('b.js', 'module.exports = { nothing: true };\n');
    await assert.rejects(
      resolveDefinitions({ dir, extensions: ['.js'] }),
      (error) =>
        error.message === 'Invalid collection definition(s)' &&
        error.context.issues.map((issue) => issue.path).join('|') ===
          'a.js: indexes[0].uniqe|b.js: nothing|b.js',
    );
  });

  it('should refuse a function export — a Mongoose model is one', async () => {
    write('model.js', 'module.exports = function Model() {};\n');
    await assert.rejects(
      loadCollectionsDir(dir, { extensions: ['.js'] }),
      (error) => error instanceof ConfigInvalidError && /not a function/.test(error.message),
    );
  });

  it('should report a file that fails to load or parse', async () => {
    write('broken.js', 'throw new Error("boom");\n');
    await assert.rejects(
      loadCollectionsDir(dir, { extensions: ['.js'] }),
      (error) =>
        error instanceof ConfigInvalidError &&
        error.message === 'Collection definition file failed to load' &&
        /boom/.test(error.context.cause),
    );
    rmSync(path.join(dir, 'broken.js'));
    write('bad.json', '{ nope');
    await assert.rejects(
      loadCollectionsDir(dir, { extensions: ['.js'] }),
      (error) => error.message === 'Collection definition file is not valid JSON',
    );
  });

  it('should explain a TypeScript file the runtime cannot strip', async () => {
    write('enum.ts', 'enum Kind { A }\nexport default { name: "k", indexes: [] };\n');
    await assert.rejects(
      loadCollectionsDir(dir, { extensions: ['.ts'] }),
      (error) =>
        error instanceof ConfigInvalidError &&
        /Cannot load TypeScript collection definition "enum\.ts"/.test(error.message),
    );
  });

  it('should refuse a missing directory instead of reading it as empty', async () => {
    await assert.rejects(
      loadCollectionsDir(path.join(dir, 'missing'), { extensions: ['.js'] }),
      (error) =>
        error instanceof ConfigInvalidError && error.message === 'collectionsDir not found',
    );
    write('file.js', '');
    await assert.rejects(
      loadCollectionsDir(path.join(dir, 'file.js'), { extensions: ['.js'] }),
      (error) => error.message === 'collectionsDir not found',
    );
  });

  it('should re-import a changed file with reload', async () => {
    write('c.mjs', 'export default { indexes: [] };\n');
    await loadCollectionsDir(dir, { extensions: ['.mjs'] });
    write('c.mjs', 'export default { validator: null };\n');
    const cached = await loadCollectionsDir(dir, { extensions: ['.mjs'] });
    assert.deepStrictEqual(cached[0].definition, { indexes: [] });
    const fresh = await loadCollectionsDir(dir, { extensions: ['.mjs'], reload: true });
    assert.deepStrictEqual(fresh[0].definition, { validator: null });
  });

  it('should resolve to just the inline definitions without a directory', async () => {
    const definitions = await resolveDefinitions({ inline: [{ name: 'a', indexes: [] }] });
    assert.deepStrictEqual(
      definitions.map((definition) => definition.source),
      ['collections[0]'],
    );
    assert.deepStrictEqual(await resolveDefinitions({}), []);
  });
});
