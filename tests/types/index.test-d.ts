import { expectAssignable, expectType } from 'tsd';
import {
  AlreadyAppliedError,
  ChecksumMismatchError,
  MigratorKit,
  MigronautError,
  type MigronautConfig,
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

// Error hierarchy
expectAssignable<MigronautError>(new AlreadyAppliedError('already applied'));
expectAssignable<MigronautError>(new ChecksumMismatchError('mismatch', { name: 'x' }));
