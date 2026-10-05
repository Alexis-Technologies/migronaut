import type { Collection, Db } from 'mongodb';
import { Schema } from 'mongoose';
import { expectAssignable, expectError, expectType } from 'tsd';
import { RevisionConflictError as RootRevisionConflictError } from '../../index.js';
import {
  type RevisionWriteOptions,
  type RevisionWriteResult,
  type ShapeRegistry,
  type Upcaster,
  type VersionStamp,
  RevisionConflictError,
  ShapeVersionError,
  bumpRevision,
  defineShapes,
  findOneAndUpdateWithRevision,
  replaceWithRevision,
  retryOnConflict,
  updateWithRevision,
  upcaster,
  versioningPlugin,
} from '../../versioning.js';

declare const db: Db;
declare const orders: Collection<{ _id: number; status: string; __v: number; __rev: number }>;
declare const loose: Collection;

// ─── A driver Collection is a revisioned collection as it is ─────────────────
expectType<Promise<RevisionWriteResult>>(
  updateWithRevision(orders, { _id: 1 }, 0, { $set: { status: 'paid' } }),
);
expectType<Promise<RevisionWriteResult>>(
  updateWithRevision(loose, { _id: 1 }, 3, [{ $set: { a: 1 } }], { version: 2, verify: false }),
);
expectType<Promise<RevisionWriteResult>>(
  replaceWithRevision(db.collection('orders'), { _id: 1 }, 1, { status: 'x' }),
);
expectType<Promise<{ status: string }>>(
  findOneAndUpdateWithRevision<{ status: string }>(orders, { _id: 1 }, 1, { $set: {} }),
);
expectType<Promise<Record<string, unknown>>>(
  findOneAndUpdateWithRevision(orders, { _id: 1 }, 1, { $set: {} }, { returnDocument: 'before' }),
);
expectType<number>((await updateWithRevision(orders, {}, 0, {})).revision);
expectType<number>((await updateWithRevision(orders, {}, 0, {})).matchedCount);

// An upsert is refused at compile time too.
expectError(updateWithRevision(orders, {}, 0, {}, { upsert: true }));
expectAssignable<RevisionWriteOptions>({ session: {}, hint: 'x', revisionField: 'rev' });

// ─── Retrying ─────────────────────────────────────────────────────────────────
expectType<Promise<number>>(retryOnConflict(async () => 1));
expectType<Promise<string>>(retryOnConflict((attempt: number) => `${attempt}`, { attempts: 5 }));
expectType<Promise<boolean>>(
  retryOnConflict(async () => true, { backoff: { baseMs: 5, maxMs: 100 } }),
);
expectType<Promise<boolean>>(retryOnConflict(async () => true, { backoff: (n) => n * 10 }));
expectError(retryOnConflict(async () => 1, { attempts: '3' }));

expectType<{ $set: { a: number } }>(bumpRevision({ $set: { a: 1 } }));

// ─── The registry ─────────────────────────────────────────────────────────────
const shapes = defineShapes({
  orders: { versioning: { current: 2 } },
  users: { versioning: { current: 1, revision: false } },
});
expectType<ShapeRegistry<'orders' | 'users'>>(shapes);
expectType<number>(shapes.current('orders'));
expectError(shapes.current('nope'));
expectType<{ total: number } & VersionStamp>(shapes.stamp('orders', { total: 1 }));
expectType<({ total: number } & VersionStamp)[]>(shapes.onInsert('orders', [{ total: 1 }]));
expectType<string | null>(shapes.get('users').revisionField);
const fromList = defineShapes([{ name: 'orders', versioning: { current: 1 } }]);
expectType<ShapeRegistry>(fromList);

// ─── Errors are the package root's classes ────────────────────────────────────
expectType<typeof RootRevisionConflictError>(RevisionConflictError);
expectAssignable<Error>(new ShapeVersionError('newer', { reason: 'newer' }));

// ─── Upcasting ────────────────────────────────────────────────────────────────
const lift = upcaster({ versioning: { current: 2 } }, { 1: (doc) => ({ ...doc, b: 1 }) });
expectType<Upcaster>(lift);
expectType<Record<string, unknown>>(lift.upcast({ __v: 1 }));
expectType<(doc: any) => Record<string, unknown>>(lift.step(1));
expectType<Upcaster>(upcaster({ current: 1, min: 0 }, { 0: (doc) => doc }, { newer: 'keep' }));
expectError(upcaster({ current: 2 }, { 1: (doc: object) => doc }, { newer: 'drop' }));
expectType<Upcaster>(shapes.upcaster('orders', { 1: (doc) => doc }));

// ─── Mongoose ─────────────────────────────────────────────────────────────────
const schema = new Schema({ name: String });
schema.plugin(versioningPlugin, { versioning: { current: 2 } });
expectType<void>(versioningPlugin(schema, { current: 1, revision: false }));
schema.plugin(shapes.plugin('orders'));
expectError(versioningPlugin({}, { current: 1 }));
