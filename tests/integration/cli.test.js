const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { startTestMongo } = require('../helpers/mongo.js');
const { failingMigration, insertMigration, makeProject } = require('../helpers/project.js');

const repoRoot = path.join(__dirname, '..', '..');
const binPath = path.join(repoRoot, 'bin', 'migronaut.js');

/** Run the CLI as a plain Node child process and capture its result */
function runCli(args, env = {}, cwd = repoRoot, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
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
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

let mongo;
const DB = 'migronaut_cli_test';

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

function baseArgs(extra) {
  return ['--uri', mongo.uri, '--db', DB, '--dir', project.dir, ...extra];
}

describe('migronaut CLI (integration)', () => {
  it('should exit 0 when up succeeds', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const result = await runCli(baseArgs(['up']));
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Applied'));
  });

  it('should exit 1 when a migration fails', async () => {
    project.write('0001-bad.ts', failingMigration());
    const result = await runCli(baseArgs(['up']));
    assert.strictEqual(result.code, 1);
  });

  it('should re-run an applied migration with up <file> --force after a yes confirmation', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);

    const result = await runCli(baseArgs(['up', '0001-a.ts', '--force']), {}, repoRoot, 'y\n');
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Applied'));
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 2);
  });

  it('should abort up <file> --force when the confirmation is declined', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));

    const result = await runCli(baseArgs(['up', '0001-a.ts', '--force']), {}, repoRoot, 'n\n');
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Aborted'));
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should reject a standalone up --force with no file and exit 1', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const result = await runCli(baseArgs(['up', '--force']), {}, repoRoot, '');
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('--force requires a specific migration file'));
    // nothing applied
    assert.strictEqual(await mongo.db.collection('_migronaut_migrations').countDocuments(), 0);
  });

  it('should refuse up <file> --force --json without --yes (no silent re-run)', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);

    const result = await runCli(baseArgs(['up', '0001-a.ts', '--force', '--json']));
    assert.strictEqual(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.error.message.includes('--yes'));
    // Migration was NOT re-run.
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should re-run with up <file> --force --yes --json (explicit non-interactive confirm)', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));

    const result = await runCli(baseArgs(['up', '0001-a.ts', '--force', '--yes', '--json']));
    assert.strictEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed[0].file, '0001-a.ts');
    assert.strictEqual(parsed[0].status, 'applied');
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 2);
  });

  it('should apply per-file batches with up --step then peel them with down --steps', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    project.write('0003-c.ts', insertMigration('things', 'c'));

    const up = await runCli(baseArgs(['up', '--step']));
    assert.strictEqual(up.code, 0);
    const batches = (
      await mongo.db.collection('_migronaut_migrations').find().sort({ name: 1 }).toArray()
    ).map((d) => d.batch);
    assert.deepStrictEqual(batches, [1, 2, 3]);

    const down = await runCli(baseArgs(['down', '--steps', '2']));
    assert.strictEqual(down.code, 0);
    // Only 0001-a's marker survives.
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should exit 1 when down combines --steps with --batch', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));
    const result = await runCli(baseArgs(['down', '--steps', '1', '--batch', '1']));
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('CONFIG_INVALID'));
  });

  it('should resolve an async function config file (simulating a fetched secret)', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    // Config lives in its own cwd (as in a real project); the migrations dir is
    // a separate folder. The factory "fetches" the connection details at run
    // time, the way an AWS/GCP Secrets Manager recipe would. No --uri/--db
    // flags here, so the values can only come from the resolved function.
    const cwdDir = path.join(project.dir, 'app');
    mkdirSync(cwdDir);
    const factory = [
      'export default async () => ({',
      `  uri: ${JSON.stringify(mongo.uri)},`,
      `  dbName: ${JSON.stringify(DB)},`,
      `  migrationsDir: ${JSON.stringify(project.dir)},`,
      '});',
      '',
    ].join('\n');
    writeFileSync(path.join(cwdDir, 'migronaut.config.js'), factory);
    const result = await runCli(['up'], {}, cwdDir);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Applied'));
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should render a status table', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));
    const result = await runCli(baseArgs(['status']));
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Migration'));
    assert.ok(result.stdout.includes('0001-a.ts'));
  });

  it('should print a dry-run plan and exit 0', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const result = await runCli(baseArgs(['dry-run', 'up']));
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('0001-a.ts'));
    // DB untouched
    assert.strictEqual(await mongo.db.collection('_migronaut_migrations').countDocuments(), 0);
  });

  it('should preview a step rollback with dry-run down --steps and write nothing', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    await runCli(baseArgs(['up']));
    const result = await runCli(baseArgs(['dry-run', 'down', '--steps', '1']));
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('0002-b.ts'));
    assert.ok(!result.stdout.includes('0001-a.ts'));
    // nothing reverted
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 2);
  });

  it('should create a migronaut.config.js by default with init', async () => {
    const result = await runCli(['init', '--db', 'shop'], {}, project.dir);
    assert.strictEqual(result.code, 0);
    const configPath = path.join(project.dir, 'migronaut.config.js');
    assert.strictEqual(existsSync(configPath), true);
    assert.strictEqual(existsSync(path.join(project.dir, 'migronaut.config.ts')), false);
    const contents = readFileSync(configPath, 'utf8');
    assert.ok(contents.includes("dbName: 'shop'"));
    assert.ok(contents.includes("createExtension: 'js'"));
  });

  it('should create a migronaut.config.ts with createExtension ts when init --ts is passed', async () => {
    const result = await runCli(['init', '--ts'], {}, project.dir);
    assert.strictEqual(result.code, 0);
    const tsPath = path.join(project.dir, 'migronaut.config.ts');
    assert.strictEqual(existsSync(tsPath), true);
    assert.strictEqual(existsSync(path.join(project.dir, 'migronaut.config.js')), false);
    assert.ok(readFileSync(tsPath, 'utf8').includes("createExtension: 'ts'"));
  });

  it('should generate a secret-provider migronaut.config.js with init --secret-provider', async () => {
    const result = await runCli(['init', '--secret-provider'], {}, project.dir);
    assert.strictEqual(result.code, 0);
    const contents = readFileSync(path.join(project.dir, 'migronaut.config.js'), 'utf8');
    assert.ok(contents.includes('async function loadMongoSecret'));
    assert.ok(contents.includes('export default async () =>'));
    assert.ok(contents.includes('@aws-sdk/client-secrets-manager'));
    // provider-agnostic guidance is present
    assert.ok(contents.includes('Provider-agnostic'));
  });

  it('should generate a secret-provider migronaut.config.ts with init --ts --secret-provider', async () => {
    const result = await runCli(['init', '--ts', '--secret-provider'], {}, project.dir);
    assert.strictEqual(result.code, 0);
    const contents = readFileSync(path.join(project.dir, 'migronaut.config.ts'), 'utf8');
    assert.ok(contents.includes('async function loadMongoSecret'));
    assert.ok(contents.includes("import type { MigronautConfig } from '@alexify/migronaut'"));
  });

  it('should reject init --json --secret-provider and exit 1', async () => {
    const result = await runCli(['init', '--json', '--secret-provider'], {}, project.dir);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('secret-provider'));
    assert.strictEqual(existsSync(path.join(project.dir, 'migronaut.config.json')), false);
  });

  it('should exit 1 when init finds an existing config without --force', async () => {
    await runCli(['init'], {}, project.dir);
    const result = await runCli(['init'], {}, project.dir);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('CONFIG_FILE_EXISTS'));
  });

  it('should generate a correctly named file and default to .js with no config or flag', async () => {
    // Run from a clean dir (no config file) so the built-in default applies.
    const result = await runCli(
      ['create', 'add users index', '--dir', project.dir],
      {},
      project.dir,
    );
    assert.strictEqual(result.code, 0);
    const created = readdirSync(project.dir).filter((f) => f.endsWith('add-users-index.js'));
    assert.strictEqual(created.length, 1);
    assert.strictEqual(existsSync(path.join(project.dir, created[0])), true);
  });

  it('should let --ts override the default when no config is present', async () => {
    const result = await runCli(
      ['create', 'forced ts', '--ts', '--dir', project.dir],
      {},
      project.dir,
    );
    assert.strictEqual(result.code, 0);
    assert.strictEqual(
      readdirSync(project.dir).filter((f) => f.endsWith('forced-ts.ts')).length,
      1,
    );
  });

  it('should default create to the file type set in the config (createExtension)', async () => {
    // createExtension 'ts' differs from the built-in 'js' default, so a .ts file
    // proves the value came from the config. --dir keeps the output location
    // deterministic instead of relying on the config's migrationsDir.
    writeFileSync(
      path.join(project.dir, 'migronaut.config.json'),
      JSON.stringify({ createExtension: 'ts' }),
    );
    const result = await runCli(['create', 'from config', '--dir', project.dir], {}, project.dir);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(
      readdirSync(project.dir).filter((f) => f.endsWith('from-config.ts')).length,
      1,
    );
  });

  // ── --json output (feature 1) ────────────────────────────────────────────
  it('should emit a clean JSON array for up --json (stdout is pure JSON)', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const result = await runCli(baseArgs(['up', '--json']));
    assert.strictEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(
      parsed.map((r) => r.status),
      ['applied', 'applied'],
    );
    assert.deepStrictEqual(
      parsed.map((r) => r.file),
      ['0001-a.ts', '0002-b.ts'],
    );
  });

  it('should emit a JSON status array with --json', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));
    const result = await runCli(baseArgs(['status', '--json']));
    assert.strictEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].file, '0001-a.ts');
    assert.strictEqual(parsed[0].status, 'applied');
  });

  it('should emit a JSON error object and exit 1 on failure with --json', async () => {
    project.write('0001-x.ts', failingMigration());
    const result = await runCli(baseArgs(['up', '--json']));
    assert.strictEqual(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.error.code, 'MIGRATION_EXECUTION_FAILED');
  });

  // ── status --check (feature 2) ───────────────────────────────────────────
  it('should exit 1 from status --check when migrations are pending', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const pending = await runCli(baseArgs(['status', '--check']));
    assert.strictEqual(pending.code, 1);

    await runCli(baseArgs(['up']));
    const clean = await runCli(baseArgs(['status', '--check']));
    assert.strictEqual(clean.code, 0);
  });

  // ── migronaut unlock (feature 3) ───────────────────────────────────────────────
  it('should report no lock held and exit 0', async () => {
    const result = await runCli(baseArgs(['unlock', '--json']));
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { released: false, holder: null });
  });

  it('should force-release a held lock with unlock --yes', async () => {
    await mongo.db.collection('_migronaut_locks').insertOne({
      _id: 'migronaut_lock',
      lockedAt: new Date(),
      pid: 4242,
      host: 'crashed-host',
      executedBy: 'ghost',
      owner: 'stale-token',
    });
    const result = await runCli(baseArgs(['unlock', '--yes']));
    assert.strictEqual(result.code, 0);
    assert.strictEqual(await mongo.db.collection('_migronaut_locks').countDocuments(), 0);
  });

  it('should return the released holder as JSON with unlock --json', async () => {
    await mongo.db.collection('_migronaut_locks').insertOne({
      _id: 'migronaut_lock',
      lockedAt: new Date(),
      pid: 4242,
      host: 'crashed-host',
      executedBy: 'ghost',
      owner: 'stale-token',
    });
    const result = await runCli(baseArgs(['unlock', '--json']));
    assert.strictEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.released, true);
    assert.strictEqual(parsed.holder.pid, 4242);
    assert.strictEqual(await mongo.db.collection('_migronaut_locks').countDocuments(), 0);
  });

  it('should let --ts override a js createExtension from config', async () => {
    writeFileSync(
      path.join(project.dir, 'migronaut.config.json'),
      JSON.stringify({ createExtension: 'js' }),
    );
    const result = await runCli(
      ['create', 'forced ts', '--ts', '--dir', project.dir],
      {},
      project.dir,
    );
    assert.strictEqual(result.code, 0);
    assert.strictEqual(
      readdirSync(project.dir).filter((f) => f.endsWith('forced-ts.ts')).length,
      1,
    );
  });
});
