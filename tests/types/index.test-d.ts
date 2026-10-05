import {
  type Counter,
  type Histogram,
  type MetricOptions,
  type Span,
  type SpanOptions,
  metrics,
  trace,
} from '@opentelemetry/api';
import { pino } from 'pino';
import { expectAssignable, expectError, expectNotAssignable, expectType } from 'tsd';
import {
  type AuditReport,
  BackgroundConflictError,
  BackgroundFailedError,
  BackgroundPendingError,
  type BaselineSummary,
  type CollectionDefinition,
  type CollectionDefinitionFile,
  type ConvergeActionKind,
  ConvergeFailedError,
  type ConvergeResult,
  type ConvergeSearchSummary,
  ChecksumMismatchError,
  EXIT_CODES,
  HookFailedError,
  type IdGenerator,
  type ImportResult,
  type LockInfo,
  LockLostError,
  MigrationBlockedError,
  type MigrationEvent,
  MigratorKit,
  MigronautError,
  type MigronautConfig,
  type MigronautCounter,
  type MigronautErrorCode,
  type MigronautHistogram,
  type MigronautLogger,
  type MigronautMeter,
  type MigronautMetricOptions,
  type MigronautSpan,
  type MigronautTelemetry,
  type MigronautTracer,
  OutOfOrderMigrationError,
  type ProgressReporter,
  QueueJobFailedError,
  QueueJobInvalidError,
  RevisionConflictError,
  RunAbortedError,
  type RunEndEvent,
  type RunResult,
  type RunStartEvent,
  SandboxRefusedError,
  type SearchIndexBuild,
  type SearchIndexDefinition,
  type SearchIndexStatus,
  type SearchIndexType,
  ShapeVersionError,
  type StatusRow,
  TransactionsUnsupportedError,
  createLogger,
  pendingMigrations,
  runMigrations,
} from '../../index.js';

// MigratorKit is constructible with a partial config and returns typed results
const kit = new MigratorKit({ uri: 'mongodb://localhost:27017', dbName: 'test' });
expectType<Promise<void>>(kit.connect());
expectType<Promise<RunResult[]>>(kit.up());
expectType<Promise<RunResult[]>>(kit.down(undefined, { steps: 1 }));
expectType<Promise<StatusRow[]>>(kit.status());

// Programmatic entry points
expectType<
  Promise<{
    applied: RunResult[];
    upToDate: boolean;
    waited: boolean;
    waitedMs: number;
    attempts: number;
    converge?: ConvergeResult;
  }>
>(runMigrations({ uri: 'mongodb://localhost:27017', dbName: 'test' }));
expectType<Promise<StatusRow[]>>(
  pendingMigrations({ uri: 'mongodb://localhost:27017', dbName: 'test' }),
);

// Config shape
expectAssignable<Partial<MigronautConfig>>({ uri: 'mongodb://localhost:27017', dbName: 'test' });

// Logger: the four-method surface is pino-compatible — a real pino instance,
// a hand-rolled object, and null (silence) are all assignable
expectAssignable<MigronautLogger>(pino());
expectAssignable<MigronautLogger>({
  debug: (msg: string) => void msg,
  info: (msg: string) => void msg,
  warn: (msg: string) => void msg,
  error: (msg: string) => void msg,
});
expectAssignable<Partial<MigronautConfig>>({ logger: pino() });
expectAssignable<Partial<MigronautConfig>>({ logger: null });

// Error hierarchy
expectAssignable<MigronautError>(new ChecksumMismatchError('mismatch', { name: 'x' }));
expectAssignable<MigronautError>(new LockLostError('lock lost'));
expectAssignable<MigronautError>(new RunAbortedError('stopped'));
expectAssignable<MigronautError>(new HookFailedError('hook failed'));

// Stopping a run, and redo's options
expectType<void>(kit.stop());
expectType<Promise<RunResult[]>>(kit.redo(undefined, { noLock: true }));

// Resilience/audit config keys
expectAssignable<Partial<MigronautConfig>>({ onLockLost: 'warn', environment: 'staging' });

// Out-of-order policy is a closed union
expectAssignable<Partial<MigronautConfig>>({ onOutOfOrder: 'error' });
expectError<Partial<MigronautConfig>>({ onOutOfOrder: 'ignore' });
expectAssignable<MigronautError>(new OutOfOrderMigrationError('late arrival'));
expectAssignable<MigronautErrorCode>('MIGRATION_OUT_OF_ORDER');

// .env control: a path, or false to load nothing
expectAssignable<Partial<MigronautConfig>>({ envFile: '.env.ci' });
expectAssignable<Partial<MigronautConfig>>({ envFile: false });

// A logger may accept structured fields, and a plain one-arg logger still fits
expectAssignable<MigronautLogger>({
  debug: (msg: string, fields?: Record<string, unknown>) => void [msg, fields],
  info: (msg: string, fields?: Record<string, unknown>) => void [msg, fields],
  warn: (msg: string) => void msg,
  error: (msg: string) => void msg,
});

// Hooks receive direction/index info and afterAll receives the run summary
expectAssignable<Partial<MigronautConfig>>({
  hooks: {
    beforeEach: async (name, _ctx, info) => void `${name}:${info.direction}:${info.index}`,
    afterEach: async (name, duration, _ctx, info) => void `${name}:${duration}:${info.total}`,
    afterAll: async (_ctx, summary) => void `${summary.success}:${summary.applied}`,
  },
});

// ─── Targeting: --to, --step, dryRun options ─────────────────────────────────

expectType<Promise<RunResult[]>>(kit.up(undefined, { to: '0005-x.ts' }));
expectType<Promise<RunResult[]>>(kit.up(undefined, { step: true }));
expectType<Promise<RunResult[]>>(kit.down(undefined, { to: '0005-x.ts' }));
expectType<Promise<RunResult[]>>(kit.down(undefined, { batch: 3 }));
expectType<Promise<StatusRow[]>>(kit.dryRun('up', undefined, { to: '0005-x.ts' }));
expectType<Promise<StatusRow[]>>(kit.dryRun('down', undefined, { steps: 2, batch: 1 }));
// The direction is a closed union, not any string.
expectError(kit.dryRun('sideways'));

// ─── audit / list / create / init / import / lock surface ────────────────────

expectType<Promise<AuditReport>>(kit.audit());
expectType<Promise<StatusRow[]>>(kit.list());
expectType<Promise<StatusRow[]>>(kit.list('pending'));
expectError(kit.list('reverted'));
expectType<Promise<string>>(kit.create('add users index', { js: true }));
expectType<Promise<string>>(kit.init({ format: 'ts', secretProvider: true }));
expectError(kit.init({ format: 'yaml' }));
expectType<Promise<ImportResult>>(kit.import({ from: 'changelog', dryRun: true }));
expectType<Promise<BaselineSummary>>(kit.baseline({ to: '0002-b.ts' }));
expectType<Promise<BaselineSummary>>(kit.baseline());
expectType<Promise<LockInfo | null>>(kit.lockInfo());
expectType<Promise<LockInfo | null>>(kit.forceUnlock());
expectAssignable<MigronautTelemetry>({ attributes: { tenant: 'acme', shard: 2, canary: true } });
expectNotAssignable<MigronautTelemetry>({ attributes: { tenant: { id: 1 } } });
declare const holder: LockInfo;
expectType<string | undefined>(holder.runId);
expectType<number | undefined>(holder.ttlMs);

// ─── Typed lifecycle events ──────────────────────────────────────────────────

kit.on('run:start', (event) => {
  expectType<RunStartEvent>(event);
});
kit.on('run:end', (event) => {
  expectType<RunEndEvent>(event);
  expectType<boolean>(event.success);
  expectType<number | undefined>(event.durationMs);
  // Redacted string, never a raw Error — subscribers may ship it as-is.
  expectType<string | undefined>(event.error);
});
kit.on('migration:success', (event) => {
  expectType<MigrationEvent>(event);
  expectType<string>(event.migration);
});
kit.on('migration:skipped', (event) => {
  expectType<MigrationEvent>(event);
});
kit.on('migration:error', (event) => {
  expectType<string | undefined>(event.error);
});
kit.once('lock:lost', (event) => {
  expectType<string | undefined>(event.reason);
});
kit.once('lock:acquired', (event) => {
  expectType<number | undefined>(event.ttlMs);
  expectType<number | undefined>(event.acquireMs);
});
kit.on('lock:released', (event) => {
  expectType<true | undefined>(event.early);
});
// The event-name union is enforced — a typo'd event does not degrade to the
// untyped EventEmitter overload.
expectError(kit.on('migration:done', () => undefined));

// ─── Client injection and progress reporter ──────────────────────────────────

expectAssignable<Partial<MigronautConfig>>({
  client: {} as import('mongodb').MongoClient,
  dbName: 'test',
});
expectAssignable<ProgressReporter>({
  onStart: (name: string, direction: 'up' | 'down') => void `${name}:${direction}`,
  onStop: () => undefined,
});
new MigratorKit({}, { progress: { onStart: () => undefined, onStop: () => undefined } });

// ─── runMigrations options ───────────────────────────────────────────────────

expectType<
  Promise<{
    applied: RunResult[];
    upToDate: boolean;
    waited: boolean;
    waitedMs: number;
    attempts: number;
    converge?: ConvergeResult;
  }>
>(runMigrations({}, { onLockHeld: 'wait', lockWaitTimeoutMs: 90_000, lockPollIntervalMs: 250 }));
expectError(runMigrations({}, { onLockHeld: 'retry' }));
expectAssignable<Promise<{ waitedMs: number }>>(
  runMigrations({}, { onLockHeld: 'wait', signal: AbortSignal.timeout(1000) }),
);
expectError(runMigrations({}, { signal: 'stop' }));
// onKit hands out the internally-constructed kit for event subscriptions.
void runMigrations({}, { onKit: (k) => void expectType<MigratorKit>(k) });

// ─── cwd scoping and the exported logger factory ─────────────────────────────

new MigratorKit({}, { cwd: '/srv/app' });
expectType<MigronautLogger>(createLogger());
expectType<MigronautLogger>(createLogger(process.stdout, 'debug'));
expectError(createLogger(process.stdout, 'chatty'));

// ─── Error codes and construction options ────────────────────────────────────

expectAssignable<MigronautErrorCode>('TRANSACTIONS_UNSUPPORTED');
expectAssignable<MigronautError>(new TransactionsUnsupportedError('standalone'));
// The 4th constructor parameter carries the wrapped cause.
new MigronautError('CONFIG_INVALID', 'bad', { issues: [] }, { cause: new Error('inner') });
new ChecksumMismatchError('mismatch', { name: 'x' }, { cause: new Error('inner') });

// ─── StatusRow markers and audit-trail surface ───────────────────────────────

declare const row: StatusRow;
expectType<true | undefined>(row.invalid);
expectType<true | undefined>(row.outOfOrder);
expectType<'applied' | 'pending' | 'failed'>(row.status);
expectType<string | undefined>(row.executedBy);
expectType<string | undefined>(row.runId);
expectType<Date | undefined>(row.revertedAt);
expectType<Date | undefined>(row.failedAt);

// ─── EXIT_CODES map and CLI logger fallback ──────────────────────────────────

expectType<number>(EXIT_CODES.LOCK_ALREADY_HELD);
expectType<number>(EXIT_CODES.PENDING_MIGRATIONS);
expectType<number>(EXIT_CODES.AUDIT_FAILED);
// Only real error codes (plus the two CLI conditions) are keys.
expectError(EXIT_CODES.NOT_A_CODE);
new MigratorKit({}, { fallbackLogger: null });
new MigratorKit({}, { fallbackLogger: pino() });

// ─── Sequenced single-file runs (what the queue adapter is built on) ─────────

expectType<Promise<RunResult[]>>(kit.up('0003-c.ts', { batch: 7, ordered: true }));
expectType<Promise<RunResult[]>>(kit.down('0003-c.ts', { ordered: true }));
expectType<Promise<number>>(kit.nextBatch());
expectError(kit.up('0003-c.ts', { batch: 'seven' }));
expectType<Promise<RunResult[]>>(kit.up('0003-c.ts', { ordered: true, checksum: 'a'.repeat(64) }));
expectError(kit.up('0003-c.ts', { checksum: 42 }));
expectType<Promise<StatusRow[]>>(kit.list('applied', { checksums: false }));
expectType<Promise<StatusRow[]>>(kit.status({ checksums: false }));
expectError(kit.list('applied', { checksums: 'no' }));
declare const dryRow: StatusRow;
expectType<string | undefined>(dryRow.checksum);
expectError(kit.up('0003-c.ts', { ordered: 'yes' }));
expectAssignable<MigronautError>(
  new MigrationBlockedError('blocked', { name: 'x', direction: 'up', blockedBy: ['a'] }),
);
expectAssignable<MigronautError>(new QueueJobInvalidError('bad payload'));
expectAssignable<MigronautError>(new QueueJobFailedError('job failed'));
expectAssignable<MigronautErrorCode>('MIGRATION_BLOCKED');
expectAssignable<MigronautErrorCode>('QUEUE_JOB_INVALID');
expectAssignable<MigronautErrorCode>('QUEUE_JOB_FAILED');
expectType<number>(EXIT_CODES.MIGRATION_BLOCKED);
expectType<number>(EXIT_CODES.QUEUE_JOB_INVALID);
expectType<number>(EXIT_CODES.QUEUE_JOB_FAILED);

// ─── Custom id format ────────────────────────────────────────────────────────

// Third-party generators are assignable as they are: their optional first
// parameter (a size, a seed time) is never supplied, so it does not matter.
declare function nanoidLike(size?: number): string;
declare function ulidLike(seedTime?: number): string;
declare function cuidLike(): string;
expectAssignable<IdGenerator>(nanoidLike);
expectAssignable<IdGenerator>(ulidLike);
expectAssignable<IdGenerator>(cuidLike);
expectAssignable<Partial<MigronautConfig>>({ generateId: ulidLike });
expectAssignable<Partial<MigronautConfig>>({ generateId: () => `run_${Date.now()}` });
new MigratorKit({ generateId: cuidLike });
void runMigrations({ generateId: nanoidLike });
// It must be synchronous, a function, and return a string.
expectError<Partial<MigronautConfig>>({ generateId: async () => 'late' });
expectError<Partial<MigronautConfig>>({ generateId: 'ulid' });
expectError<Partial<MigronautConfig>>({ generateId: () => 42 });
// A generator that needs an argument cannot be called bare.
expectError<Partial<MigronautConfig>>({ generateId: (prefix: string) => prefix });
// The kit mints in the same format for code above it (the queue adapter's group ids).
expectType<Promise<string>>(kit.generateId());

// ─── Telemetry: the real OpenTelemetry API satisfies the structural types ────
// index.d.ts never imports @opentelemetry/api, so this is where that claim is
// checked against the real package (a devDependency). Each part is asserted on
// its own: `expectAssignable<MigronautTracer>(realTracer)` alone would pass
// even with a wrong span or options type — a real Tracer's two-argument
// overload matches almost anything.
declare const realSpan: Span;
declare const realHistogram: Histogram;
declare const realCounter: Counter;
const realTracer = trace.getTracer('@alexify/migronaut');
const realMeter = metrics.getMeter('@alexify/migronaut');

// What migronaut calls on a span exists on a real one …
expectAssignable<MigronautSpan>(realSpan);
// … what it passes when starting one is what a real tracer accepts …
declare const spanOptions: Parameters<MigronautTracer['startActiveSpan']>[1];
expectAssignable<SpanOptions>(spanOptions);
// … and the tracer as a whole fits.
expectAssignable<MigronautTracer>(realTracer);

expectAssignable<MigronautHistogram>(realHistogram);
expectAssignable<MigronautCounter>(realCounter);
declare const metricOptions: MigronautMetricOptions;
expectAssignable<MetricOptions>(metricOptions);
expectAssignable<MigronautMeter>(realMeter);

// Called the way the kit calls it, through the structural type: three
// arguments, the callback's result handed back.
const viaStructural: MigronautTracer = realTracer;
expectType<Promise<number>>(
  viaStructural.startActiveSpan(
    'migronaut.run',
    { attributes: { a: 1, b: 'x', c: true } },
    async (span) => {
      span.setAttribute('migronaut.run.applied', 2);
      span.setStatus({ code: 2, message: 'failed' });
      span.end();
      return 1;
    },
  ),
);
const viaStructuralMeter: MigronautMeter = realMeter;
viaStructuralMeter
  .createHistogram('migronaut.run.duration', {
    unit: 's',
    description: 'd',
    advice: { explicitBucketBoundaries: [0.1, 1] },
  })
  .record(1.5, { 'migronaut.run.command': 'up' });
viaStructuralMeter.createCounter('migronaut.lock.lost').add(1);

// Config: a tracer, a meter, both, or off.
expectAssignable<Partial<MigronautConfig>>({ telemetry: { tracer: realTracer, meter: realMeter } });
expectAssignable<Partial<MigronautConfig>>({ telemetry: { tracer: realTracer } });
expectAssignable<Partial<MigronautConfig>>({ telemetry: { meter: realMeter } });
expectAssignable<Partial<MigronautConfig>>({ telemetry: {} });
expectAssignable<Partial<MigronautConfig>>({ telemetry: null });
expectAssignable<MigronautTelemetry>({ tracer: null, meter: null });
new MigratorKit({ telemetry: { tracer: realTracer } });
void runMigrations({ telemetry: { tracer: realTracer, meter: realMeter } });
// A name is not a tracer, and neither is the API module's own shape.
expectError<Partial<MigronautConfig>>({ telemetry: 'otel' });
expectError<Partial<MigronautConfig>>({ telemetry: { trace, metrics } });
expectError<Partial<MigronautConfig>>({ telemetry: { tracer: {} } });
expectError<Partial<MigronautConfig>>({ telemetry: { tracer: realMeter } });
expectError<Partial<MigronautConfig>>({
  telemetry: { meter: { createHistogram: () => realHistogram } },
});

// ─── Declared collections (converge) ─────────────────────────────────────────

const users: CollectionDefinition = {
  name: 'users',
  indexes: [
    { key: { email: 1 }, unique: true },
    { key: { createdAt: 1 }, name: 'ttl', expireAfterSeconds: 3600 },
    {
      key: new Map<string, 1 | -1>([
        ['b', 1],
        ['a', -1],
      ]),
    },
    { key: { title: 'text', body: 'text' }, weights: { title: 5 } },
    { key: { name: 1 }, collation: { locale: 'en', strength: 2 } },
  ],
  validator: { $jsonSchema: { bsonType: 'object', required: ['email'] } },
  validationLevel: 'moderate',
  validationAction: 'warn',
  prune: true,
};
expectAssignable<Partial<MigronautConfig>>({
  collections: [users, { name: 'logs', validator: null }],
  collectionsDir: './collections',
  convergeAfterUp: true,
});
// A file's definition may leave the name to the file name.
expectAssignable<CollectionDefinitionFile>({ indexes: [{ key: { a: 1 } }] });
// A key direction is one of MongoDB's, an option one the driver knows.
expectError<CollectionDefinition>({ name: 'x', indexes: [{ key: { a: 'asc' } }] });
expectError<CollectionDefinition>({ name: 'x', indexes: [{ key: { a: 1 }, uniqe: true }] });
expectError<CollectionDefinition>({ name: 'x', validationLevel: 'loose' });

// Search indexes: a search definition has mappings, a vector one a list of fields.
const movies: CollectionDefinition = {
  name: 'movies',
  searchIndexes: [
    { definition: { mappings: { dynamic: true } } },
    {
      name: 'titles',
      type: 'search',
      definition: {
        analyzer: 'lucene.english',
        mappings: { dynamic: false, fields: { title: { type: 'string' } } },
        storedSource: { include: ['title'] },
      },
    },
    {
      name: 'plot_vectors',
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: 1536, similarity: 'cosine' },
          { type: 'filter', path: 'year' },
        ],
      },
    },
  ],
  prune: true,
};
expectAssignable<CollectionDefinitionFile>({
  searchIndexes: [{ type: 'vectorSearch', definition: { fields: [] } }],
});
expectAssignable<SearchIndexDefinition>(movies.searchIndexes![0]);
expectType<SearchIndexType | undefined>(movies.searchIndexes![0].type);
expectError<SearchIndexDefinition>({ type: 'vectorSearch', definition: { mappings: {} } });
expectError<SearchIndexDefinition>({ definition: { fields: [] } });
expectError<SearchIndexDefinition>({ type: 'atlas', definition: { mappings: {} } });
expectError<SearchIndexDefinition>({ name: 'x' });

expectType<Promise<ConvergeResult>>(kit.converge());
expectType<Promise<ConvergeResult>>(kit.converge({ dryRun: true, prune: true }));
expectType<Promise<ConvergeResult>>(kit.converge({ noLock: true, ordered: true }));
expectError(kit.converge({ sync: true }));
expectType<Promise<boolean>>(kit.convergesAfterUp());
expectType<Promise<RunResult[]>>(kit.up(undefined, { converge: false }));

declare const converged: ConvergeResult;
expectType<boolean>(converged.inSync);
expectType<number>(converged.changed);
const firstAction = converged.collections[0].actions[0];
expectType<'collection' | 'validator' | 'index' | 'searchIndex'>(firstAction.target);
expectType<'planned' | 'applied' | 'failed' | 'skipped'>(firstAction.status);
expectType<string | undefined>(firstAction.liveName);
expectAssignable<ConvergeActionKind>('skip');
expectType<SearchIndexBuild | undefined>(firstAction.build);
expectType<string[] | undefined>(firstAction.ignored);
expectType<SearchIndexStatus>(firstAction.build!.status);
expectType<ConvergeSearchSummary | undefined>(converged.search);
expectType<boolean>(converged.search!.available);
expectType<string>(converged.search!.notReady[0].collection);
expectType<'listed' | 'parameter' | 'error' | 'version' | 'assumed' | undefined>(
  converged.search!.evidence,
);
expectType<'ready' | 'failed' | 'timeout' | 'unreadable' | 'aborted' | undefined>(
  converged.search!.wait?.outcome,
);
expectAssignable<Partial<MigronautConfig>>({ onSearchUnavailable: 'skip' });
expectAssignable<Partial<MigronautConfig>>({
  waitForSearchIndexes: true,
  searchIndexWaitTimeoutMs: 120_000,
});
expectType<Promise<ConvergeResult>>(kit.converge({ waitForSearchIndexes: true }));
expectError(kit.converge({ waitForSearchIndexes: 'yes' }));
expectError<Partial<MigronautConfig>>({ onSearchUnavailable: 'ignore' });

kit.on('converge:start', (event) => {
  expectType<'converge' | 'up'>(event.trigger);
  expectType<number>(event.collections);
});
kit.on('converge:action', (event) => {
  expectType<'started' | 'applied' | 'failed'>(event.status);
});
kit.on('converge:end', (event) => {
  expectType<ConvergeResult>(event.result);
  expectType<boolean>(event.success);
});
kit.on('converge:wait', (event) => {
  expectType<'started' | 'progress' | 'ready' | 'failed' | 'timeout' | 'unreadable' | 'aborted'>(
    event.status,
  );
  expectType<number>(event.searchIndexes);
  expectType<boolean | undefined>(event.lockReleased);
  expectType<number | undefined>(event.waitedMs);
});

expectAssignable<MigronautErrorCode>('CONVERGE_FAILED');
expectType<MigronautError>(new ConvergeFailedError('refused', { phase: 'plan' }));
expectType<number>(EXIT_CODES.CONVERGE_FAILED);
expectType<number>(EXIT_CODES.COLLECTIONS_DRIFT);

// ─── Document versioning and background migration errors ─────────────────────
for (const code of [
  'REVISION_CONFLICT',
  'SHAPE_VERSION_UNSUPPORTED',
  'BACKGROUND_PENDING',
  'BACKGROUND_FAILED',
  'BACKGROUND_CONFLICT',
  'SANDBOX_REFUSED',
] as const) {
  expectAssignable<MigronautErrorCode>(code);
  expectType<number>(EXIT_CODES[code]);
}
expectType<MigronautError>(new RevisionConflictError('conflict', { reason: 'conflict' }));
expectType<MigronautError>(new ShapeVersionError('newer', { reason: 'newer' }));
expectType<MigronautError>(new BackgroundPendingError('pending', { waitsFor: [] }));
expectType<MigronautError>(new BackgroundFailedError('failed'));
expectType<MigronautError>(new BackgroundConflictError('conflict', { action: 'pause' }));
expectType<MigronautError>(new SandboxRefusedError('refused', { method: 'createIndex' }));
