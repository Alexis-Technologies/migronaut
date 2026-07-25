import { pino } from 'pino';
import { expectAssignable, expectType } from 'tsd';
import {
  AlreadyAppliedError,
  ChecksumMismatchError,
  MigratorKit,
  MigronautError,
  type MigronautConfig,
  type MigronautLogger,
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
expectAssignable<MigronautError>(new AlreadyAppliedError('already applied'));
expectAssignable<MigronautError>(new ChecksumMismatchError('mismatch', { name: 'x' }));
