const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeProject } = require('../helpers/project.js');

/**
 * These tests exercise the SHIPPED artifact the way an installed user runs it:
 * `bin/migronaut.js` under plain `node` — no build step, no loader. This is the
 * whole point of shipping CommonJS directly: the CLI you test IS the CLI you ship.
 */

const repoRoot = path.join(__dirname, '..', '..');
const bin = path.join(repoRoot, 'bin', 'migronaut.js');

// The supported Node range (engines >= 22.18) always strips types; feature
// detection guards the rare case of a run under --no-experimental-strip-types.
const nodeStripsTypes = Boolean(process.features.typescript);

/** Run the CLI under the current (plain) Node */
function runBin(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

const tsMigration = `import type { MigrationContext } from '@alexify/migronaut';
export async function up({ db }: MigrationContext): Promise<void> {
  await db.collection('rt_ts').insertOne({ marker: 'ts' });
}
export async function down({ db }: MigrationContext): Promise<void> {
  await db.collection('rt_ts').deleteMany({ marker: 'ts' });
}
`;

let mongo;
const DB = 'migronaut_runtime_test';

before(async () => {
  // A private server: this file forks real Node processes with their own
  // runtime flags — nothing here should share state with the rest of the suite.
  mongo = await startTestMongo(DB, { dedicated: true });
});

after(async () => {
  await mongo.stop();
});

let project;

beforeEach(async () => {
  await mongo.db.dropDatabase();
  project = makeProject();
});

afterEach(() => {
  project?.cleanup();
});

function args(extra) {
  return ['--uri', mongo.uri, '--db', DB, '--dir', project.dir, ...extra];
}

describe('shipped CLI under plain node (no build, no loader)', () => {
  it('should apply a .js migration', async () => {
    project.write('0001-js.js', insertMigration('rt_js', 'js'));
    const result = await runBin(args(['up', '0001-js.js']), project.dir);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(await mongo.db.collection('rt_js').countDocuments(), 1);
  });

  it('should apply a .ts migration', { skip: !nodeStripsTypes }, async () => {
    project.write('0002-ts.ts', tsMigration);
    const result = await runBin(args(['up', '0002-ts.ts']), project.dir);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(await mongo.db.collection('rt_ts').countDocuments(), 1);
  });
});
