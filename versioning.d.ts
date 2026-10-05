/**
 * `@alexify/migronaut/versioning` — document versioning and optimistic
 * concurrency for an application's repository layer.
 *
 * Structural like the rest of migronaut's types: nothing here imports the
 * MongoDB driver or mongoose. A driver `Collection` (or a Mongoose model's
 * `collection`) satisfies {@link RevisionedCollectionLike} as it is.
 *
 * @experimental New in 2.3 — the shape may still change in a minor release
 * (named in the CHANGELOG).
 */

import type {
  Body,
  CollectionDefinition,
  CollectionDefinitionFile,
  CollectionVersioning,
  DeclarativeBackgroundMigration,
  DefaultShapeFieldNames,
  ShapeFieldNames,
} from './index.js';

export {
  ConfigInvalidError,
  MigronautError,
  RevisionConflictError,
  ShapeVersionError,
} from './index.js';

// ─── Documents and updates ────────────────────────────────────────────────────

/** A query filter, as the driver takes it */
export type FilterLike = Record<string, unknown>;

/** An operator update (`{ $set: … }`) or an aggregation pipeline */
export type UpdateLike = Record<string, unknown> | readonly Record<string, unknown>[];

/** A versioning block with every default filled in, as `defineShapes().get()` returns it */
export interface ResolvedVersioning {
  readonly current: number;
  readonly min: number;
  readonly field: string;
  readonly revision: boolean;
  /** `null` when `revision: false` */
  readonly revisionField: string | null;
  readonly index: boolean;
}

// ─── Optimistic concurrency ───────────────────────────────────────────────────

/** What a driver `updateOne` / `replaceOne` resolves to — the fields migronaut reads */
export interface RevisionWriteResultLike {
  acknowledged?: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedCount?: number;
  upsertedId?: unknown;
}

/**
 * The collection methods the revision helpers call. A driver `Collection`
 * satisfies it; so does anything else with the same methods.
 */
export interface RevisionedCollectionLike {
  readonly collectionName?: string;
  updateOne(filter: any, update: any, options?: any): Promise<RevisionWriteResultLike>;
  replaceOne(filter: any, replacement: any, options?: any): Promise<RevisionWriteResultLike>;
  findOneAndUpdate(filter: any, update: any, options: any): Promise<any>;
  findOne(filter: any, options?: any): Promise<unknown>;
}

/**
 * Options of a revision-guarded write. Everything not listed here goes to the
 * driver (`session`, `hint`, `collation`, `arrayFilters`, …). `upsert` is
 * refused: a miss would insert a second document instead of reporting the
 * conflict — and so is an unacknowledged write (`w: 0`).
 */
export interface RevisionWriteOptions {
  /** The version field. Default `'__v'` */
  field?: string;
  /** The revision field. Default `'__rev'` */
  revisionField?: string;
  /** Also set the version field to this (an upgrade written on the way) */
  version?: number;
  /**
   * On a miss, read the document once more to say why (`conflict` with the
   * revision found, or `not-found`). Default `true`; `false` reports `unknown`.
   */
  verify?: boolean;
  upsert?: false;
  session?: unknown;
  [driverOption: string]: unknown;
}

/** The driver's result plus the document's new revision */
export type RevisionWriteResult<R extends RevisionWriteResultLike = RevisionWriteResultLike> =
  R & { revision: number };

/**
 * `updateOne` that only lands if the document is still at `expectedRevision`
 * (the `__rev` the caller read — 0 for a document without one), bumping it.
 *
 * @throws {RevisionConflictError} when nothing matched — `context.reason` is
 *   `'conflict'` (with `actual`), `'not-found'` or `'unknown'`
 */
export function updateWithRevision(
  collection: RevisionedCollectionLike | Pick<RevisionedCollectionLike, 'updateOne' | 'findOne'>,
  filter: FilterLike,
  expectedRevision: number,
  update: UpdateLike,
  options?: RevisionWriteOptions,
): Promise<RevisionWriteResult>;

/**
 * `replaceOne` that only lands if the document is still at `expectedRevision`.
 * The replacement's revision field is overwritten with the next revision.
 *
 * @throws {RevisionConflictError} when nothing matched
 */
export function replaceWithRevision(
  collection: RevisionedCollectionLike | Pick<RevisionedCollectionLike, 'replaceOne' | 'findOne'>,
  filter: FilterLike,
  expectedRevision: number,
  replacement: Record<string, unknown>,
  options?: RevisionWriteOptions,
): Promise<RevisionWriteResult>;

/**
 * `findOneAndUpdate` that only lands if the document is still at
 * `expectedRevision`. Resolves to the document — after the update unless
 * `returnDocument: 'before'` — on every driver version alike.
 *
 * @throws {RevisionConflictError} when nothing matched
 */
export function findOneAndUpdateWithRevision<TDocument = Record<string, unknown>>(
  collection:
    | RevisionedCollectionLike
    | Pick<RevisionedCollectionLike, 'findOneAndUpdate' | 'findOne'>,
  filter: FilterLike,
  expectedRevision: number,
  update: UpdateLike,
  options?: RevisionWriteOptions & { returnDocument?: 'before' | 'after' },
): Promise<TDocument>;

/** Full-jitter backoff bounds for {@link retryOnConflict} */
export interface RetryBackoff {
  /** Default 10 */
  baseMs?: number;
  /** Default 1000 */
  maxMs?: number;
}

export interface RetryOnConflictOptions {
  /** Tries in all, the first included. Default 3 */
  attempts?: number;
  /** `{ baseMs, maxMs }`, or the wait (ms) before the next try after attempt n */
  backoff?: RetryBackoff | ((attempt: number) => number);
  /** Cuts a wait short (the promise rejects with the signal's reason) */
  signal?: AbortSignal;
}

/**
 * Run `fn` — read, decide, write with a revision guard — again after a
 * revision conflict. A `not-found` is never retried; any other error is
 * thrown at once.
 */
export function retryOnConflict<T>(
  fn: (attempt: number) => T | Promise<T>,
  options?: RetryOnConflictOptions,
): Promise<T>;

/**
 * `update` with the revision bumped — for a write that is not guarded but
 * must still move the revision (every write to a collection with revisions
 * must, or an optimistic filter cannot see it).
 */
export function bumpRevision<U extends UpdateLike>(
  update: U,
  options?: { revisionField?: string },
): U;

// ─── Shapes by version (type level) ───────────────────────────────────────────

/**
 * The document shapes of each collection by version, declared once:
 *
 *   type Shapes = { orders: { 1: OrderV1; 2: OrderV2 } };
 *
 * Bodies are declared **without** the version field — the literal
 * discriminant comes from the key, so the two can never disagree (a body that
 * declares it anyway has it replaced). Keys may be numbers or numeric strings.
 */
export type ShapeMap = { [collection: string]: { [version: number]: object } };

/** `'2'` → `2`; numbers stay */
type ToVersion<K> = K extends number ? K : K extends `${infer N extends number}` ? N : never;

/** A tuple `n` long — for comparing small version numbers */
type Tuple<N extends number, T extends unknown[] = []> = T['length'] extends N
  ? T
  : Tuple<N, [...T, unknown]>;

type GreaterThan<A extends number, B extends number> = number extends A | B
  ? false
  : Tuple<A> extends [...Tuple<B>, unknown, ...unknown[]]
    ? true
    : false;

type AnyGreater<Others extends number, P extends number> = Others extends number
  ? GreaterThan<Others, P>
  : never;

/** The largest of a union of version numbers */
type MaxOf<K extends number> = { [P in K]: true extends AnyGreater<Exclude<K, P>, P> ? never : P }[K];

/** `n + 1` */
export type NextVersion<N extends number> = Extract<[...Tuple<N>, unknown]['length'], number>;

/** The versions declared for a collection */
export type Versions<S extends ShapeMap, C extends keyof S> = ToVersion<keyof S[C]>;

/** The highest declared version — the current one */
export type CurrentVersion<S extends ShapeMap, C extends keyof S> = MaxOf<Versions<S, C>>;

/** The body declared for a version (by number or numeric-string key) */
type BodyAt<S extends ShapeMap, C extends keyof S, V extends number> = V extends keyof S[C]
  ? S[C][V]
  : `${V}` extends keyof S[C]
    ? S[C][`${V}` & keyof S[C]]
    : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * `T`, kept out of type-argument inference: a parameter typed with it is
 * contextually typed from the other arguments instead of inferring from them
 * (the built-in `NoInfer` needs TypeScript 5.4; this works from 5.0).
 */
type Hold<T> = [T][T extends unknown ? 0 : never];

/** The version field of a document at `V` — optional and `0 | null` for version 0 */
type VersionPart<V extends number, F extends string> = V extends 0
  ? { [K in F]?: 0 | null }
  : { [K in F]: V };

/** The revision field — optional at version 0 (a document that predates versioning) */
type RevisionPart<V extends number, R extends string | null> = R extends string
  ? V extends 0
    ? { [K in R]?: number }
    : { [K in R]: number }
  : unknown;

/** A body at version `V`, with its system fields */
export type VersionMember<
  V extends number,
  B,
  N extends ShapeFieldNames = DefaultShapeFieldNames,
> = B extends unknown
  ? Simplify<Body<B, N> & VersionPart<V, N['field']> & RevisionPart<V, N['revisionField']>>
  : never;

/** A stored document of `C` at version `V` */
export type ShapeAt<
  S extends ShapeMap,
  C extends keyof S,
  V extends number,
  N extends ShapeFieldNames = DefaultShapeFieldNames,
> = VersionMember<V, BodyAt<S, C, V>, N>;

/**
 * Any stored document of `C` — a union discriminated by the version field, so
 * `switch (doc.__v)` (or `isVersion`) narrows it. A driver collection typed
 * with it (`db.collection<AnyShape<Shapes, 'orders'>>('orders')`) narrows
 * after `find`/`findOne` too.
 */
export type AnyShape<
  S extends ShapeMap,
  C extends keyof S,
  N extends ShapeFieldNames = DefaultShapeFieldNames,
> = { [V in Versions<S, C>]: ShapeAt<S, C, V, N> }[Versions<S, C>];

/** A stored document of `C` at the current (highest) version */
export type CurrentShape<
  S extends ShapeMap,
  C extends keyof S,
  N extends ShapeFieldNames = DefaultShapeFieldNames,
> = ShapeAt<S, C, CurrentVersion<S, C>, N>;

/** `T` with system fields at version `V` — what `stamp` returns */
export type Stamped<
  T,
  V extends number = number,
  N extends ShapeFieldNames = DefaultShapeFieldNames,
> = VersionMember<V, T, N>;

/**
 * A declarative background migration of `C` from version `F` to `T`, typed by
 * the shape map: `migrate` takes the body at `F` and returns the body at `T`
 * (the engine owns the system fields); `revert` the other way. An upcaster's
 * `step(F)` fits as `migrate`.
 */
export type BackgroundMigrationFor<
  S extends ShapeMap,
  C extends keyof S & string,
  F extends Versions<S, C>,
  T extends Versions<S, C>,
  N extends ShapeFieldNames = DefaultShapeFieldNames,
> = DeclarativeBackgroundMigration<Body<BodyAt<S, C, F>, N>, Body<BodyAt<S, C, T>, N>> & {
  collection: C;
  from: F;
  to: T;
};

/**
 * Whether `doc` is at version `version` (a missing field is version 0) — a
 * type guard over a union of shapes.
 */
export function isVersion<D extends object, V extends number, F extends string = '__v'>(
  doc: D,
  version: V,
  options?: { field?: F },
): doc is Extract<D, VersionPart<V, F>>;

// ─── Upcasting ────────────────────────────────────────────────────────────────

/** One shape change: the document at version n in, the document at n + 1 out */
export type UpcastStep = (doc: any) => Record<string, unknown>;

/** `{ [fromVersion]: step }` — one step for every version from `min` to `current - 1` */
export type UpcastSteps = Record<number, UpcastStep>;

export interface UpcasterOptions {
  /**
   * What `upcast` does with a document newer than `current` (written by a
   * newer release): `'throw'` a {@link ShapeVersionError} (default) or
   * `'keep'` it as is.
   */
  newer?: 'throw' | 'keep';
}

/**
 * The shape changes of one collection, usable as the `migrate` of a
 * background migration (`step`) and — the exception — to lift a document in
 * memory on read (`upcast`).
 */
export interface Upcaster {
  readonly current: number;
  readonly min: number;
  readonly field: string;
  /**
   * The document in the current shape — a current one as is, an older one
   * lifted on a copy (the version field set by the helper).
   * @throws {ShapeVersionError} `'newer'`, `'below-min'` or `'invalid'`
   */
  upcast(doc: object): Record<string, unknown>;
  /** Whether `upcast` would change the document */
  needsUpcast(doc: object): boolean;
  /**
   * The steps from `from` to `to` (default `from + 1`) as one function — the
   * `migrate` of a background migration
   */
  step(from: number, to?: number): (doc: any) => Record<string, unknown>;
}

/**
 * An upcaster for a collection definition (`{ versioning }`) or a bare
 * versioning block.
 * @throws {ConfigInvalidError} when a step between `min` and `current` is
 *   missing, goes past `current`, is async or is not a function
 */
export function upcaster(
  definition: CollectionDefinitionFile | CollectionVersioning,
  steps: UpcastSteps,
  options?: UpcasterOptions,
): Upcaster;

// ─── The registry ─────────────────────────────────────────────────────────────

/** The fields `stamp` adds — the default names */
export interface VersionStamp {
  __v: number;
  __rev: number;
}

/** The application's view of its versioned collections */
export interface ShapeRegistry<Name extends string = string> {
  /** Every versioned collection, in declaration order */
  readonly names: readonly Name[];
  has(name: string): name is Name;
  /** The collection's versioning with every default filled in */
  get(name: Name): ResolvedVersioning;
  /** The version new documents are written at */
  current(name: Name): number;
  /**
   * A document's version — 0 when the field is missing.
   * @throws {ShapeVersionError} (`reason: 'invalid'`) when it is not a count
   */
  versionOf(name: Name, doc: object): number;
  /** Whether a document is at the current version */
  isCurrent(name: Name, doc: object): boolean;
  /** Whether a document is at `version` (a missing field is 0) */
  isVersion(name: Name, doc: object, version: number): boolean;
  /** The document with the current version and revision 0 — each only when missing */
  stamp<D extends object>(name: Name, doc: D): D & VersionStamp;
  /** An upcaster over the collection's versioning */
  upcaster(name: Name, steps: UpcastSteps, options?: UpcasterOptions): Upcaster;
  /** `stamp` for one document or each of an array — for `insertOne` / `insertMany` */
  onInsert<D extends object>(name: Name, docs: readonly D[]): (D & VersionStamp)[];
  onInsert<D extends object>(name: Name, docs: D): D & VersionStamp;
  /**
   * An upsert's operator update with `$setOnInsert` of the version (unless
   * the update sets it) and the revision bumped.
   */
  stampUpsert<U extends Record<string, unknown>>(name: Name, update: U): U;
}

// ─── The typed registry ───────────────────────────────────────────────────────

/** The definitions a shape map asks for — one versioned definition per collection */
export type ShapeDefinitions<S extends ShapeMap> = {
  [C in keyof S]: CollectionDefinitionFile & { versioning: CollectionVersioning };
};

type VersioningIn<D, C> = C extends keyof D
  ? D[C] extends { versioning: infer V }
    ? V
    : never
  : never;

/** The system field names a definition declares */
export type FieldNamesOf<D, C> = {
  field: VersioningIn<D, C> extends { field: infer F extends string } ? F : '__v';
  revisionField: VersioningIn<D, C> extends { revision: false }
    ? null
    : VersioningIn<D, C> extends { revisionField: infer R extends string }
      ? R
      : '__rev';
};

/**
 * A literal `current` must be the highest version of the shape map (the
 * error reads "Type '3' is not assignable to type '2'"); a widened `number`
 * cannot be checked and is accepted.
 */
type CurrentCheck<S extends ShapeMap, D> = {
  [C in keyof S]: {
    versioning: {
      current: number extends VersioningIn<D, C>['current' & keyof VersioningIn<D, C>]
        ? number
        : CurrentVersion<S, C>;
    };
  };
};

/** No collection the shape map does not know */
type NoExtraCollections<S extends ShapeMap, D> = { [K in Exclude<keyof D, keyof S>]: never };

/** The versions an upcaster needs a step from: every declared one but the current */
type StepVersions<S extends ShapeMap, C extends keyof S> = Exclude<
  Versions<S, C>,
  CurrentVersion<S, C>
>;

/** Steps typed by the shape map: the document at `v` in, the body at `v + 1` out */
export type UpcastStepsFor<
  S extends ShapeMap,
  C extends keyof S,
  N extends ShapeFieldNames = DefaultShapeFieldNames,
> = {
  [V in StepVersions<S, C>]: (doc: ShapeAt<S, C, V, N>) => Body<BodyAt<S, C, NextVersion<V>>, N>;
};

/** A document newer than any declared shape — what `newer: 'keep'` may hand back */
export type NewerShape<N extends ShapeFieldNames = DefaultShapeFieldNames> = {
  [K in N['field']]: number;
} & Record<string, unknown>;

/** An upcaster typed by the shape map */
export interface TypedUpcaster<
  S extends ShapeMap,
  C extends keyof S,
  N extends ShapeFieldNames = DefaultShapeFieldNames,
  Keep extends boolean = false,
> extends Upcaster {
  readonly current: CurrentVersion<S, C>;
  readonly field: N['field'];
  upcast(
    doc: AnyShape<S, C, N>,
  ): Keep extends true ? CurrentShape<S, C, N> | NewerShape<N> : CurrentShape<S, C, N>;
  upcast(doc: object): Record<string, unknown>;
  step<F extends StepVersions<S, C>>(
    from: F,
  ): (doc: ShapeAt<S, C, F, N>) => ShapeAt<S, C, NextVersion<F>, N>;
  step<F extends StepVersions<S, C>, T extends Versions<S, C>>(
    from: F,
    to: T,
  ): (doc: ShapeAt<S, C, F, N>) => ShapeAt<S, C, T, N>;
}

/** The registry typed by a shape map — what `defineShapes<Shapes>()(definitions)` returns */
export interface TypedShapeRegistry<S extends ShapeMap, D> extends Omit<
  ShapeRegistry<Extract<keyof S, string>>,
  'current' | 'stamp' | 'isCurrent' | 'isVersion' | 'upcaster'
> {
  current<C extends Extract<keyof S, string>>(name: C): CurrentVersion<S, C>;
  /** The body stamped at the current version */
  stamp<C extends Extract<keyof S, string>>(
    name: C,
    body: Body<BodyAt<S, C, CurrentVersion<S, C>>, FieldNamesOf<D, C>>,
  ): CurrentShape<S, C, FieldNamesOf<D, C>>;
  /** Whether the document is at the current version — a type guard */
  isCurrent<C extends Extract<keyof S, string>>(
    name: C,
    doc: AnyShape<S, C, FieldNamesOf<D, C>>,
  ): doc is CurrentShape<S, C, FieldNamesOf<D, C>>;
  isCurrent(name: Extract<keyof S, string>, doc: object): boolean;
  /** Whether the document is at `version` — a type guard */
  isVersion<C extends Extract<keyof S, string>, V extends Versions<S, C>>(
    name: C,
    doc: AnyShape<S, C, FieldNamesOf<D, C>>,
    version: V,
  ): doc is ShapeAt<S, C, V, FieldNamesOf<D, C>>;
  isVersion(name: Extract<keyof S, string>, doc: object, version: number): boolean;
  /** An upcaster whose steps the shape map types — a missing or wrong step does not compile */
  upcaster<C extends Extract<keyof S, string>>(
    name: C,
    steps: Hold<UpcastStepsFor<S, C, FieldNamesOf<D, C>>>,
    options: { newer: 'keep' },
  ): TypedUpcaster<S, C, FieldNamesOf<D, C>, true>;
  upcaster<C extends Extract<keyof S, string>>(
    name: C,
    steps: Hold<UpcastStepsFor<S, C, FieldNamesOf<D, C>>>,
    options?: { newer?: 'throw' },
  ): TypedUpcaster<S, C, FieldNamesOf<D, C>>;
}

/**
 * The registry typed by a shape map. Curried, so the shape map is given and
 * the definitions are inferred: `defineShapes<Shapes>()(definitions)`. The
 * definitions must cover exactly the shape map's collections, each with a
 * `current` that is its highest version (when literal — `as const`).
 */
export function defineShapes<S extends ShapeMap>(): <const D extends ShapeDefinitions<S>>(
  definitions: D & Hold<NoExtraCollections<S, D> & CurrentCheck<S, D>>,
) => TypedShapeRegistry<S, D>;
/**
 * The registry of the versioned collections among `definitions` — the same
 * definition files converge declares them with, as `{ name: definition }` or
 * a list of definitions with a `name` (unversioned ones are skipped).
 */
export function defineShapes<const D extends Record<string, CollectionDefinitionFile>>(
  definitions: D,
): ShapeRegistry<Extract<keyof D, string>>;
export function defineShapes(definitions: readonly CollectionDefinition[]): ShapeRegistry;

export type { Body, CollectionVersioning, DefaultShapeFieldNames, ShapeFieldNames };
