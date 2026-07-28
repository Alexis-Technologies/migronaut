const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { startTestMongo } = require('../helpers/mongo.js');
const { failingMigration, insertMigration, makeProject } = require('../helpers/project.js');

const repoRoot = path.join(__dirname, '..', '..');
const binPath = path.join(repoRoot, 'bin', 'migronaut.js');

/**
 * Run the CLI as a plain Node child process and capture its result.
 *
 * `cwd` defaults to the isolated project dir, NOT the repo root: the repo has
 * its own migronaut.config.ts, and config discovery picking it up would couple
 * ~30 of these tests to that file's contents. Tests that want the repo config
 * pass `repoRoot` explicitly — that coupling is then the point of the test.
 */
function runCli(args, env = {}, cwd = project?.dir ?? repoRoot, input) {
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

/** True when `text` contains any ANSI escape sequence */
const ESC = String.fromCharCode(27);
const hasAnsi = (text) => text.includes(`${ESC}[`);

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

  it('should exit with the migration-failure code when a migration fails', async () => {
    project.write('0001-bad.ts', failingMigration());
    const result = await runCli(baseArgs(['up']));
    // 7 = MIGRATION_EXECUTION_FAILED — CI can tell this apart from a config or
    // connection problem instead of seeing an undifferentiated 1.
    assert.strictEqual(result.code, 7);
  });

  it('should map error codes to distinct exit codes', async () => {
    // CONFIG_INVALID: --steps and --batch are mutually exclusive.
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));
    const conflict = await runCli(baseArgs(['down', '--steps', '1', '--batch', '1']));
    assert.strictEqual(conflict.code, 6);

    // CONNECTION_FAILED against a port nothing is listening on.
    const unreachable = await runCli([
      '--uri',
      'mongodb://127.0.0.1:1/x?serverSelectionTimeoutMS=200',
      '--db',
      'x',
      '--dir',
      project.dir,
      'status',
    ]);
    assert.strictEqual(unreachable.code, 5);
  });

  it('should report partial results and error context in --json on failure', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-bad.ts', failingMigration());
    const result = await runCli(baseArgs(['up', '--json']));
    assert.strictEqual(result.code, 7);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.error.code, 'MIGRATION_EXECUTION_FAILED');
    // The migration that did land is reported, so a pipeline knows where it got to.
    assert.deepStrictEqual(
      parsed.partial.map((r) => [r.file, r.status]),
      [
        ['0001-a.ts', 'applied'],
        ['0002-bad.ts', 'error'],
      ],
    );
    // And the cause is no longer swallowed.
    assert.match(parsed.error.context.cause, /intentional failure/);
  });

  it('should print the underlying cause only with --verbose', async () => {
    project.write('0001-bad.ts', failingMigration());
    const plain = await runCli(baseArgs(['up']));
    assert.ok(!plain.stdout.includes('intentional failure'));

    const verbose = await runCli(baseArgs(['up', '--verbose']));
    assert.match(`${verbose.stdout}${verbose.stderr}`, /intentional failure/);
  });

  it('should suppress progress output with --quiet but still report errors', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const ok = await runCli(baseArgs(['up', '--quiet']));
    assert.strictEqual(ok.code, 0);
    assert.strictEqual(ok.stdout.trim(), '');

    project.write('0002-bad.ts', failingMigration());
    const bad = await runCli(baseArgs(['up', '--quiet']));
    assert.strictEqual(bad.code, 7);
    assert.match(bad.stderr, /MIGRATION_EXECUTION_FAILED/);
  });

  it('should emit no ANSI escapes with --no-color, even under FORCE_COLOR', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));

    // FORCE_COLOR is set explicitly rather than inherited: whether this test
    // exercises the flag-beats-environment precedence must not depend on
    // whichever colour variables the developer's shell happens to export.
    const forced = { FORCE_COLOR: '1' };

    const colored = await runCli(baseArgs(['status']), forced);
    assert.ok(hasAnsi(colored.stdout), 'FORCE_COLOR should colorize without --no-color');

    const result = await runCli(baseArgs(['status', '--no-color']), forced);
    assert.strictEqual(result.code, 0);
    assert.ok(!hasAnsi(result.stdout), 'expected no ANSI escape sequences');
  });

  it('should let the MIGRONAUT_ color vars outrank the unprefixed ones', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));

    // The point of the prefixed pair: pin migronaut's own output without
    // disturbing whatever the shell or CI runner exported for every other tool.
    const forcedOn = await runCli(baseArgs(['status']), {
      MIGRONAUT_FORCE_COLOR: '1',
      NO_COLOR: '1',
    });
    assert.ok(hasAnsi(forcedOn.stdout), 'MIGRONAUT_FORCE_COLOR should beat NO_COLOR');

    const forcedOff = await runCli(baseArgs(['status']), {
      // Cleared explicitly: the child inherits process.env, and this assertion
      // must not depend on what the developer's shell exports.
      MIGRONAUT_FORCE_COLOR: '',
      MIGRONAUT_NO_COLOR: '1',
      FORCE_COLOR: '1',
    });
    assert.ok(!hasAnsi(forcedOff.stdout), 'MIGRONAUT_NO_COLOR should beat FORCE_COLOR');
  });

  it('should ignore a .env file when --no-env is passed', async () => {
    // The .env points somewhere unreachable; --no-env must keep the flags in charge.
    writeFileSync(
      path.join(project.dir, '.env'),
      `MIGRONAUT_URI=mongodb://127.0.0.1:1/nope?serverSelectionTimeoutMS=200\nMIGRONAUT_DB=${DB}\n`,
    );
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const withEnv = await runCli(['--dir', project.dir, 'status'], {}, project.dir);
    // 5 = CONNECTION_FAILED: the unreachable URI from .env was used.
    assert.strictEqual(withEnv.code, 5, 'the .env should have taken effect');

    const noEnv = await runCli(baseArgs(['status', '--no-env']), {}, project.dir);
    assert.strictEqual(noEnv.code, 0);
  });

  it('should report a connection failure as an audit check, not a crash', async () => {
    // audit must diagnose, not die: an unreachable database is exactly what an
    // operator runs it to find out about.
    const result = await runCli([
      '--uri',
      'mongodb://127.0.0.1:1/x?serverSelectionTimeoutMS=300',
      '--db',
      'x',
      '--dir',
      project.dir,
      'audit',
      '--json',
    ]);
    // 22 = AUDIT_FAILED — "a check failed" is distinguishable from a crash.
    assert.strictEqual(result.code, 22);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.ok, false);
    const connection = report.checks.find((check) => check.name === 'connection');
    assert.strictEqual(connection.status, 'fail');
  });

  it('should render an audit checklist and exit 0 on a healthy setup', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));
    const result = await runCli(baseArgs(['audit']));
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /config/);
    assert.match(result.stdout, /No problems found/);
  });

  it('should report lock state with the lock command', async () => {
    const result = await runCli(baseArgs(['lock', '--json']));
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { held: false, holder: null });
  });

  it('should apply up to a target with --to', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    project.write('0003-c.ts', insertMigration('things', 'c'));
    const result = await runCli(baseArgs(['up', '--to', '0002-b.ts', '--json']));
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(
      JSON.parse(result.stdout).map((r) => r.file),
      ['0001-a.ts', '0002-b.ts'],
    );
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

  it('should reject a standalone up --force with no file as CONFIG_INVALID', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const result = await runCli(baseArgs(['up', '--force']), {}, repoRoot, '');
    // Preflight failures use the same typed envelope as everything else.
    assert.strictEqual(result.code, 6);
    assert.ok(result.stderr.includes('--force requires a specific migration file'));
    // nothing applied
    assert.strictEqual(await mongo.db.collection('_migronaut_migrations').countDocuments(), 0);
  });

  it('should refuse up <file> --force --json without --yes (no silent re-run)', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);

    const result = await runCli(baseArgs(['up', '0001-a.ts', '--force', '--json']));
    assert.strictEqual(result.code, 6);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.error.code, 'CONFIG_INVALID');
    assert.ok(parsed.error.message.includes('--yes'));
    // Migration was NOT re-run.
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should fail with CONFIG_INVALID when --force confirmation meets a closed stdin', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));

    // No input at all (stdin at EOF): the prompt can never be answered. The
    // old behavior hung forever, then exited 0 having done nothing.
    const result = await runCli(baseArgs(['up', '0001-a.ts', '--force']));
    assert.strictEqual(result.code, 6);
    assert.ok(result.stderr.includes('--yes'));
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

  it('should exit with the config-invalid code when down combines --steps with --batch', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));
    const result = await runCli(baseArgs(['down', '--steps', '1', '--batch', '1']));
    assert.strictEqual(result.code, 6);
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
    assert.ok(contents.includes('dbName: "shop"'));
    assert.ok(contents.includes("createExtension: 'js'"));
  });

  it('should mask URI credentials in the generated config and warn about it', async () => {
    const result = await runCli(
      ['init', '--uri', 'mongodb://admin:hunter2@db.example.com:27017', '--db', 'shop'],
      {},
      project.dir,
    );
    assert.strictEqual(result.code, 0);
    const contents = readFileSync(path.join(project.dir, 'migronaut.config.js'), 'utf8');
    assert.ok(!contents.includes('hunter2'), 'password must not be written to disk');
    assert.ok(contents.includes('mongodb://admin:****@db.example.com:27017'));
    assert.ok(`${result.stdout}${result.stderr}`.includes('credentials'));
  });

  it('should generate a config that still loads when a value contains a quote', async () => {
    // A raw interpolation would either inject code or produce an unparseable
    // file. Generate with a quote-bearing dir, then run a command with no flags
    // so it can only work by reading that generated config back.
    const quotedDir = path.join(project.dir, "sh'op");
    mkdirSync(quotedDir);
    const init = await runCli(
      ['init', '--uri', mongo.uri, '--db', DB, '--dir', quotedDir],
      {},
      project.dir,
    );
    assert.strictEqual(init.code, 0);
    const contents = readFileSync(path.join(project.dir, 'migronaut.config.js'), 'utf8');
    assert.ok(contents.includes(JSON.stringify(quotedDir)));

    const status = await runCli(['status'], {}, project.dir);
    assert.strictEqual(status.code, 0, `${status.stdout}${status.stderr}`);
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
    // makeProject() declares "type": "module", so the generator emits ESM.
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

  it('should reject init --format json --secret-provider as CONFIG_INVALID', async () => {
    const result = await runCli(['init', '--format', 'json', '--secret-provider'], {}, project.dir);
    // Preflight failures use the same typed envelope as everything else.
    assert.strictEqual(result.code, 6);
    assert.ok(result.stderr.includes('secret-provider'));
    assert.strictEqual(existsSync(path.join(project.dir, 'migronaut.config.json')), false);
  });

  it('should reject a stray init --json with a pointer to --format json', async () => {
    // `--json` is the global output flag everywhere else; on init it used to
    // silently mean "generate migronaut.config.json". Refusing loudly beats a
    // wrapper script uniformly appending --json and getting a committed
    // artifact in a different format.
    const result = await runCli(['init', '--json'], {}, project.dir);
    assert.strictEqual(result.code, 6);
    assert.ok(result.stderr.includes('--format json'));
    assert.strictEqual(existsSync(path.join(project.dir, 'migronaut.config.json')), false);
  });

  it('should generate migronaut.config.json via init --format json', async () => {
    const result = await runCli(['init', '--format', 'json'], {}, project.dir);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(existsSync(path.join(project.dir, 'migronaut.config.json')), true);
  });

  it('should exit 16 when init finds an existing config without --force', async () => {
    await runCli(['init'], {}, project.dir);
    const result = await runCli(['init'], {}, project.dir);
    // 16 = CONFIG_FILE_EXISTS: a provisioning script re-running init can tell
    // "already initialized" from "init crashed" without parsing stderr.
    assert.strictEqual(result.code, 16);
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

  it('should emit a JSON error object and a typed exit code on failure with --json', async () => {
    project.write('0001-x.ts', failingMigration());
    const result = await runCli(baseArgs(['up', '--json']));
    assert.strictEqual(result.code, 7);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.error.code, 'MIGRATION_EXECUTION_FAILED');
  });

  // ── status --check (feature 2) ───────────────────────────────────────────
  it('should exit 2 from status --check when migrations are pending', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const pending = await runCli(baseArgs(['status', '--check']));
    // A dedicated code: "database is behind" (act: migrate) must be
    // distinguishable from "the check itself crashed" (act: page someone).
    assert.strictEqual(pending.code, 2);

    await runCli(baseArgs(['up']));
    const clean = await runCli(baseArgs(['status', '--check']));
    assert.strictEqual(clean.code, 0);
  });

  it('should never let a crafted migration name emit raw ESC bytes', async () => {
    // A changelog record is attacker-influenced (anyone with DB write access);
    // its name reaches status output, which goes straight to a terminal.
    await mongo.db.collection('_migronaut_migrations').insertOne({
      name: 'evil-[2J[1;1H-clear.ts',
      batch: 1,
      status: 'applied',
      appliedAt: new Date(),
      duration: 1,
      checksum: 'x',
    });
    const result = await runCli(baseArgs(['status']));
    assert.strictEqual(result.code, 0);
    assert.ok(!result.stdout.includes('[2J'), 'clear-screen must be stripped');
    assert.ok(!result.stdout.includes('[1;1H'), 'cursor-move must be stripped');
  });

  it('should respect a logger from the config file instead of clobbering it', async () => {
    // README documents `logger` in migronaut.config.js; through the CLI it
    // used to be silently overwritten by the console logger. `logger: null`
    // is the observable case: core's lines disappear, command output stays.
    project.write('0001-a.ts', insertMigration('things', 'a'));
    // The config lives in its own cwd, NOT in the migrations dir — a .js file
    // there would itself be picked up as a (broken) migration.
    const cwd = path.join(project.dir, 'app');
    mkdirSync(cwd);
    writeFileSync(
      path.join(cwd, 'migronaut.config.js'),
      `export default { uri: ${JSON.stringify(mongo.uri)}, dbName: ${JSON.stringify(DB)}, ` +
        `migrationsDir: ${JSON.stringify(project.dir)}, logger: null };\n`,
    );
    const result = await runCli(['up'], {}, cwd);
    assert.strictEqual(result.code, 0);
    // Core's "✔ Applied" line is silenced by the config's logger: null…
    assert.ok(!result.stdout.includes('Applied'), 'core lines must honor logger: null');
    // …but the migration genuinely ran.
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should accept --json before the subcommand, like every other global flag', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    // `migronaut --json status` used to fail with "unknown option" while
    // `--verbose`/`--quiet` worked in both positions.
    const result = await runCli(['--json', ...baseArgs(['status'])]);
    assert.strictEqual(result.code, 0);
    const rows = JSON.parse(result.stdout);
    assert.strictEqual(rows[0].file, '0001-a.ts');
  });

  it('should show only the last N rows with status --limit', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    project.write('0003-c.ts', insertMigration('things', 'c'));
    const result = await runCli(baseArgs(['status', '--limit', '2', '--json']));
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(
      JSON.parse(result.stdout).map((row) => row.file),
      ['0002-b.ts', '0003-c.ts'],
    );
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

  it('should keep the lock when the unlock confirmation is declined', async () => {
    await mongo.db.collection('_migronaut_locks').insertOne({
      _id: 'migronaut_lock',
      lockedAt: new Date(),
      pid: 4242,
      host: 'crashed-host',
      executedBy: 'ghost',
      owner: 'stale-token',
    });
    const result = await runCli(baseArgs(['unlock']), {}, undefined, 'n\n');
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Aborted'));
    assert.strictEqual(await mongo.db.collection('_migronaut_locks').countDocuments(), 1);
  });

  it('should release after a yes confirmation and print the holder first', async () => {
    await mongo.db.collection('_migronaut_locks').insertOne({
      _id: 'migronaut_lock',
      lockedAt: new Date(),
      pid: 4242,
      host: 'crashed-host',
      executedBy: 'ghost',
      owner: 'stale-token',
    });
    const result = await runCli(baseArgs(['unlock']), {}, undefined, 'y\n');
    assert.strictEqual(result.code, 0);
    assert.ok(result.stderr.includes('crashed-host'));
    assert.ok(result.stdout.includes('Lock released'));
    assert.strictEqual(await mongo.db.collection('_migronaut_locks').countDocuments(), 0);
  });

  // ── migronaut lock (inspect) ──────────────────────────────────────────────────
  it('should show the holder in human mode and report no lock when free', async () => {
    const free = await runCli(baseArgs(['lock']));
    assert.strictEqual(free.code, 0);
    assert.ok(free.stdout.includes('No migration lock'));

    await mongo.db.collection('_migronaut_locks').insertOne({
      _id: 'migronaut_lock',
      lockedAt: new Date('2026-01-01T00:00:00Z'),
      pid: 4242,
      host: 'ci-runner',
      executedBy: 'deploy',
      owner: 'token',
    });
    const held = await runCli(baseArgs(['lock']));
    assert.strictEqual(held.code, 0);
    assert.ok(held.stdout.includes('pid 4242'));
    assert.ok(held.stdout.includes('ci-runner'));
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

describe('migronaut CLI — list/redo/import command wiring (integration)', () => {
  it('should list all, only pending, and only applied', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    await runCli(baseArgs(['up', '0001-a.ts']));

    const all = await runCli(baseArgs(['list', '--json']));
    assert.strictEqual(all.code, 0);
    assert.strictEqual(JSON.parse(all.stdout).length, 2);

    const pending = await runCli(baseArgs(['list', '--pending', '--json']));
    assert.deepStrictEqual(
      JSON.parse(pending.stdout).map((row) => row.file),
      ['0002-b.ts'],
    );

    const applied = await runCli(baseArgs(['list', '--applied', '--json']));
    assert.deepStrictEqual(
      JSON.parse(applied.stdout).map((row) => row.file),
      ['0001-a.ts'],
    );

    // Human mode renders a table with both files.
    const human = await runCli(baseArgs(['list']));
    assert.ok(human.stdout.includes('0001-a.ts'));
    assert.ok(human.stdout.includes('0002-b.ts'));
  });

  it('should print "No migrations found" for list on an empty project', async () => {
    const result = await runCli(baseArgs(['list']));
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('No migrations found'));
  });

  it('should redo the last applied migration via the CLI', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));

    const result = await runCli(baseArgs(['redo', '--json']));
    assert.strictEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(
      parsed.map((row) => row.status),
      ['reverted', 'applied'],
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should preview an import with import --dry-run --json without writing', async () => {
    await mongo.db.collection('changelog').insertOne({
      fileName: '0001-legacy.js',
      appliedAt: new Date('2024-01-01T00:00:00Z'),
    });

    const result = await runCli(baseArgs(['import', '--dry-run', '--json']));
    assert.strictEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.dryRun, true);
    assert.strictEqual(parsed.imported, 0);
    assert.deepStrictEqual(
      parsed.rows.map((row) => row.file),
      ['0001-legacy.js'],
    );
    assert.strictEqual(await mongo.db.collection('_migronaut_migrations').countDocuments(), 0);
  });

  it('should import through the CLI and then skip the adopted history on up', async () => {
    await mongo.db.collection('changelog').insertOne({
      fileName: '0001-legacy.js',
      appliedAt: new Date('2024-01-01T00:00:00Z'),
    });

    const result = await runCli(baseArgs(['import', '--json']));
    assert.strictEqual(result.code, 0);
    assert.strictEqual(JSON.parse(result.stdout).imported, 1);
    assert.strictEqual(await mongo.db.collection('_migronaut_migrations').countDocuments(), 1);
  });

  it('should pass --from/--to/--trust-hash/--force through the import command', async () => {
    await mongo.db.collection('legacy_changelog').insertOne({
      fileName: '0001-legacy.js',
      appliedAt: new Date('2024-01-01T00:00:00Z'),
      fileHash: 'f'.repeat(64),
    });
    // Non-empty target plus --force exercises the overwrite path end to end.
    await mongo.db
      .collection('custom_target')
      .insertOne({ name: '0000-existing.js', batch: 1, status: 'applied' });

    const result = await runCli(
      baseArgs([
        'import',
        '--from',
        'legacy_changelog',
        '--to',
        'custom_target',
        '--trust-hash',
        '--force',
        '--json',
      ]),
    );
    assert.strictEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.source, 'legacy_changelog');
    assert.strictEqual(parsed.target, 'custom_target');
    assert.strictEqual(parsed.imported, 1);
    assert.strictEqual(parsed.rows[0].checksumSource, 'reused');
  });

  it('should preview dry-run down --batch and dry-run up --to through the CLI', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    project.write('0003-c.ts', insertMigration('things', 'c'));
    await runCli(baseArgs(['up', '0001-a.ts']));

    const to = await runCli(baseArgs(['dry-run', 'up', '--to', '0002-b.ts', '--json']));
    assert.strictEqual(to.code, 0);
    assert.deepStrictEqual(
      JSON.parse(to.stdout).map((row) => row.file),
      ['0002-b.ts'],
    );

    const batch = await runCli(baseArgs(['dry-run', 'down', '--batch', '1', '--json']));
    assert.strictEqual(batch.code, 0);
    assert.deepStrictEqual(
      JSON.parse(batch.stdout).map((row) => row.file),
      ['0001-a.ts'],
    );
    // A preview writes nothing.
    assert.strictEqual(await mongo.db.collection('_migronaut_migrations').countDocuments(), 1);
  });

  it('should render redo results in human mode', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));

    const result = await runCli(baseArgs(['redo']));
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Reverted'));
    assert.ok(result.stdout.includes('Applied'));
  });
});

describe('migronaut CLI — quiet mode and output safety (integration)', () => {
  it('should silence tables and info lines under --quiet but keep errors', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runCli(baseArgs(['up']));

    const status = await runCli(baseArgs(['status', '--quiet']));
    assert.strictEqual(status.code, 0);
    assert.strictEqual(status.stdout, '');

    const list = await runCli(baseArgs(['list', '--quiet']));
    assert.strictEqual(list.stdout, '');

    // Errors must survive --quiet.
    const failing = await runCli(baseArgs(['down', '0009-missing.ts', '--quiet']));
    assert.strictEqual(failing.code, 9);
    assert.ok(failing.stderr.includes('NOT_APPLIED'));
  });

  it('should never print connection credentials in any output channel', async () => {
    const secret = 'sup3rSecretPass';
    const json = await runCli([
      '--uri',
      `mongodb://ci-user:${secret}@`,
      '--db',
      'x',
      '--dir',
      project.dir,
      'status',
      '--json',
    ]);
    assert.strictEqual(json.code, 5);
    assert.ok(!json.stdout.includes(secret));
    assert.ok(!json.stderr.includes(secret));
    // The username may remain; the password must be masked.
    assert.ok(json.stdout.includes('****'));

    const verbose = await runCli([
      '--uri',
      `mongodb://ci-user:${secret}@`,
      '--db',
      'x',
      '--dir',
      project.dir,
      'status',
      '--verbose',
    ]);
    assert.ok(!verbose.stdout.includes(secret));
    assert.ok(!verbose.stderr.includes(secret));
  });

  it('should exit cleanly when stdout closes early (EPIPE)', async () => {
    for (let i = 1; i <= 60; i++) {
      project.write(`00${String(i).padStart(2, '0')}-m${i}.ts`, insertMigration('things', `m${i}`));
    }
    await runCli(baseArgs(['up']));

    // Pipe a large --json document into `head -1`: head exits after one line,
    // the pipe closes, and the CLI must treat the resulting EPIPE as success
    // instead of crashing with a raw Node stack.
    const script =
      `node ${JSON.stringify(binPath)} --uri ${JSON.stringify(mongo.uri)} ` +
      `--db ${JSON.stringify(DB)} --dir ${JSON.stringify(project.dir)} status --json | head -1`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', script], { env: { ...process.env } });
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
    assert.ok(!result.stderr.includes('EPIPE'));
    assert.ok(!result.stderr.includes('Unhandled'));
  });
});
