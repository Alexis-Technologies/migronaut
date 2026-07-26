import { pino } from 'pino';
import { expectAssignable, expectType } from 'tsd';
import {
  ChecksumMismatchError,
  HookFailedError,
  LockLostError,
  MigratorKit,
  MigronautError,
  type MigronautConfig,
  type MigronautLogger,
  RunAbortedError,
  type RunResult,
  type StatusRow,
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
