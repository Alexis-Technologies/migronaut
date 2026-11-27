/**
 * Zero-dependency benchmark of migronaut's hot paths — a regression tripwire, not a budget.
 *
 * Run: pnpm bench                       a table
 *      node bench/bench.js --json        the same as a document, to diff two runs
 *
 * Every scenario is measured as SAMPLES windows after a warmup and reported as
 * the median with its spread (the samples' range, as a share of the median): a
 * row that moved by less than its spread did not move. The CPU-bound scenarios
 * each run in a process of their own, so one scenario's JIT state and heap do
 * not shape the next; the database ones share one in-memory replica set. The
 * loader is measured cached (what a run pays per file after its first import)
 * and cold (`reload: true`, a fresh evaluation each time), and `up()` once cold
 * and then cached. The environment the numbers came from is printed with them.
 */
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { performance } = require('node:perf_hooks');

const { Changelog } = require('../src/core/changelog.js');
const { MigrationLock } = require('../src/core/lock.js');
const { MigratorKit } = require('../src/core/migrator.js');
const { computeChecksum } = require('../src/utils/checksum.js');
const { loadMigrationFile } = require('../src/utils/loader.js');
const {
  startBenchMongo,
  makeFixtureDir,
  writeChecksumFixture,
  writeLoaderFixtures,
  seedChangelogRecords,
  seedRevertPool,
} = require('./helpers.js');

const SAMPLES = 7;
const CPU = { warmup: 2_000, windowMs: 250 };
// A cold load evaluates a module that is never freed: fewer of them.
const COLD = { warmup: 100, windowMs: 100 };
// DB round trips (even against an in-memory replica set) are far slower than
// pure CPU/fs calls; scale the windows down so they do not dominate the run.
const DB = { warmup: 100, windowMs: 100 };

const CHANGELOG_COLLECTION = '_migronaut_bench_migrations';
const LOCK_COLLECTION = '_migronaut_bench_locks';
const CHANGELOG_SEED_COUNT = 1_000;
const REVERT_POOL_SIZE = 20_000;
const E2E_MIGRATION_COUNT = 100;
const E2E_CACHED_RUNS = 5;

/** The CPU-bound scenarios, by the id a child process is started with */
const CPU_CASES = {
  __proto__: null,
  'checksum-small': {
    name: 'computeChecksum — small migration file (~1 KB)',
    run: (file) => computeChecksum(file),
    settings: CPU,
  },
  'checksum-large': {
    name: 'computeChecksum — large migration file (~100 KB)',
    run: (file) => computeChecksum(file),
    settings: CPU,
  },
  'load-cjs': {
    name: 'loadMigrationFile — CommonJS default export, cached',
    run: (file) => loadMigrationFile(file),
    settings: CPU,
  },
  'load-esm': {
    name: 'loadMigrationFile — ESM named exports, cached',
    run: (file) => loadMigrationFile(file),
    settings: CPU,
  },
  'load-ts': {
    name: 'loadMigrationFile — TypeScript (type stripping), cached',
    run: (file) => loadMigrationFile(file),
    settings: CPU,
  },
  'load-cjs-cold': {
    name: 'loadMigrationFile — CommonJS default export, cold',
    run: (file) => loadMigrationFile(file, { reload: true }),
    settings: COLD,
  },
  'load-esm-cold': {
    name: 'loadMigrationFile — ESM named exports, cold',
    run: (file) => loadMigrationFile(file, { reload: true }),
    settings: COLD,
  },
  'load-ts-cold': {
    name: 'loadMigrationFile — TypeScript (type stripping), cold',
    run: (file) => loadMigrationFile(file, { reload: true }),
    settings: COLD,
  },
};

// What every measured call returned, counted: an observed result is one the
// engine cannot drop as dead code.
let sink = 0;

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** `{ median, spread }` of `values`: spread is the range as a share of the median */
const summarize = (values) => {
  const middle = median(values);
  const spread = middle === 0 ? 0 : (Math.max(...values) - Math.min(...values)) / middle;
  return { median: middle, spread };
};

/** Ops/sec of `fn` over SAMPLES windows after `warmup` calls */
const measure = async (fn, { warmup, windowMs }) => {
  for (let i = 0; i < warmup; i++) if ((await fn()) !== undefined) sink += 1;
  const samples = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    let iterations = 0;
    const start = performance.now();
    while (performance.now() - start < windowMs) {
      if ((await fn()) !== undefined) sink += 1;
      iterations += 1;
    }
    samples.push((iterations / (performance.now() - start)) * 1000);
  }
  return summarize(samples);
};

/** One CPU case, in this (child) process: its summary as one JSON line on stdout */
const runCase = async (id, file) => {
  const scenario = CPU_CASES[id];
  const summary = await measure(() => scenario.run(file), scenario.settings);
  process.stdout.write(`${JSON.stringify({ ...summary, sink })}\n`);
};

/** One CPU case in a process of its own */
const spawnCase = (id, file) => {
  const child = spawnSync(process.execPath, [__filename, '--case', id, file], {
    encoding: 'utf8',
  });
  if (child.status !== 0) throw new Error(`bench case ${id} failed: ${child.stderr}`);
  const { median: ops, spread } = JSON.parse(child.stdout.trim().split('\n').at(-1));
  return { name: CPU_CASES[id].name, unit: 'ops/sec', median: ops, spread };
};

const formatNumber = (value) => Math.round(value).toLocaleString('en-US');

const printRow = (row) => {
  const value = `${formatNumber(row.median)} ${row.unit}`;
  const spread = `±${Math.round((row.spread * 100) / 2)}%`;
  console.log(`${row.name.padEnd(62)} ${value.padStart(16)} ${spread.padStart(6)}`);
};

const describeEnvironment = (mongoVersion) => ({
  node: process.version,
  v8: process.versions.v8,
  platform: `${process.platform} ${process.arch}`,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  cores: os.availableParallelism(),
  execArgv: process.execArgv,
  mongodb: mongoVersion,
  date: new Date().toISOString(),
});

const benchDatabase = async (mongo, rows) => {
  const changelog = new Changelog(CHANGELOG_COLLECTION);
  await changelog.ensureIndexes(mongo.db);
  await seedChangelogRecords(mongo.db, CHANGELOG_COLLECTION, CHANGELOG_SEED_COUNT);
  await seedRevertPool(mongo.db, CHANGELOG_COLLECTION, REVERT_POOL_SIZE);
  const records = CHANGELOG_SEED_COUNT.toLocaleString('en-US');
  const add = async (name, fn) => rows.push({ name, unit: 'ops/sec', ...(await measure(fn, DB)) });

  await add(`Changelog.getAll — ${records} records`, () => changelog.getAll(mongo.db));
  await add(`Changelog.getAppliedNames — ${records} records`, () =>
    changelog.getAppliedNames(mongo.db),
  );
  await add(`Changelog.getLastBatch — ${records} records`, () => changelog.getLastBatch(mongo.db));
  await add('Changelog.markApplied — idempotent upsert', () =>
    changelog.markApplied(mongo.db, {
      name: 'bench-mark-applied.js',
      batch: 1,
      status: 'applied',
      appliedAt: new Date(),
      duration: 1,
      checksum: 'c'.repeat(64),
      environment: 'bench',
    }),
  );
  let revertCursor = 0;
  await add('Changelog.markReverted — update existing applied record', () =>
    changelog.markReverted(mongo.db, `bench-revert-${revertCursor++ % REVERT_POOL_SIZE}`),
  );

  const lock = new MigrationLock(mongo.db, LOCK_COLLECTION, 60);
  await add('MigrationLock.acquire + release — uncontended round trip', async () => {
    await lock.acquire();
    return lock.release();
  });
  await lock.acquire();
  try {
    await add('MigrationLock.renew — heartbeat update', () => lock.renew());
  } finally {
    await lock.release();
  }
};

/** `up()` over E2E_MIGRATION_COUNT files: the first run (cold imports), then cached ones */
const benchUp = async (mongo, rows) => {
  const migrationsDir = makeFixtureDir();
  try {
    for (let i = 0; i < E2E_MIGRATION_COUNT; i++) {
      writeChecksumFixture(migrationsDir, `2026${`${i}`.padStart(6, '0')}-bench.js`, 512);
    }
    const kitConfig = {
      uri: mongo.uri,
      dbName: 'migronaut_bench_e2e',
      migrationsDir: migrationsDir.dir,
      migrationsCollection: '_migronaut_e2e_migrations',
      lockCollection: '_migronaut_e2e_locks',
      logger: null,
    };
    const changelog = mongo.client
      .db('migronaut_bench_e2e')
      .collection('_migronaut_e2e_migrations');
    // A full up() is only meaningful once per changelog: wall-clock per run,
    // the changelog dropped between runs.
    const timeOneUp = async () => {
      await changelog.drop().catch(() => undefined);
      const kit = new MigratorKit(kitConfig);
      const start = performance.now();
      await kit.up();
      const ms = performance.now() - start;
      await kit.disconnect();
      return ms;
    };
    const coldMs = await timeOneUp();
    const cached = [];
    for (let i = 0; i < E2E_CACHED_RUNS; i++) cached.push(await timeOneUp());
    const name = `MigratorKit.up() — ${E2E_MIGRATION_COUNT} pending files`;
    rows.push({ name: `${name}, cold`, unit: 'ms/run', median: coldMs, spread: 0 });
    rows.push({ name: `${name}, cached`, unit: 'ms/run', ...summarize(cached) });

    const statusKit = new MigratorKit(kitConfig);
    await statusKit.connect();
    try {
      const summary = await measure(() => statusKit.status(), { warmup: 5, windowMs: DB.windowMs });
      rows.push({
        name: `MigratorKit.status() — ${E2E_MIGRATION_COUNT} applied records`,
        unit: 'ops/sec',
        ...summary,
      });
    } finally {
      await statusKit.disconnect();
    }
  } finally {
    migrationsDir.cleanup();
  }
};

const main = async () => {
  const asJson = process.argv.includes('--json');
  const rows = [];
  const fixtureDir = makeFixtureDir();
  let mongoVersion = 'unknown';
  try {
    const small = writeChecksumFixture(fixtureDir, 'small.js', 1_024);
    const large = writeChecksumFixture(fixtureDir, 'large.js', 100 * 1_024);
    const { cjsFile, esmFile, tsFile } = writeLoaderFixtures(fixtureDir);
    const cases = [
      ['checksum-small', small],
      ['checksum-large', large],
      ['load-cjs', cjsFile],
      ['load-esm', esmFile],
      ['load-cjs-cold', cjsFile],
      ['load-esm-cold', esmFile],
    ];
    const canStripTypes = await loadMigrationFile(tsFile).then(
      () => true,
      () => false,
    );
    if (canStripTypes) cases.push(['load-ts', tsFile], ['load-ts-cold', tsFile]);
    for (const [id, file] of cases) rows.push(spawnCase(id, file));

    const mongo = await startBenchMongo();
    try {
      const info = await mongo.db.admin().command({ buildInfo: 1 });
      mongoVersion = info.version;
      await benchDatabase(mongo, rows);
      await benchUp(mongo, rows);
    } finally {
      await mongo.stop();
    }
  } finally {
    fixtureDir.cleanup();
  }
  const environment = describeEnvironment(mongoVersion);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ environment, samples: SAMPLES, rows }, null, 2)}\n`);
    return;
  }
  const { cpu, cores, node, platform, mongodb, execArgv } = environment;
  console.log(`${cpu} (${cores} cores), ${platform}, Node ${node}, MongoDB ${mongodb}`);
  if (execArgv.length > 0) console.log(`execArgv: ${execArgv.join(' ')}`);
  console.log(`median of ${SAMPLES} samples, ± half their range\n`);
  for (const row of rows) printRow(row);
};

const caseAt = process.argv.indexOf('--case');
const entry = caseAt === -1 ? main() : runCase(process.argv[caseAt + 1], process.argv[caseAt + 2]);
entry.catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
