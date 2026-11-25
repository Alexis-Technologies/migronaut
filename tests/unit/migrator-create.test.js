const { copyFileSync, existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const { MigratorKit } = require('../../src/core/migrator.js');
const { makeProject } = require('../helpers/project.js');

const customTemplate = path.join(__dirname, '..', 'fixtures', 'templates', 'custom.js');

let project;
afterEach(() => project?.cleanup());

/** Build a MigratorKit pointed at a fresh throwaway dir (no DB needed for create) */
const migrator = (overrides = {}) => {
  project = makeProject();
  return new MigratorKit({ migrationsDir: project.dir, logger: null, ...overrides });
};

describe('MigratorKit.create (in-process)', () => {
  it('should create a .js migration when createExtension is js', async () => {
    const filepath = await migrator({ createExtension: 'js' }).create('add users index');
    assert.strictEqual(filepath.endsWith('.js'), true);
    assert.strictEqual(existsSync(filepath), true);
  });

  it('should create a .ts migration when createExtension is ts', async () => {
    const filepath = await migrator({ createExtension: 'ts' }).create('add ts index');
    assert.strictEqual(filepath.endsWith('.ts'), true);
  });

  it('should let the --js option override a ts createExtension', async () => {
    const filepath = await migrator({ createExtension: 'ts' }).create('force js', { js: true });
    assert.strictEqual(filepath.endsWith('.js'), true);
  });

  it('should use sequential numbering when configured', async () => {
    const filepath = await migrator({ sequential: true }).create('first');
    assert.match(path.basename(filepath), /^0001-/);
  });

  it('should create the migrations directory when it does not exist', async () => {
    project = makeProject();
    const nested = path.join(project.dir, 'nested-migrations');
    assert.strictEqual(existsSync(nested), false);
    const kit = new MigratorKit({ migrationsDir: nested, logger: null });
    const filepath = await kit.create('makes dir');
    assert.strictEqual(existsSync(nested), true);
    assert.strictEqual(existsSync(filepath), true);
  });

  it('should use a custom template passed as an option', async () => {
    const filepath = await migrator().create('templated', { template: customTemplate });
    assert.ok(readFileSync(filepath, 'utf8').includes('CUSTOM TEMPLATE'));
  });

  it('should fall back to config.templatePath when no option is given', async () => {
    const filepath = await migrator({ templatePath: customTemplate }).create('config templated');
    assert.ok(readFileSync(filepath, 'utf8').includes('CUSTOM TEMPLATE'));
  });

  it("should read a relative template against the kit's cwd, like its migrations directory", async () => {
    project = makeProject();
    copyFileSync(customTemplate, path.join(project.dir, 'house-style.js'));
    // A kit that works on a project elsewhere than where the process started:
    // the template used to be looked for under process.cwd().
    const kit = new MigratorKit(
      { migrationsDir: 'migrations', templatePath: './house-style.js', logger: null },
      { cwd: project.dir },
    );
    const filepath = await kit.create('relative template');
    assert.strictEqual(path.dirname(filepath), path.join(project.dir, 'migrations'));
    assert.ok(readFileSync(filepath, 'utf8').includes('CUSTOM TEMPLATE'));
    const again = await kit.create('relative option', { template: 'house-style.js' });
    assert.ok(readFileSync(again, 'utf8').includes('CUSTOM TEMPLATE'));
  });
});
