/**
 * Zero-dependency ops/sec benchmark for migronaut's hot paths.
 *
 * Run: pnpm bench (or: node bench/bench.js)
 *
 * Results are recorded in the README "Benchmarks" section — update it when a
 * change moves the numbers. The Changelog/MigrationLock scenarios spin up a
 * throwaway in-memory MongoDB replica set for the run (mongodb-memory-server,
 * already a devDependency — nothing new is installed).
 */
const { performance } = require('node:perf_hooks');
const { computeChecksum } = require('../src/utils/checksum.js');
const { loadMigrationFile } = require('../src/utils/loader.js');
const { Changelog } = require('../src/core/changelog.js');
const { MigrationLock } = require('../src/core/lock.js');
const { MigratorKit } = require('../src/core/migrator.js');
const {
  startBenchMongo,
  makeFixtureDir,
  writeChecksumFixture,
  writeLoaderFixtures,
  seedChangelogRecords,
  seedRevertPool,
} = require('./helpers.js');

const WARMUP_ITERATIONS = 2_000;
const MEASURE_MS = 1_000;

// DB round trips (even against an in-memory replica set) are far slower than
// pure CPU/fs calls; scale both windows down so the DB-bound scenarios don't
// dominate total run time.
const DB_WARMUP_ITERATIONS = 100;
const DB_MEASURE_MS = 500;

async function bench(name, fn, { warmup = WARMUP_ITERATIONS, measureMs = MEASURE_MS } = {}) {
  for (let i = 0; i < warmup; i++) await fn();

  let iterations = 0;
  const start = performance.now();
  while (performance.now() - start < measureMs) {
    await fn();
    iterations += 1;
  }
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round((iterations / elapsed) * 1000);
  console.log(`${name.padEnd(58)} ${opsPerSec.toLocaleString('en-US').padStart(12)} ops/sec`);
  return { name, opsPerSec };
}

const CHANGELOG_COLLECTION = '_migronaut_bench_migrations';
const LOCK_COLLECTION = '_migronaut_bench_locks';
const CHANGELOG_SEED_COUNT = 1_000;
const REVERT_POOL_SIZE = 20_000;
const E2E_MIGRATION_COUNT = 100;

async function main() {
  console.log(`Node ${process.version} | ${new Date().toISOString()}\n`);
  const results = [];
  const fixtureDir = makeFixtureDir();

  try {
    // ---------- checksum.js (no DB) ----------
    const smallFile = writeChecksumFixture(fixtureDir, 'small.js', 1_024);
    const largeFile = writeChecksumFixture(fixtureDir, 'large.js', 100 * 1_024);
    results.push(
      await bench('computeChecksum — small migration file (~1 KB)', () =>
        computeChecksum(smallFile)),
    );
    results.push(
      await bench('computeChecksum — large migration file (~100 KB)', () =>
        computeChecksum(largeFile)),
    );

    // ---------- loader.js (no DB) ----------
    const { cjsFile, esmFile, tsFile } = writeLoaderFixtures(fixtureDir);
    results.push(
      await bench('loadMigrationFile — CommonJS default export', () => loadMigrationFile(cjsFile)),
    );
    results.push(
      await bench('loadMigrationFile — ESM named exports', () => loadMigrationFile(esmFile)),
    );
    try {
      await loadMigrationFile(tsFile);
      results.push(
        await bench('loadMigrationFile — TypeScript (native type-stripping)', () =>
          loadMigrationFile(tsFile)),
      );
    } catch {
      console.log('(TypeScript migrations not supported on this Node runtime — skipping)');
    }

    // ---------- changelog.js + lock.js (DB-bound — shared in-memory replset) ----------
    const mongo = await startBenchMongo();
    try {
      const changelog = new Changelog(CHANGELOG_COLLECTION);
      await changelog.ensureIndexes(mongo.db);
      await seedChangelogRecords(mongo.db, CHANGELOG_COLLECTION, CHANGELOG_SEED_COUNT);
      await seedRevertPool(mongo.db, CHANGELOG_COLLECTION, REVERT_POOL_SIZE);

      const dbOpts = { warmup: DB_WARMUP_ITERATIONS, measureMs: DB_MEASURE_MS };

      results.push(
        await bench(
          `Changelog.getAll — ${CHANGELOG_SEED_COUNT.toLocaleString('en-US')} records`,
          () => changelog.getAll(mongo.db),
          dbOpts,
        ),
      );
      results.push(
        await bench(
          `Changelog.getAppliedNames — ${CHANGELOG_SEED_COUNT.toLocaleString('en-US')} records`,
          () => changelog.getAppliedNames(mongo.db),
          dbOpts,
        ),
      );
      results.push(
        await bench(
          `Changelog.getLastBatch — ${CHANGELOG_SEED_COUNT.toLocaleString('en-US')} records`,
          () => changelog.getLastBatch(mongo.db),
          dbOpts,
        ),
      );
      results.push(
        await bench(
          'Changelog.markApplied — idempotent upsert',
          () =>
            changelog.markApplied(mongo.db, {
              name: 'bench-mark-applied.js',
              batch: 1,
              status: 'applied',
              appliedAt: new Date(),
              duration: 1,
              checksum: 'c'.repeat(64),
              environment: 'bench',
            }),
          dbOpts,
        ),
      );

      let revertCursor = 0;
      results.push(
        await bench(
          'Changelog.markReverted — update existing applied record',
          () =>
            changelog.markReverted(mongo.db, `bench-revert-${revertCursor++ % REVERT_POOL_SIZE}`),
          dbOpts,
        ),
      );

      const lock = new MigrationLock(mongo.db, LOCK_COLLECTION, 60);
      results.push(
        await bench(
          'MigrationLock.acquire + release — uncontended round trip',
          async () => {
            await lock.acquire();
            await lock.release();
          },
          dbOpts,
        ),
      );

      await lock.acquire();
      try {
        results.push(
          await bench('MigrationLock.renew — heartbeat update', () => lock.renew(), dbOpts),
        );
      } finally {
        await lock.release();
      }

      // ---------- end-to-end MigratorKit (the user-facing hot paths) ----------
      const migrationsDir = makeFixtureDir();
      try {
        for (let i = 0; i < E2E_MIGRATION_COUNT; i++) {
          writeChecksumFixture(migrationsDir, `2026${String(i).padStart(6, '0')}-bench.js`, 512);
        }
        const kitConfig = {
          uri: mongo.uri,
          dbName: 'migronaut_bench_e2e',
          migrationsDir: migrationsDir.dir,
          migrationsCollection: '_migronaut_e2e_migrations',
          lockCollection: '_migronaut_e2e_locks',
          logger: null,
        };
        const e2eDb = mongo.client.db('migronaut_bench_e2e');

        // A full up() is only meaningful once per changelog, so this measures
        // wall-clock per run (dropping the changelog between runs) instead of
        // ops/sec.
        const runs = 3;
        let totalMs = 0;
        for (let i = 0; i < runs; i++) {
          await e2eDb
            .collection('_migronaut_e2e_migrations')
            .drop()
            .catch(() => undefined);
          const kit = new MigratorKit(kitConfig);
          const start = performance.now();
          await kit.up();
          totalMs += performance.now() - start;
          await kit.disconnect();
        }
        const perRun = Math.round(totalMs / runs);
        console.log(
          `${`MigratorKit.up() — ${E2E_MIGRATION_COUNT} pending files, end-to-end`.padEnd(58)} ${`${perRun.toLocaleString('en-US')} ms/run`.padStart(
            16,
          )}`,
        );
        results.push({
          name: `MigratorKit.up() — ${E2E_MIGRATION_COUNT} pending files`,
          msPerRun: perRun,
        });

        const statusKit = new MigratorKit(kitConfig);
        await statusKit.connect();
        try {
          results.push(
            await bench(
              `MigratorKit.status() — ${E2E_MIGRATION_COUNT} applied records`,
              () => statusKit.status(),
              { warmup: 5, measureMs: DB_MEASURE_MS },
            ),
          );
        } finally {
          await statusKit.disconnect();
        }
      } finally {
        migrationsDir.cleanup();
      }
    } finally {
      await mongo.stop();
    }
  } finally {
    fixtureDir.cleanup();
  }

  return results;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
