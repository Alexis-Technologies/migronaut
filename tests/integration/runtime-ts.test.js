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

// Node enabled TypeScript type-stripping by default in v22.18 (unflagged in
// v23.6). Below that, plain `node` cannot import `.ts` and migronaut surfaces a clear
// error instead of a cryptic ERR_UNKNOWN_FILE_EXTENSION.
const [major, minor] = process.versions.node.split('.').map(Number);
const nodeStripsTypes = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 18);

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
  mongo = await startTestMongo(DB);
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

  it(`should ${nodeStripsTypes ? 'apply' : 'cleanly reject'} a .ts migration on this Node`, async () => {
    project.write('0002-ts.ts', tsMigration);
    const result = await runBin(args(['up', '0002-ts.ts']), project.dir);

    if (nodeStripsTypes) {
      assert.strictEqual(result.code, 0);
      assert.strictEqual(await mongo.db.collection('rt_ts').countDocuments(), 1);
    } else {
      // No type-stripping: must fail loudly with our actionable message, not a
      // raw Node ERR_UNKNOWN_FILE_EXTENSION, and must not have touched the DB.
      assert.strictEqual(result.code, 1);
      assert.ok(`${result.stdout}${result.stderr}`.includes('TypeScript'));
      assert.strictEqual(await mongo.db.collection('rt_ts').countDocuments(), 0);
    }
  });
});
