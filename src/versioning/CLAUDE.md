# src/versioning — the runtime (`@alexify/migronaut/versioning`)

Small helpers for an application's repository layer: the shape version (`__v`), the
optimistic-concurrency revision (`__rev`), `defineShapes`, `upcaster`, `retryOnConflict` and the
Mongoose plugin. `document.js` is the contract the engine and the runtime share — the filters,
the stamped updates, the field checks — so a background migration and an application's write
agree on what a version is.

## It stands alone

- It requires nothing outside `src/versioning/` and `src/errors/` (a test pins it): no core, no
  `mongodb`, no `mongoose`. The core may require it; it never requires the core. A helper the core
  has too is a copy here where isolation asks for one, with a comment saying so.
- The Mongoose plugin works on the schema it is given; nothing under `src/` may
  `require('mongoose')`, and `versioning.d.ts` describes the driver and Mongoose structurally.
- `versioning.d.ts` may use TypeScript 5.0 (`const` type parameters); the other two stay within 4.8.
  A typed `current` past the highest shape, written inline, errors as "not assignable to type
  'never'" (from an imported `as const` definition it names the two numbers) — that is the type
  doing its job.

## Kept on purpose here

- Three of the four function expressions of `src/` are in `mongoose.js`: `stamp`, `guardLegacy`
  and `bumpRevision`. Mongoose middleware reads its document or query from `this`.
- `delete` on a MongoDB query filter and an update document (`mongoose.js`): an absent key is no
  constraint, and an empty `$setOnInsert` must be absent.
- The long-lived map of field patterns (`internal.js`) is bounded by the number of fields a schema
  declares, not by traffic.
