import { pino } from 'pino';
import { expectAssignable, expectError, expectType } from 'tsd';
import {
  type AuditReport,
  type BaselineSummary,
  ChecksumMismatchError,
  EXIT_CODES,
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
  OutOfOrderMigrationError,
  type ProgressReporter,
  RunAbortedError,
  type RunEndEvent,
  type RunResult,
  type RunStartEvent,
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
  }>
>(runMigrations({}, { onLockHeld: 'wait', lockWaitTimeoutMs: 90_000, lockPollIntervalMs: 250 }));
expectError(runMigrations({}, { onLockHeld: 'retry' }));
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
