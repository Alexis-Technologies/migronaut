// Order matters in this file: the driver instrumentation patches `mongodb` as
// it is loaded, so it has to be in place before anything below requires the
// driver — the test helpers included. That is the same constraint an
// application has, and the reason the guide says to load tracing first.
const { MongoDBInstrumentation } = require('@opentelemetry/instrumentation-mongodb');
const { parentIdOf, startTracing } = require('../helpers/otel.js');

const tracing = startTracing();
const instrumentation = new MongoDBInstrumentation();
instrumentation.setTracerProvider(tracing.provider);

const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
let project;
const DB = 'migronaut_telemetry_mongodb_test';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  instrumentation.disable();
  await tracing.stop();
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  project = makeProject();
  tracing.reset();
});

afterEach(() => {
  project?.cleanup();
});

const idOf = (span) => span.spanContext().spanId;
const driverSpans = () =>
  tracing.spans().filter((span) => span.instrumentationScope.name.includes('mongodb'));
/** The collection a driver span's command ran against, whichever convention named it */
const collectionOf = (span) =>
  span.attributes['db.collection.name'] ?? span.attributes['db.mongodb.collection'];

describe('telemetry with an instrumented MongoDB driver (integration)', () => {
  it('should emit no driver span when migronaut is not tracing', async () => {
    // The baseline this feature exists to change: the instrumentation only
    // records a command that has a parent span, and a migration run at
    // application startup has none.
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = makeMigrator(mongo.uri, DB, project.dir);
    await kit.up();
    await kit.disconnect();
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
    assert.deepStrictEqual(driverSpans(), []);
  });

  it("should nest the driver's command spans under the migration that issued them", async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('gadgets', 'b'));
    const kit = makeMigrator(mongo.uri, DB, project.dir, {
      telemetry: { tracer: tracing.tracer },
    });
    await kit.up();
    await kit.disconnect();

    const [run] = tracing.named('migronaut.run');
    const [first, second] = tracing.named('migronaut.migration');
    const commands = driverSpans();
    assert.ok(commands.length > 0, 'the instrumented driver recorded its commands');

    // The migration's own write, under the migration that made it.
    const commandsOn = (collection) => commands.filter((span) => collectionOf(span) === collection);
    assert.deepStrictEqual(
      commandsOn('things').map((span) => parentIdOf(span)),
      [idOf(first)],
    );
    assert.deepStrictEqual(
      commandsOn('gadgets').map((span) => parentIdOf(span)),
      [idOf(second)],
    );

    // The changelog write that records each migration is part of it too.
    const changelogParents = new Set(
      commandsOn('_migronaut_migrations').map((span) => parentIdOf(span)),
    );
    assert.ok(changelogParents.has(idOf(first)));
    assert.ok(changelogParents.has(idOf(second)));

    // Nothing is orphaned: every command belongs to the run or to a migration.
    const owners = new Set([idOf(run), idOf(first), idOf(second)]);
    for (const span of commands) {
      assert.ok(owners.has(parentIdOf(span)), `${span.name} has a migronaut parent`);
      assert.strictEqual(span.spanContext().traceId, run.spanContext().traceId);
    }
  });
});
