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
  CollectionDefinition,
  CollectionDefinitionFile,
  CollectionVersioning,
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
  /** The document with the current version and revision 0 — each only when missing */
  stamp<D extends object>(name: Name, doc: D): D & VersionStamp;
  /** `stamp` for one document or each of an array — for `insertOne` / `insertMany` */
  onInsert<D extends object>(name: Name, docs: readonly D[]): (D & VersionStamp)[];
  onInsert<D extends object>(name: Name, docs: D): D & VersionStamp;
  /**
   * An upsert's operator update with `$setOnInsert` of the version (unless
   * the update sets it) and the revision bumped.
   */
  stampUpsert<U extends Record<string, unknown>>(name: Name, update: U): U;
}

/**
 * The registry of the versioned collections among `definitions` — the same
 * definition files converge declares them with, as `{ name: definition }` or
 * a list of definitions with a `name` (unversioned ones are skipped).
 */
export function defineShapes<const D extends Record<string, CollectionDefinitionFile>>(
  definitions: D,
): ShapeRegistry<Extract<keyof D, string>>;
export function defineShapes(definitions: readonly CollectionDefinition[]): ShapeRegistry;

export type { CollectionVersioning };
