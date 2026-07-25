const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { MigratorKit } = require('../../src/core/migrator.js');

const TMP_ROOT = path.join(process.cwd(), 'tests', '.tmp');

/** Create an isolated migrations directory under tests/.tmp */
function makeProject() {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_ROOT, 'proj-'));
  return {
    dir,
    write: (name, body) => {
      writeFileSync(path.join(dir, name), body, 'utf8');
    },
    tamper: (name) => {
      writeFileSync(path.join(dir, name), `// tampered ${Date.now()}\nexport {};\n`, 'utf8');
    },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A migration body that inserts a marker doc into `collection` on up and
 * removes it on down — lets tests assert effects via a separate client.
 */
function insertMigration(collection, value) {
  return `export async function up({ db }) {
  await db.collection('${collection}').insertOne({ marker: '${value}' });
}
export async function down({ db }) {
  await db.collection('${collection}').deleteMany({ marker: '${value}' });
}
`;
}

/** A migration body whose up() always throws */
function failingMigration() {
  return `export async function up() {
  throw new Error('intentional failure');
}
export async function down() {}
`;
}

/** Build a MigratorKit pointed at the test mongo + project dir, with output silenced */
function makeMigrator(uri, dbName, dir, overrides = {}) {
  return new MigratorKit({
    uri,
    dbName,
    migrationsDir: dir,
    logger: null,
    ...overrides,
  });
}

module.exports = { makeProject, insertMigration, failingMigration, makeMigrator };
