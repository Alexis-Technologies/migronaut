import type { Collection, Db, ObjectId } from 'mongodb';
import { expectAssignable, expectError, expectNotAssignable, expectType } from 'tsd';
import type { CollectionDefinitionFile, DeclarativeBackgroundMigration } from '../../index.js';
import {
  type AnyShape,
  type BackgroundMigrationFor,
  type Body,
  type CurrentShape,
  type CurrentVersion,
  type ShapeAt,
  type Stamped,
  defineShapes,
  isVersion,
} from '../../versioning.js';

// Bodies are declared without the version field.
interface OrderV1 {
  _id: ObjectId;
  address: string;
  total: number;
}
interface OrderV2 {
  _id: ObjectId;
  shipping: { address: string };
  total: number;
}
interface UserV1 {
  _id: string;
  name: string;
}

type Shapes = {
  orders: { 1: OrderV1; 2: OrderV2 };
  users: { 0: { _id: string }; 1: UserV1 };
};

// ─── The union and its discriminant ───────────────────────────────────────────
declare const anyOrder: AnyShape<Shapes, 'orders'>;
switch (anyOrder.__v) {
  case 1:
    expectType<string>(anyOrder.address);
    expectError(anyOrder.shipping);
    break;
  case 2:
    expectType<{ address: string }>(anyOrder.shipping);
    expectType<number>(anyOrder.__rev);
    break;
}

declare const anyUser: AnyShape<Shapes, 'users'>;
if (isVersion(anyUser, 0)) {
  // Version 0: the field is missing or null, the revision may be too.
  expectType<0 | null | undefined>(anyUser.__v);
  expectType<number | undefined>(anyUser.__rev);
  expectError(anyUser.name);
} else {
  expectType<string>(anyUser.name);
}
if (isVersion(anyOrder, 2)) expectType<{ address: string }>(anyOrder.shipping);

expectType<2>({} as CurrentVersion<Shapes, 'orders'>);
expectType<{ address: string }>(({} as CurrentShape<Shapes, 'orders'>).shipping);
expectType<1>(({} as ShapeAt<Shapes, 'orders', 1>).__v);

// Unsorted and string keys.
type Messy = { events: { '3': { c: 1 }; 1: { a: 1 }; '2': { b: 1 } } };
expectType<3>({} as CurrentVersion<Messy, 'events'>);
expectType<1>(({} as CurrentShape<Messy, 'events'>).c);
expectType<1>(({} as ShapeAt<Messy, 'events', 2>).b);

// A body that declares the version anyway has it replaced by the literal.
type Redundant = { things: { 1: { __v: number; x: string }; 2: { __v: number; y: string } } };
expectType<2>(({} as CurrentShape<Redundant, 'things'>).__v);

// ─── Body and custom field names ──────────────────────────────────────────────
type CustomNames = { field: 'schemaVersion'; revisionField: 'rev' };
expectType<{ a: number }>({} as Body<{ a: number; schemaVersion: 1; rev: 3 }, CustomNames>);
expectType<{ a: number } | { b: string }>(
  {} as Body<{ a: number; __v: 1 } | { b: string; __rev: 2 }>,
);
expectType<1>(({} as ShapeAt<Shapes, 'orders', 1, CustomNames>).schemaVersion);
expectType<number>(({} as ShapeAt<Shapes, 'orders', 1, CustomNames>).rev);
expectError(({} as ShapeAt<Shapes, 'orders', 1, CustomNames>).__v);
expectError(({} as ShapeAt<Shapes, 'orders', 1, { field: '__v'; revisionField: null }>).__rev);
expectType<number>(({} as Stamped<{ a: 1 }>).__v);

// ─── The typed registry ───────────────────────────────────────────────────────
const ordersFile = { versioning: { current: 2 } } as const satisfies CollectionDefinitionFile;
const usersFile = {
  versioning: { current: 1, min: 0, field: 'schemaVersion', revision: false },
  indexes: [{ key: { name: 1 } }],
} as const satisfies CollectionDefinitionFile;

const shapes = defineShapes<Shapes>()({ orders: ordersFile, users: usersFile });
expectType<2>(shapes.current('orders'));
expectType<1>(shapes.current('users'));
const stamped = shapes.stamp('orders', {
  _id: {} as ObjectId,
  shipping: { address: 'x' },
  total: 1,
});
expectType<2>(stamped.__v);
expectType<number>(stamped.__rev);
// Custom field names flow from the definition.
const user = shapes.stamp('users', { _id: 'u', name: 'n' });
expectType<1>(user.schemaVersion);
expectError(user.__rev);
expectError(shapes.stamp('orders', { _id: {} as ObjectId, address: 'old', total: 1 }));
if (shapes.isCurrent('orders', anyOrder)) expectType<{ address: string }>(anyOrder.shipping);
if (shapes.isVersion('orders', anyOrder, 1)) expectType<string>(anyOrder.address);
expectType<boolean>(shapes.isCurrent('orders', {}));

// A literal current must be the shape map's highest version; a wide number is accepted.
expectError(
  defineShapes<Shapes>()({ orders: { versioning: { current: 3 } } as const, users: usersFile }),
);
defineShapes<Shapes>()({ orders: { versioning: { current: 2 as number } }, users: usersFile });
// The definitions cover exactly the shape map's collections.
expectError(defineShapes<Shapes>()({ orders: ordersFile }));
expectError(defineShapes<Shapes>()({ orders: ordersFile, users: usersFile, extra: ordersFile }));

// ─── Typed upcasters ──────────────────────────────────────────────────────────
const orderShapes = shapes.upcaster('orders', {
  1: ({ address, ...doc }) => ({ ...doc, shipping: { address } }),
});
expectType<2>(orderShapes.current);
expectType<CurrentShape<Shapes, 'orders'>>(orderShapes.upcast(anyOrder));
expectType<(doc: ShapeAt<Shapes, 'orders', 1>) => ShapeAt<Shapes, 'orders', 2>>(
  orderShapes.step(1),
);
expectError(orderShapes.step(2));
// A missing step, or one that returns the wrong body, does not compile.
expectError(shapes.upcaster('orders', {}));
expectError(shapes.upcaster('orders', { 1: (doc) => ({ ...doc, total: 'x' }) }));
// `newer: 'keep'` widens what upcast may return.
const keeping = shapes.upcaster(
  'orders',
  { 1: ({ address, ...doc }) => ({ ...doc, shipping: { address } }) },
  { newer: 'keep' },
);
const kept = keeping.upcast(anyOrder);
expectAssignable<typeof kept>({ __v: 7 });
expectNotAssignable<ReturnType<typeof orderShapes.step<1>>>({ __v: 7 });
expectNotAssignable<CurrentShape<Shapes, 'orders'>>({ __v: 7 });
if ('shipping' in kept) expectType<2 | number>(kept.__v);

// step(1) is a background migration's migrate — in both typed forms.
const forShapes: BackgroundMigrationFor<Shapes, 'orders', 1, 2> = {
  collection: 'orders',
  from: 1,
  to: 2,
  migrate: orderShapes.step(1),
  revert: ({ shipping, ...doc }) => ({ ...doc, address: shipping.address }),
};
expectType<'orders'>(forShapes.collection);
const plain: DeclarativeBackgroundMigration<OrderV1, OrderV2> = {
  collection: 'orders',
  from: 1,
  to: 2,
  migrate: orderShapes.step(1),
  maxParallel: 4,
};
expectAssignable<DeclarativeBackgroundMigration>(plain);
expectError<BackgroundMigrationFor<Shapes, 'orders', 1, 2>>({
  collection: 'orders',
  from: 1,
  to: 2,
  migrate: (doc: ShapeAt<Shapes, 'orders', 1>) => ({ ...doc, total: 'x' }),
});

// ─── The driver narrows a collection typed with the union ─────────────────────
declare const db: Db;
const orders: Collection<AnyShape<Shapes, 'orders'>> =
  db.collection<AnyShape<Shapes, 'orders'>>('orders');
const found = await orders.findOne({});
if (found !== null && found.__v === 2) expectType<{ address: string }>(found.shipping);
await orders.insertOne(
  shapes.stamp('orders', { _id: {} as ObjectId, shipping: { address: 'a' }, total: 2 }),
);

// ─── A long history stays within the compile budget ───────────────────────────
type Long = {
  log: {
    1: { v1: true };
    2: { v2: true };
    3: { v3: true };
    4: { v4: true };
    5: { v5: true };
    6: { v6: true };
    7: { v7: true };
    8: { v8: true };
    9: { v9: true };
    10: { v10: true };
    11: { v11: true };
    12: { v12: true };
    13: { v13: true };
    14: { v14: true };
    15: { v15: true };
    16: { v16: true };
    17: { v17: true };
    18: { v18: true };
    19: { v19: true };
    20: { v20: true };
    21: { v21: true };
    22: { v22: true };
    23: { v23: true };
    24: { v24: true };
    25: { v25: true };
    26: { v26: true };
    27: { v27: true };
    28: { v28: true };
    29: { v29: true };
    30: { v30: true };
    31: { v31: true };
    32: { v32: true };
    33: { v33: true };
    34: { v34: true };
    35: { v35: true };
    36: { v36: true };
    37: { v37: true };
    38: { v38: true };
    39: { v39: true };
    40: { v40: true };
  };
};
expectType<40>({} as CurrentVersion<Long, 'log'>);
declare const anyLog: AnyShape<Long, 'log'>;
if (anyLog.__v === 17) expectType<true>(anyLog.v17);
