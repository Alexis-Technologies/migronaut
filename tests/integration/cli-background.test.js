const { spawn } = require('node:child_process');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { EXIT_CODES } = require('../../src/cli/exit-codes.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeProject } = require('../helpers/project.js');

const repoRoot = path.join(__dirname, '..', '..');
const binPath = path.join(repoRoot, 'bin', 'migronaut.js');

const COLOR_VARS = new Set([
  'FORCE_COLOR',
  'NO_COLOR',
  'MIGRONAUT_FORCE_COLOR',
  'MIGRONAUT_NO_COLOR',
]);
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !COLOR_VARS.has(name)),
);

/** The CLI as a child process; `onLine` sees stdout line by line (to signal it mid-run) */
function runCli(args, { input, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: project.dir,
      env: baseEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      onLine?.(String(chunk), child);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      onLine?.(String(chunk), child);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

let mongo;
const DB = 'migronaut_cli_background_test';
const NAME = '0001-orders.js';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

let project;

beforeEach(async () => {
  await mongo.db.dropDatabase();
  await mongo.db.collection('orders').createIndex({ __v: 1, _id: 1 });
  await mongo.db
    .collection('orders')
    .insertMany(Array.from({ length: 300 }, (_, i) => ({ __v: 1, __rev: 0, i })));
  project = makeProject();
});

afterEach(() => {
  project?.cleanup();
});

const args = (...extra) => ['--uri', mongo.uri, '--db', DB, '--dir', project.dir, ...extra];

const spec = (body = '') => `export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  pauseMs: 0,
  batchSize: 20,
  migrate: (doc) => ({ ...doc, done: true }),
  ${body}
};
`;

describe('migronaut background (CLI)', () => {
  it('should register on up, show its status, run it, and pass the --check gate after', async () => {
    project.write(NAME, spec());
    assert.strictEqual((await runCli(args('up'))).code, 0);
    const pending = await runCli(args('background', 'status', '--check'));
    assert.strictEqual(pending.code, EXIT_CODES.BACKGROUND_PENDING);
    assert.match(pending.stdout, /0001-orders\.js/);
    const run = await runCli(args('background', 'run', NAME, '--concurrency', '2'));
    assert.strictEqual(run.code, 0, run.stderr);
    assert.match(run.stderr + run.stdout, /maxParallel \(1\) — using 1/);
    const done = await runCli(args('--json', 'background', 'status', '--check'));
    assert.strictEqual(done.code, 0);
    const [status] = JSON.parse(done.stdout).background;
    assert.strictEqual(status.status, 'completed');
    assert.strictEqual(status.totals.migrated, 300);
    const parts = await runCli(args('--json', 'background', 'status', NAME, '--partitions'));
    assert.strictEqual(JSON.parse(parts.stdout).partitions[0].status, 'done');
    const verify = await runCli(args('background', 'verify'));
    assert.strictEqual(verify.code, 0);
    await mongo.db.collection('orders').insertOne({ __v: 1, __rev: 0 });
    const drift = await runCli(args('background', 'verify', '--report'));
    assert.strictEqual(drift.code, EXIT_CODES.BACKGROUND_PENDING);
  });

  it('should run --all until nothing is left, even one listed before what it waits for', async () => {
    project.write(NAME, spec());
    project.write(
      '0002-orders-v3.js',
      `export const requires = ['${NAME}'];
export const background = {
  collection: 'orders',
  from: 2,
  to: 3,
  pauseMs: 0,
  migrate: (doc) => doc,
};
`,
    );
    assert.strictEqual((await runCli(args('up'))).code, 0);
    // Registered again: now listed after the one that waits for it.
    const again = await runCli(args('up', NAME, '--force', '--yes'));
    assert.strictEqual(again.code, 0, again.stderr);
    const run = await runCli(args('--json', 'background', 'run', '--all'));
    assert.strictEqual(run.code, 0, run.stderr);
    const status = await runCli(args('--json', 'background', 'status'));
    const states = JSON.parse(status.stdout).background;
    assert.deepStrictEqual(states.map((state) => [state.migration, state.status]).sort(), [
      [NAME, 'completed'],
      ['0002-orders-v3.js', 'completed'],
    ]);
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 3 }), 300);
  });

  it('should control it, refuse what does not fit (33) and what is not registered (9)', async () => {
    project.write(NAME, spec());
    await runCli(args('up'));
    assert.strictEqual(
      (await runCli(args('background', 'pause', NAME, '--reason', 'night'))).code,
      0,
    );
    assert.strictEqual(
      (await runCli(args('background', 'retry', NAME))).code,
      EXIT_CODES.BACKGROUND_CONFLICT,
    );
    assert.strictEqual((await runCli(args('background', 'resume', NAME))).code, 0);
    const cancel = await runCli(args('--json', 'background', 'cancel', NAME));
    assert.strictEqual(cancel.code, EXIT_CODES.CONFIG_INVALID, 'needs --yes with --json');
    assert.strictEqual(
      (await runCli(args('background', 'cancel', NAME), { input: 'y\n' })).code,
      0,
    );
    assert.strictEqual(
      (await runCli(args('background', 'pause', 'nope.js'))).code,
      EXIT_CODES.NOT_APPLIED,
    );
    assert.strictEqual(
      (await runCli(args('background', 'retry', NAME, '--from-start', '--yes'))).code,
      0,
    );
    assert.strictEqual((await runCli(args('background', 'unlock', NAME, '--yes'))).code, 0);
    assert.strictEqual((await runCli(args('background', 'repin', NAME, '--yes'))).code, 0);
  });

  it('should fail with 32 when the background migration fails', async () => {
    project.write(
      NAME,
      spec(`migrateBatch: async () => { throw new Error('nope'); }, maxSliceFailures: 1,`).replace(
        '  migrate: (doc) => ({ ...doc, done: true }),\n',
        '',
      ),
    );
    await runCli(args('up'));
    const run = await runCli(args('background', 'run', NAME));
    assert.strictEqual(run.code, EXIT_CODES.BACKGROUND_FAILED, run.stderr);
    const check = await runCli(args('background', 'status', '--check'));
    assert.strictEqual(check.code, EXIT_CODES.BACKGROUND_FAILED);
  });

  it('should stop its lanes on SIGINT with exit 11, and go on from there next time', async () => {
    project.write(
      NAME,
      spec(`migrateBatch: async (docs) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return docs.map((doc) => ({ ...doc, done: true }));
  },`).replace('  migrate: (doc) => ({ ...doc, done: true }),\n', ''),
    );
    await runCli(args('up'));
    let sent = false;
    const run = await runCli(args('--verbose', 'background', 'run', NAME), {
      onLine: (text, child) => {
        if (!sent && /Partitioned|background|Planned|batch/i.test(text)) {
          sent = true;
          setTimeout(() => child.kill('SIGINT'), 150);
        }
      },
    });
    assert.strictEqual(run.code, EXIT_CODES.RUN_ABORTED, run.stderr);
    const left = await mongo.db.collection('orders').countDocuments({ __v: 1 });
    assert.ok(left > 0 && left < 300, `stopped midway: ${left}`);
    assert.strictEqual((await runCli(args('background', 'run', NAME))).code, 0);
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 1 }), 0);
  });

  it('should dry-run on a sample (1 when nothing would migrate) and by steps (34 on a refusal)', async () => {
    project.write(NAME, spec());
    const ok = await runCli(
      args('--json', 'background', 'dry-run', NAME, '--first', '3', '--validate'),
    );
    assert.strictEqual(ok.code, 0, ok.stderr);
    assert.strictEqual(JSON.parse(ok.stdout).dryRun.migrated, 3);
    project.write(
      '0002-none.js',
      `export const background = { collection: 'nothing', from: 1, to: 2, migrate: (d) => d };\n`,
    );
    assert.strictEqual((await runCli(args('background', 'dry-run', '0002-none.js'))).code, 1);
    project.write(
      '0003-step.js',
      `export const background = {
  step: async ({ db }) => {
    await db.collection('orders').createIndex({ i: 1 }).catch(() => undefined);
    return { checkpoint: null, done: true };
  },
};
`,
    );
    const refused = await runCli(args('background', 'dry-run', '0003-step.js', '--steps', '2'));
    assert.strictEqual(refused.code, EXIT_CODES.SANDBOX_REFUSED);
    assert.match(refused.stderr + refused.stdout, /Refused collection\.createIndex/);
    assert.strictEqual(
      (await runCli(args('background', 'dry-run', NAME, '--steps', '2'))).code,
      EXIT_CODES.CONFIG_INVALID,
    );
  });

  it('should watch for drift in the foreground and stop cleanly on SIGINT (exit 0)', async () => {
    project.write(NAME, spec());
    await runCli(args('up'));
    assert.strictEqual((await runCli(args('background', 'run', NAME))).code, 0);
    let inserted = false;
    let sent = false;
    let output = '';
    const run = await runCli(args('background', 'watch', 'orders'), {
      onLine: (text, child) => {
        output += text;
        if (!inserted && /orders: streaming/.test(output)) {
          inserted = true;
          mongo.db.collection('orders').insertOne({ __v: 1, __rev: 0, late: true });
        }
        if (!sent && /orders: upgraded/.test(output)) {
          sent = true;
          child.kill('SIGINT');
        }
      },
    });
    assert.strictEqual(run.code, 0, run.stderr);
    assert.match(run.stdout + run.stderr, /Stopped watching — 1 document\(s\) upgraded/);
    assert.strictEqual(
      await mongo.db.collection('orders').countDocuments({ late: true, __v: 2 }),
      1,
    );
  });

  it('should refuse a wrong action, a missing name and a flag of another action before connecting', async () => {
    for (const bad of [
      ['background', 'explode'],
      ['background', 'pause'],
      ['background', 'run'],
      ['background', 'verify', NAME],
      ['background', 'status', '--validate'],
      ['background', 'watch', '--concurrency', '2'],
      ['background', 'run', NAME, '--concurrency', '0'],
    ]) {
      assert.strictEqual(
        (await runCli(args(...bad))).code,
        EXIT_CODES.CONFIG_INVALID,
        bad.join(' '),
      );
    }
  });

  it('should create a background migration file from its template', async () => {
    const created = await runCli(args('create', 'orders v2', '--background', '--js'));
    assert.strictEqual(created.code, 0, created.stderr);
    const [file] = readdirSync(project.dir).filter((name) => name.endsWith('.js'));
    const content = readFileSync(path.join(project.dir, file), 'utf8');
    assert.match(content, /export const background = \{/);
    assert.match(content, /migrate: \(doc\) =>/);
    // No identity revert: down would stamp the old version on the new shape.
    assert.match(content, /\/\/ revert:/);
    assert.strictEqual(
      (await runCli(args('create', 'x', '--background', '--template', 'a.js'))).code,
      EXIT_CODES.CONFIG_INVALID,
    );
    // As it is, the scaffold is refused by up — its placeholder collection would "complete" at once.
    const up = await runCli(args('up'));
    assert.strictEqual(up.code, EXIT_CODES.MIGRATION_INVALID_EXPORT, up.stderr);
    assert.match(up.stderr + up.stdout, /placeholder/);
  });
});

describe('migronaut background on a standalone server (CLI)', () => {
  let standalone;

  before(async () => {
    standalone = await MongoMemoryServer.create();
  });

  after(async () => {
    await standalone.stop();
  });

  it('should exit 15 for a step dry run, which needs a transaction', async () => {
    project.write(
      NAME,
      `export const background = { step: async () => ({ checkpoint: null, done: true }) };\n`,
    );
    const result = await runCli([
      '--uri',
      standalone.getUri(),
      '--db',
      'cli_bg',
      '--dir',
      project.dir,
      'background',
      'dry-run',
      NAME,
    ]);
    assert.strictEqual(result.code, EXIT_CODES.TRANSACTIONS_UNSUPPORTED);
  });
});
