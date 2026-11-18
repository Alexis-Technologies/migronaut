const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');
const { listMigrationFiles } = require('../../src/core/sequence.js');

const EXTENSIONS = ['.ts', '.js'];

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'migronaut-sequence-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name) => writeFileSync(path.join(dir, name), 'module.exports = {};\n');

describe('listMigrationFiles', () => {
  it('should list the migration files in name order, and nothing else', async () => {
    write('0002-b.ts');
    write('0001-a.js');
    write('0003-c.mjs');
    write('.hidden.js');
    write('types.d.ts');
    write('notes.md');
    mkdirSync(path.join(dir, 'looks-like.js'));
    assert.deepStrictEqual(await listMigrationFiles(dir, EXTENSIONS), ['0001-a.js', '0002-b.ts']);
    assert.deepStrictEqual(await listMigrationFiles(dir, ['.mjs']), ['0003-c.mjs']);
  });

  it('should be empty for a directory that does not exist', async () => {
    assert.deepStrictEqual(await listMigrationFiles(path.join(dir, 'nope'), EXTENSIONS), []);
  });

  it('should list a symlink to a file — and not one that leads nowhere, or to a directory', async (t) => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'migronaut-sequence-target-'));
    t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
    writeFileSync(path.join(elsewhere, 'shared.js'), 'module.exports = {};\n');
    mkdirSync(path.join(elsewhere, 'folder'));
    write('0001-a.js');
    try {
      symlinkSync(path.join(elsewhere, 'shared.js'), path.join(dir, '0002-linked.js'));
      symlinkSync(path.join(elsewhere, 'gone.js'), path.join(dir, '0003-broken.js'));
      symlinkSync(path.join(elsewhere, 'folder'), path.join(dir, '0004-folder.js'), 'dir');
      symlinkSync(path.join(elsewhere, 'shared.js'), path.join(dir, 'linked.d.ts'));
    } catch {
      // No right to create symlinks (Windows without developer mode).
      t.skip('symlinks are not available here');
      return;
    }
    // A single-file `up 0002-linked.js` runs it: the bulk run and `status`
    // used to leave it out without a word.
    assert.deepStrictEqual(await listMigrationFiles(dir, EXTENSIONS), [
      '0001-a.js',
      '0002-linked.js',
    ]);
  });
});
