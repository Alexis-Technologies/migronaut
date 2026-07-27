import { pino } from 'pino';
import { expectAssignable, expectError, expectType } from 'tsd';
import {
  type AuditReport,
  ChecksumMismatchError,
  HookFailedError,
  type ImportResult,
  type LockInfo,
  LockLostError,
  type MigrationEvent,
  MigratorKit,
  MigronautError,
  type MigronautConfig,
  type MigronautErrorCode,
  type MigronautLogger,
  type ProgressReporter,
  RunAbortedError,
  type RunEndEvent,
  type RunResult,
  type RunStartEvent,
  type StatusRow,
  TransactionsUnsupportedError,
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
expectType<Promise<{ applied: RunResult[]; upToDate: boolean; waited: boolean }>>(
  runMigrations({ uri: 'mongodb://localhost:27017', dbName: 'test' }),
);
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
expectType<Promise<LockInfo | null>>(kit.lockInfo());
expectType<Promise<LockInfo | null>>(kit.forceUnlock());

// ─── Typed lifecycle events ──────────────────────────────────────────────────

kit.on('run:start', (event) => {
  expectType<RunStartEvent>(event);
});
kit.on('run:end', (event) => {
  expectType<RunEndEvent>(event);
  expectType<boolean>(event.success);
  expectType<number | undefined>(event.durationMs);
});
kit.on('migration:success', (event) => {
  expectType<MigrationEvent>(event);
  expectType<string>(event.migration);
});
kit.on('migration:skipped', (event) => {
  expectType<MigrationEvent>(event);
});
kit.once('lock:lost', (event) => {
  expectType<string | undefined>(event.reason);
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

expectType<Promise<{ applied: RunResult[]; upToDate: boolean; waited: boolean }>>(
  runMigrations({}, { onLockHeld: 'wait', lockWaitTimeoutMs: 90_000, lockPollIntervalMs: 250 }),
);
expectError(runMigrations({}, { onLockHeld: 'retry' }));

// ─── Error codes and construction options ────────────────────────────────────

expectAssignable<MigronautErrorCode>('TRANSACTIONS_UNSUPPORTED');
expectAssignable<MigronautError>(new TransactionsUnsupportedError('standalone'));
// The 4th constructor parameter carries the wrapped cause.
new MigronautError('CONFIG_INVALID', 'bad', { issues: [] }, { cause: new Error('inner') });
new ChecksumMismatchError('mismatch', { name: 'x' }, { cause: new Error('inner') });

// ─── StatusRow invalid marker ────────────────────────────────────────────────

declare const row: StatusRow;
expectType<true | undefined>(row.invalid);
