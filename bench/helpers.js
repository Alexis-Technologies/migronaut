const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const TMP_ROOT = path.join(__dirname, '.tmp');

/**
 * Start one in-memory MongoDB replica set for the whole bench run.
 * A replica set (not a standalone) matches tests/helpers/mongo.js so the
 * DB-bound scenarios see the same engine migronaut runs against in production.
 */
async function startBenchMongo(dbName = 'migronaut_bench') {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = new MongoClient(replSet.getUri());
  await client.connect();
  return {
    db: client.db(dbName),
    stop: async () => {
      await client.close();
      await replSet.stop();
    },
  };
}

/** Create an isolated scratch directory under bench/.tmp for fixture files */
function makeFixtureDir() {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_ROOT, 'run-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Write a migration-shaped file padded with comment lines to hit approxBytes */
function writeChecksumFixture(fixtureDir, name, approxBytes) {
  const filepath = path.join(fixtureDir.dir, name);
  const line = '// padding to make this file a realistic size for benchmarking\n';
  const padding = line.repeat(Math.max(1, Math.ceil(approxBytes / line.length)));
  const body = `${padding}module.exports = {
  async up({ db }) {
    await db.collection('bench_things').insertOne({ created: true });
  },
  async down({ db }) {
    await db.collection('bench_things').deleteMany({});
  },
};
`;
  writeFileSync(filepath, body, 'utf8');
  return filepath;
}

/** Write CJS/ESM/TS migration fixtures for loadMigrationFile benchmarking */
function writeLoaderFixtures(fixtureDir) {
  const cjsFile = path.join(fixtureDir.dir, 'valid-cjs.cjs');
  writeFileSync(
    cjsFile,
    `module.exports = {
  async up({ db }) {
    await db.collection('bench_cjs').insertOne({ created: true });
  },
  async down({ db }) {
    await db.collection('bench_cjs').deleteMany({});
  },
};
`,
    'utf8',
  );

  const esmFile = path.join(fixtureDir.dir, 'valid-esm.js');
  writeFileSync(
    esmFile,
    `export async function up({ db }) {
  await db.collection('bench_esm').insertOne({ created: true });
}

export async function down({ db }) {
  await db.collection('bench_esm').deleteMany({});
}
`,
    'utf8',
  );

  const tsFile = path.join(fixtureDir.dir, 'valid-ts.ts');
  writeFileSync(
    tsFile,
    `export async function up({ db }) {
  await db.collection('bench_ts').insertOne({ created: true });
}

export async function down({ db }) {
  await db.collection('bench_ts').deleteMany({});
}
`,
    'utf8',
  );

  return { cjsFile, esmFile, tsFile };
}

/** Seed a changelog collection with a realistic mix of applied/reverted records */
async function seedChangelogRecords(db, collectionName, count) {
  const executedBy = os.userInfo().username;
  const docs = [];
  for (let i = 0; i < count; i++) {
    const applied = i % 3 !== 0;
    docs.push({
      name: `20260101${String(i).padStart(6, '0')}_bench_migration_${i}.js`,
      batch: Math.floor(i / 20) + 1,
      status: applied ? 'applied' : 'reverted',
      appliedAt: new Date(),
      duration: 42,
      checksum: 'a'.repeat(64),
      environment: 'bench',
      executedBy,
      ...(applied ? {} : { revertedAt: new Date() }),
    });
  }
  await db.collection(collectionName).insertMany(docs);
}

/**
 * Seed a dedicated pool of `applied` records for the markReverted benchmark.
 * markReverted flips a record's state, so a single record can only be
 * reverted once — a large pre-applied pool lets the loop cycle through fresh
 * records instead of degenerating into no-op matches after the first hit.
 */
async function seedRevertPool(db, collectionName, count) {
  const executedBy = os.userInfo().username;
  const docs = [];
  for (let i = 0; i < count; i++) {
    docs.push({
      name: `bench-revert-${i}`,
      batch: 1,
      status: 'applied',
      appliedAt: new Date(),
      duration: 42,
      checksum: 'b'.repeat(64),
      environment: 'bench',
      executedBy,
    });
  }
  await db.collection(collectionName).insertMany(docs);
}

module.exports = {
  startBenchMongo,
  makeFixtureDir,
  writeChecksumFixture,
  writeLoaderFixtures,
  seedChangelogRecords,
  seedRevertPool,
};
