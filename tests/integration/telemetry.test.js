const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { trace } = require('@opentelemetry/api');
const { LOCK_ID, MigrationLock } = require('../../src/core/lock.js');
const {
  LockAlreadyHeldError,
  LockLostError,
  MigrationExecutionFailedError,
} = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { parentIdOf, startMetrics, startTracing } = require('../helpers/otel.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
let tracing;
const DB = 'migronaut_telemetry_test';
const LOCK_COLLECTION = '_migronaut_locks';

before(async () => {
  mongo = await startTestMongo(DB);
  tracing = startTracing();
});

after(async () => {
  delete globalThis.__migronautProbe;
  await tracing.stop();
  await mongo.stop();
});

let project;
let metrics;

beforeEach(async () => {
  await mongo.db.dropDatabase();
  project = makeProject();
  metrics = startMetrics();
  tracing.reset();
  // What a migration body calls to prove which span is active around it. A
  // migration file lives in a temp project that cannot resolve this repo's
  // node_modules, so the probe reaches it through a global instead.
  globalThis.__migronautProbe = (label) => {
    tracing.tracer.startSpan(`probe ${label}`).end();
    return trace.getActiveSpan()?.spanContext().spanId;
  };
});

afterEach(async () => {
  await metrics.stop();
  project?.cleanup();
});

/** A migration that inserts a marker and reports the active span from inside its body */
function probedMigration(value) {
  return `export async function up({ db }) {
  globalThis.__migronautProbe('${value}');
  await db.collection('things').insertOne({ marker: '${value}' });
}
export async function down({ db }) {
  globalThis.__migronautProbe('${value}');
  await db.collection('things').deleteMany({ marker: '${value}' });
}
`;
}

/** A migration whose up() fails with a message that echoes a credentialed URI */
function leakyFailure() {
  return `export async function up() {
  throw new Error('cannot reach mongodb://app:hunter2@db.internal/app');
}
export async function down() {}
`;
}

function migrator(overrides = {}, kitOptions = {}) {
  return makeMigrator(
    mongo.uri,
    DB,
    project.dir,
    { telemetry: { tracer: tracing.tracer, meter: metrics.meter }, ...overrides },
    kitOptions,
  );
}

const idOf = (span) => span.spanContext().spanId;
const runSpans = () => tracing.named('migronaut.run');
const migrationSpans = () => tracing.named('migronaut.migration');

describe('telemetry — spans (integration)', () => {
  it('should emit one run span with a child span per migration', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    project.write('0002-b.ts', probedMigration('b'));
    const kit = migrator();
    const runIds = [];
    kit.on('run:start', (event) => runIds.push(event.runId));
    await kit.up();
    await kit.disconnect();

    const [run] = runSpans();
    const migrations = migrationSpans();
    assert.strictEqual(runSpans().length, 1);
    assert.strictEqual(migrations.length, 2);
    assert.strictEqual(parentIdOf(run), undefined, 'nothing was active around the run');
    for (const span of migrations) {
      assert.strictEqual(parentIdOf(span), idOf(run));
      assert.strictEqual(span.spanContext().traceId, run.spanContext().traceId);
    }

    const { 'migronaut.lock.acquire_ms': acquireMs, ...runAttributes } = run.attributes;
    assert.strictEqual(typeof acquireMs, 'number');
    assert.deepStrictEqual(runAttributes, {
      'migronaut.run.id': runIds[0],
      'migronaut.run.command': 'up',
      'migronaut.run.direction': 'up',
      'migronaut.run.applied': 2,
      'migronaut.run.reverted': 0,
      'migronaut.run.skipped': 0,
      'migronaut.run.total': 2,
    });
    assert.deepStrictEqual(migrations[0].attributes, {
      'migronaut.migration.name': '0001-a.ts',
      'migronaut.migration.direction': 'up',
      'migronaut.migration.batch': 1,
      'migronaut.migration.index': 0,
      'migronaut.migration.total': 2,
      'migronaut.migration.transaction': false,
      'migronaut.run.id': runIds[0],
    });
    assert.strictEqual(migrations[1].attributes['migronaut.migration.name'], '0002-b.ts');
    assert.strictEqual(migrations[1].attributes['migronaut.migration.index'], 1);
    // UNSET: a success is the application's to call OK, not a library's.
    assert.strictEqual(run.status.code, 0);
    assert.strictEqual(migrations[0].status.code, 0);
  });

  it('should stamp the run id the changelog records carry', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator();
    await kit.up();
    await kit.disconnect();
    const record = await mongo.db.collection('_migronaut_migrations').findOne({});
    assert.strictEqual(runSpans()[0].attributes['migronaut.run.id'], record.runId);
  });

  it('should make the migration span the active one inside the migration body', async () => {
    // The whole point of tracing from inside the kit: whatever the body does —
    // and an instrumented driver underneath it — parents to this migration.
    project.write('0001-a.ts', probedMigration('a'));
    project.write('0002-b.ts', probedMigration('b'));
    const active = [];
    const probe = globalThis.__migronautProbe;
    globalThis.__migronautProbe = (label) => active.push(probe(label));
    const kit = migrator();
    await kit.up();
    await kit.disconnect();

    const migrations = migrationSpans();
    assert.deepStrictEqual(active, [idOf(migrations[0]), idOf(migrations[1])]);
    assert.strictEqual(parentIdOf(tracing.named('probe a')[0]), idOf(migrations[0]));
    assert.strictEqual(parentIdOf(tracing.named('probe b')[0]), idOf(migrations[1]));
  });

  it('should keep the span active through a transaction', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator({ useTransaction: true });
    await kit.up();
    await kit.disconnect();
    const [migration] = migrationSpans();
    assert.strictEqual(migration.attributes['migronaut.migration.transaction'], true);
    assert.strictEqual(parentIdOf(tracing.named('probe a')[0]), idOf(migration));
  });

  it('should hang the run under whatever span is active around the call', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator();
    await tracing.tracer.startActiveSpan('app startup', async (span) => {
      await kit.up();
      span.end();
    });
    await kit.disconnect();
    const [startup] = tracing.named('app startup');
    assert.strictEqual(parentIdOf(runSpans()[0]), idOf(startup));
  });

  it('should fail the migration span and the run span, with a redacted reason', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    project.write('0002-b.ts', leakyFailure());
    const kit = migrator();
    await assert.rejects(kit.up(), MigrationExecutionFailedError);
    await kit.disconnect();

    const [first, second] = migrationSpans();
    assert.strictEqual(first.status.code, 0);
    assert.strictEqual(second.status.code, 2);
    assert.strictEqual(
      second.status.message,
      'Migration up failed: 0002-b.ts — cannot reach mongodb://app:****@db.internal/app',
    );
    assert.strictEqual(second.attributes['error.type'], 'MIGRATION_EXECUTION_FAILED');

    const [run] = runSpans();
    assert.strictEqual(run.status.code, 2);
    assert.strictEqual(run.attributes['error.type'], 'MIGRATION_EXECUTION_FAILED');
    // How far it got is exactly what a failed run's span is read for.
    assert.strictEqual(run.attributes['migronaut.run.applied'], 1);
    assert.strictEqual(run.attributes['migronaut.run.total'], 2);

    for (const span of tracing.spans()) {
      assert.ok(!JSON.stringify([span.status, span.attributes]).includes('hunter2'));
      assert.deepStrictEqual(span.events, [], 'no exception event — it would carry the raw stack');
    }
  });

  it('should emit no span at all for a run that never got the lock', async () => {
    // A caller polling for a busy lock retries the whole run every few hundred
    // milliseconds: a span per refusal would bury the run that did the work.
    project.write('0001-a.ts', probedMigration('a'));
    const holder = new MigrationLock(mongo.db, LOCK_COLLECTION, 60);
    await holder.acquire('another-process');
    const kit = migrator();
    await assert.rejects(kit.up(), LockAlreadyHeldError);
    await assert.rejects(kit.up(), LockAlreadyHeldError);
    await kit.disconnect();
    await holder.release();

    assert.deepStrictEqual(tracing.spans(), []);
    const data = await metrics.collect();
    assert.strictEqual(data['migronaut.lock.refused'][0].value, 2);
    assert.strictEqual(data['migronaut.run.duration'], undefined, 'no run to time');
  });

  it('should mark a run that skipped the lock', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator();
    await kit.up(undefined, { noLock: true });
    await kit.disconnect();
    const [run] = runSpans();
    assert.strictEqual(run.attributes['migronaut.lock.skipped'], true);
    assert.ok(!('migronaut.lock.acquire_ms' in run.attributes));
    assert.strictEqual(migrationSpans().length, 1);
  });

  it('should count a skipped migration on the run, without a span of its own', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator();
    await kit.up();
    tracing.reset();
    await kit.up('0001-a.ts');
    await kit.disconnect();

    assert.strictEqual(migrationSpans().length, 0);
    const [run] = runSpans();
    assert.strictEqual(run.attributes['migronaut.run.skipped'], 1);
    assert.strictEqual(run.attributes['migronaut.run.applied'], 0);
    assert.strictEqual(run.attributes['migronaut.run.total'], 1);
  });

  it('should trace a rollback as a down migration', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator();
    await kit.up();
    tracing.reset();
    await kit.down();
    await kit.disconnect();

    const [run] = runSpans();
    const [migration] = migrationSpans();
    assert.strictEqual(run.attributes['migronaut.run.command'], 'down');
    assert.strictEqual(run.attributes['migronaut.run.reverted'], 1);
    assert.strictEqual(migration.attributes['migronaut.migration.direction'], 'down');
    assert.ok(!('migronaut.migration.batch' in migration.attributes));
    assert.strictEqual(parentIdOf(tracing.named('probe a')[0]), idOf(migration));
  });

  it('should trace redo as one run holding both directions', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator();
    await kit.up();
    tracing.reset();
    await kit.redo();
    await kit.disconnect();

    assert.strictEqual(runSpans().length, 1);
    const [run] = runSpans();
    assert.strictEqual(run.attributes['migronaut.run.command'], 'redo');
    // redo has no single direction — the attribute is absent, not undefined.
    assert.ok(!('migronaut.run.direction' in run.attributes));
    assert.deepStrictEqual(
      migrationSpans().map((span) => span.attributes['migronaut.migration.direction']),
      ['down', 'up'],
    );
    for (const span of migrationSpans()) assert.strictEqual(parentIdOf(span), idOf(run));
  });

  it('should trace baseline as a run with no migration spans', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator();
    await kit.baseline();
    await kit.disconnect();
    assert.strictEqual(runSpans().length, 1);
    assert.strictEqual(runSpans()[0].attributes['migronaut.run.command'], 'baseline');
    assert.ok(!('migronaut.run.total' in runSpans()[0].attributes), 'baseline returns no rows');
    assert.strictEqual(migrationSpans().length, 0);
  });

  it('should emit nothing for commands that are not runs', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator();
    await kit.status();
    await kit.dryRun('up');
    await kit.list('pending');
    await kit.audit();
    await kit.disconnect();
    assert.deepStrictEqual(tracing.spans(), []);
    assert.deepStrictEqual(await metrics.collect(), {});
  });

  it('should record why the lock was lost on the run span', async () => {
    // A 2s TTL puts the heartbeat at 1s: one renewal lands inside the first
    // migration and finds the lock taken over.
    project.write(
      '0001-a.ts',
      `export async function up() {
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
export async function down() {}
`,
    );
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const progress = {
      onStart: (name) => {
        if (name !== '0001-a.ts') return;
        // The body is running, so acquire() has already confirmed ownership.
        stolen = mongo.db
          .collection(LOCK_COLLECTION)
          .updateOne({ _id: LOCK_ID }, { $set: { owner: 'someone-else' } });
      },
      onStop: () => undefined,
    };
    let stolen;
    const kit = migrator({ lockTTLSeconds: 2 }, { progress });
    await assert.rejects(kit.up(), LockLostError);
    assert.strictEqual((await stolen).matchedCount, 1);
    await kit.disconnect();

    const [run] = runSpans();
    assert.strictEqual(run.attributes['migronaut.lock.lost_reason'], 'another run reclaimed it');
    assert.strictEqual(run.attributes['error.type'], 'LOCK_LOST');
    assert.strictEqual(run.status.code, 2);
    assert.strictEqual(migrationSpans().length, 1, 'the second migration never started');
    assert.strictEqual((await metrics.collect())['migronaut.lock.lost'][0].value, 1);
  });
});

describe('telemetry — metrics (integration)', () => {
  it('should time the run, each migration and the lock acquisition, in seconds', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    project.write('0002-b.ts', probedMigration('b'));
    const kit = migrator();
    const ended = [];
    kit.on('run:end', (event) => ended.push(event));
    await kit.up();
    await kit.disconnect();

    const data = await metrics.collect();
    assert.deepStrictEqual(Object.keys(data).sort(), [
      'migronaut.lock.acquire.duration',
      'migronaut.migration.duration',
      'migronaut.run.duration',
    ]);
    const [run] = data['migronaut.run.duration'];
    assert.strictEqual(run.value.count, 1);
    // The same wall-clock figure `run:end` reports, in the unit OpenTelemetry asks for.
    assert.strictEqual(run.value.sum, ended[0].durationMs / 1000);
    assert.deepStrictEqual(run.attributes, {
      'migronaut.run.command': 'up',
      'migronaut.run.direction': 'up',
    });
    const [migration] = data['migronaut.migration.duration'];
    assert.strictEqual(migration.value.count, 2);
    assert.deepStrictEqual(migration.attributes, { 'migronaut.migration.direction': 'up' });
    assert.strictEqual(data['migronaut.lock.acquire.duration'][0].value.count, 1);
  });

  it('should split failures out by error type', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    project.write('0002-b.ts', leakyFailure());
    const kit = migrator();
    await assert.rejects(kit.up());
    await kit.disconnect();

    const data = await metrics.collect();
    const byType = (points) =>
      Object.fromEntries(
        points.map((point) => [point.attributes['error.type'] ?? 'ok', point.value.count]),
      );
    assert.deepStrictEqual(byType(data['migronaut.migration.duration']), {
      ok: 1,
      MIGRATION_EXECUTION_FAILED: 1,
    });
    assert.deepStrictEqual(byType(data['migronaut.run.duration']), {
      MIGRATION_EXECUTION_FAILED: 1,
    });
  });

  it('should time a migration that fails before its body runs', async () => {
    // No duration from the runner here — the kit's own measurement stands in.
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator({
      hooks: {
        beforeEach: () => {
          throw new Error('not today');
        },
      },
    });
    await assert.rejects(kit.up());
    await kit.disconnect();
    const [point] = (await metrics.collect())['migronaut.migration.duration'];
    assert.strictEqual(point.attributes['error.type'], 'HOOK_FAILED');
    assert.strictEqual(point.value.count, 1);
    assert.ok(point.value.sum >= 0);
    assert.strictEqual(migrationSpans()[0].attributes['error.type'], 'HOOK_FAILED');
  });

  it('should work with a meter and no tracer, and the other way round', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const metered = migrator({ telemetry: { meter: metrics.meter } });
    await metered.up();
    await metered.disconnect();
    assert.deepStrictEqual(tracing.named('migronaut.run'), []);
    assert.strictEqual((await metrics.collect())['migronaut.run.duration'][0].value.count, 1);

    project.write('0002-b.ts', probedMigration('b'));
    const traced = migrator({ telemetry: { tracer: tracing.tracer } });
    await traced.up();
    await traced.disconnect();
    assert.strictEqual(runSpans().length, 1);
    assert.strictEqual((await metrics.collect())['migronaut.run.duration'][0].value.count, 1);
  });
});

describe('telemetry — never in the way (integration)', () => {
  it('should apply everything when the tracer and the meter both throw', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const broken = () => {
      throw new Error('telemetry backend is down');
    };
    const kit = migrator({
      telemetry: {
        tracer: { startActiveSpan: broken },
        meter: { createHistogram: broken, createCounter: broken },
      },
    });
    const results = await kit.up();
    await kit.disconnect();
    assert.deepStrictEqual(
      results.map((row) => row.status),
      ['applied', 'applied'],
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 2);
  });

  it('should apply everything when every span and instrument call throws', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const broken = () => {
      throw new Error('span is broken');
    };
    const span = { setAttribute: broken, setStatus: broken, end: broken };
    const instrument = { record: broken, add: broken };
    const kit = migrator({
      telemetry: {
        tracer: { startActiveSpan: (_name, _options, fn) => fn(span) },
        meter: { createHistogram: () => instrument, createCounter: () => instrument },
      },
    });
    assert.strictEqual((await kit.up()).length, 1);
    await kit.disconnect();
  });

  it('should behave exactly as before with telemetry off', async () => {
    project.write('0001-a.ts', probedMigration('a'));
    const kit = migrator({ telemetry: null });
    assert.strictEqual((await kit.up()).length, 1);
    await kit.disconnect();
    assert.deepStrictEqual(tracing.named('migronaut.run'), []);
    assert.deepStrictEqual(await metrics.collect(), {});
  });
});
