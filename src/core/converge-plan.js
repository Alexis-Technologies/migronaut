const { deepEqual } = require('../utils/canonical.js');
const { compareIndex, normalizeLiveIndex, restoreSpec, sameSignature } = require('./index-spec.js');

/**
 * The converge planner: one declared collection against its live state, as
 * result rows (what will happen and why) and executable steps (how). Pure, so
 * the whole decision table is unit-tested without a database; converge.js
 * only reads the live state in and carries the steps out.
 *
 * The rules, in short:
 * - declared indexes pair with live ones by name, then compare: unchanged, a
 *   `collMod` (TTL, hidden), or a rebuild;
 * - an index the server would refuse because an undeclared one already
 *   covers the same key under another name is never resolved by dropping that
 *   index unless `prune` is on — an identical one is accepted as is, a
 *   different one is a conflict that refuses the run;
 * - undeclared indexes are kept (and reported) unless `prune` is on;
 * - a rebuild that drops a unique index to build a unique one back is a
 *   conflict unless `rebuildUnique` is on — see UNIQUE_REBUILD_REASON;
 * - `_id_` and a clustered index are the collection's own and never listed.
 */

/** Actions that change the database — what a plan "would do" and a run "did" */
const CHANGE_ACTIONS = new Set(['create', 'modify', 'recreate', 'drop']);

/** Server defaults for a collection that has a validator but did not say how to apply it */
const VALIDATOR_DEFAULTS = { validationLevel: 'strict', validationAction: 'error' };

/** Whether a row drops or rebuilds an index */
function isDestructive(action) {
  return action.target === 'index' && (action.action === 'drop' || action.action === 'recreate');
}

/**
 * Whether a row is one the CLI asks to confirm: a destructive index change,
 * or a validator change on a collection that already holds data — tightening
 * a validator (`validationAction: 'error'`) can start rejecting the
 * application's writes. A validator created with a new collection guards
 * nothing yet.
 */
function needsConfirmation(action, collectionActions = []) {
  if (isDestructive(action)) return true;
  if (action.target !== 'validator' || !CHANGE_ACTIONS.has(action.action)) return false;
  const created = collectionActions.some(
    (other) => other.target === 'collection' && other.action === 'create',
  );
  return !created;
}

/**
 * An index as data for a result row (`from` / `to`): plain JSON, the key as
 * an object, without the server-managed `v`/`ns` — what a reader of `--json`
 * or of the converge history needs to see what changed.
 */
function indexValue(spec) {
  const { key, v: _v, ns: _ns, background: _background, ...rest } = spec;
  return { key: key instanceof Map ? Object.fromEntries(key) : { ...key }, ...rest };
}

const isEmptyValidator = (validator) =>
  validator === null || (typeof validator === 'object' && Object.keys(validator).length === 0);

/** The validator state a definition asks for: `undefined` = unmanaged, `null` = none */
function desiredValidator(definition) {
  if (definition.validator === undefined) return undefined;
  if (isEmptyValidator(definition.validator)) return null;
  return {
    validator: definition.validator,
    validationLevel: definition.validationLevel ?? VALIDATOR_DEFAULTS.validationLevel,
    validationAction: definition.validationAction ?? VALIDATOR_DEFAULTS.validationAction,
  };
}

/** The validator a collection has (`null` = none). Level and action are omitted until set. */
function liveValidator(options) {
  const validator = options?.validator;
  if (validator === undefined || validator === null || isEmptyValidator(validator)) return null;
  return {
    validator,
    validationLevel: options.validationLevel ?? VALIDATOR_DEFAULTS.validationLevel,
    validationAction: options.validationAction ?? VALIDATOR_DEFAULTS.validationAction,
  };
}

function planValidator(name, desired, current, row, steps) {
  if (desired === null) {
    if (current === null) {
      row({ target: 'validator', name, action: 'unchanged' });
      return;
    }
    const action = row({ target: 'validator', name, action: 'drop', from: current });
    steps.push({ op: 'collMod', command: { validator: {} }, actions: [action] });
    return;
  }
  if (current === null) {
    const action = row({ target: 'validator', name, action: 'create', to: desired });
    steps.push({ op: 'collMod', command: { ...desired }, actions: [action] });
    return;
  }
  const diffs = [];
  if (!deepEqual(desired.validator, current.validator)) diffs.push('validator');
  if (desired.validationLevel !== current.validationLevel) diffs.push('validationLevel');
  if (desired.validationAction !== current.validationAction) diffs.push('validationAction');
  if (diffs.length === 0) {
    row({ target: 'validator', name, action: 'unchanged' });
    return;
  }
  const action = row({
    target: 'validator',
    name,
    action: 'modify',
    reason: diffs.join(', '),
    from: current,
    to: desired,
  });
  steps.push({ op: 'collMod', command: { ...desired }, actions: [action] });
}

/**
 * The reason a rebuild is refused: it drops a unique index and builds a
 * unique one back, so the constraint is gone until the build ends. A write in
 * between can add a duplicate — and then neither the new index nor the old
 * one can be built again, leaving the collection with no unique index at all.
 */
const UNIQUE_REBUILD_REASON =
  'rebuilding drops the unique constraint until the new index is built — a duplicate written ' +
  'in between leaves neither index buildable; declare it under a new name (converge, then ' +
  'remove the old declaration and converge with prune), or converge with rebuildUnique ' +
  '(CLI: --rebuild-unique)';

/** Whether a rebuild would open a window without a uniqueness the declaration keeps */
function dropsUniqueConstraint(declared, drops) {
  return declared.options.unique === true && drops.some((index) => index.options.unique === true);
}

/**
 * Whether a live index backs the collection's shard key (its key begins with
 * every shard-key field, in order) — the server refuses to drop it, so prune
 * leaves it alone instead of failing on it last.
 */
function backsShardKey(index, shardKey) {
  if (!shardKey) return false;
  const shardFields = Object.keys(shardKey);
  const fields = index.serverKey.map(([field]) => field);
  return shardFields.every((field, position) => fields[position] === field);
}

function planIndexes(declaredIndexes, live, { prune, rebuildUnique, capabilities }, row, steps) {
  const defaultCollation = live.options?.collation;
  const liveIndexes = [];
  for (const raw of live.indexes) {
    if (raw.name === '_id_' || raw.clustered === true) continue;
    liveIndexes.push(normalizeLiveIndex(raw));
  }
  const byName = new Map();
  for (const index of liveIndexes) byName.set(index.name, index);
  const declaredNames = new Set();
  for (const declared of declaredIndexes) declaredNames.add(declared.name);

  // Live indexes already accounted for — paired by name, or claimed as the
  // blocker of a declaration — so none of them is also listed as an extra.
  const consumed = new Set();
  const creates = [];
  const modifies = [];
  const pending = [];

  // Rows are made in declaration order; a pending one is settled below, once
  // the blockers are known.
  for (const declared of declaredIndexes) {
    const current = byName.get(declared.name);
    if (!current) {
      const action = row({
        target: 'index',
        name: declared.name,
        action: 'create',
        to: indexValue(declared.spec),
      });
      pending.push({ declared, live: undefined, reason: undefined, action });
      continue;
    }
    consumed.add(current.name);
    const { diffs, inPlace, rebuild } = compareIndex(
      declared,
      current,
      defaultCollation,
      capabilities,
    );
    if (diffs.length === 0) {
      row({ target: 'index', name: declared.name, action: 'unchanged' });
    } else if (!rebuild) {
      const action = row({
        target: 'index',
        name: declared.name,
        action: 'modify',
        reason: diffs.join(', '),
        from: indexValue(current.raw),
        to: indexValue(declared.spec),
      });
      const { unique, ...rest } = inPlace;
      modifies.push(
        unique
          ? // Two collMods: prepareUnique (no new duplicates from here on),
            // then unique (checks the existing data) — see converge.js.
            { op: 'convertUnique', name: declared.name, rest, actions: [action] }
          : {
              op: 'collMod',
              command: { index: { name: declared.name, ...rest } },
              actions: [action],
            },
      );
    } else {
      const reason = diffs.join(', ');
      const action = row({
        target: 'index',
        name: declared.name,
        action: 'recreate',
        reason,
        from: indexValue(current.raw),
        to: indexValue(declared.spec),
      });
      pending.push({ declared, live: current, reason, action });
    }
  }

  const collides = (declared, index) =>
    sameSignature(declared, index, defaultCollation) || (declared.isText && index.isText);

  // A declaration that the server would refuse next to an undeclared index:
  // same key, filter and collation under another name, or a second text index.
  const undeclared = [];
  for (const index of liveIndexes) {
    if (!declaredNames.has(index.name)) undeclared.push(index);
  }

  const rebuilds = [];
  for (const item of pending) {
    const { declared, action } = item;
    const blockers = [];
    for (const index of undeclared) {
      if (!consumed.has(index.name) && collides(declared, index)) blockers.push(index);
    }
    for (const blocker of blockers) consumed.add(blocker.name);
    const drops = item.live ? [item.live] : [];

    if (blockers.length > 0) {
      const names = blockers.map((blocker) => `"${blocker.name}"`).join(', ');
      const identical =
        !item.live &&
        blockers.length === 1 &&
        compareIndex(declared, blockers[0], defaultCollation).diffs.length === 0;
      action.liveName = blockers[0].name;
      action.from = indexValue(blockers[0].raw);
      if (!prune) {
        if (identical) {
          // The index the declaration describes exists, only under another
          // name. Renaming means a full rebuild (and, for a unique index, a
          // window without the constraint) — not something to do unasked.
          action.action = 'unchanged';
          action.reason = `exists as ${names}`;
        } else {
          action.action = 'conflict';
          action.reason =
            `the undeclared index ${names} covers the same key — declare it under its own ` +
            'name, or converge with prune to replace it';
        }
        continue;
      }
      drops.push(...blockers);
      action.action = 'recreate';
      action.reason = identical
        ? 'name'
        : [item.reason, `replaces ${names}`].filter(Boolean).join('; ');
    }

    if (drops.length === 0) {
      creates.push({ declared, action });
    } else if (!rebuildUnique && dropsUniqueConstraint(declared, drops)) {
      // Not done unasked: the CLI asks with --rebuild-unique, while the paths
      // nobody watches (after up, a queue job) never get this far on their own.
      action.action = 'conflict';
      action.reason = [action.reason, UNIQUE_REBUILD_REASON].filter(Boolean).join('; ');
    } else {
      rebuilds.push({ declared, action, drops });
    }
  }

  // A create that collides with an index another rebuild is about to drop has
  // to wait for that drop — and two rebuilds that swap keys each wait for the
  // other. Such entangled ones run as one group: every drop, then every create.
  const doomed = new Map();
  for (const rebuild of rebuilds) {
    for (const index of rebuild.drops) doomed.set(index.name, rebuild);
  }
  const entangled = new Set();
  for (const item of [...creates, ...rebuilds]) {
    for (const [name, owner] of doomed) {
      if (owner === item) continue;
      const index = owner.drops.find((drop) => drop.name === name);
      if (collides(item.declared, index)) {
        entangled.add(item);
        entangled.add(owner);
      }
    }
  }

  const waiting = [];
  for (const item of creates) {
    if (entangled.has(item)) {
      waiting.push(item);
      continue;
    }
    steps.push({ op: 'createIndex', spec: item.declared.spec, actions: [item.action] });
  }
  steps.push(...modifies);
  const group = { op: 'rebuild', drops: [], creates: [], actions: [] };
  for (const item of [...rebuilds, ...waiting]) {
    const step = entangled.has(item)
      ? group
      : { op: 'rebuild', drops: [], creates: [], actions: [] };
    for (const index of item.drops ?? []) {
      step.drops.push({ name: index.name, restore: restoreSpec(index.raw) });
    }
    step.creates.push({ spec: item.declared.spec, action: item.action });
    step.actions.push(item.action);
    if (step !== group) steps.push(step);
  }
  if (group.actions.length > 0) steps.push(group);

  // Last, so an index is only ever removed once everything declared exists.
  for (const index of liveIndexes) {
    if (consumed.has(index.name) || declaredNames.has(index.name)) continue;
    if (prune && backsShardKey(index, live.shardKey)) {
      row({
        target: 'index',
        name: index.name,
        action: 'keep',
        reason: 'backs the shard key',
        from: indexValue(index.raw),
      });
    } else if (prune) {
      const action = row({
        target: 'index',
        name: index.name,
        action: 'drop',
        reason: 'not declared',
        from: indexValue(index.raw),
      });
      steps.push({ op: 'dropIndex', name: index.name, actions: [action] });
    } else {
      row({
        target: 'index',
        name: index.name,
        action: 'keep',
        reason: 'not declared',
        from: indexValue(index.raw),
      });
    }
  }
}

/**
 * Plan one collection. `definition` is a normalized definition (see
 * collections.js); `live` is `{ exists, type?, options?, indexes }` as
 * converge.js reads it. Returns `{ name, actions, steps }`: `actions` are the
 * result rows (status `'planned'`), `steps` the operations that carry them
 * out, in execution order, each pointing at the rows it settles.
 */
/**
 * Fold every run of consecutive `createIndex` steps into one `createIndexes`:
 * the server builds several indexes in a single pass over the collection, so
 * three new indexes on a large collection cost one scan, not three. Only
 * neighbours merge — the order between creates, modifications, rebuilds and
 * drops is kept as planned.
 */
function batchCreates(steps) {
  const batched = [];
  for (const step of steps) {
    const last = batched.at(-1);
    if (step.op !== 'createIndex') {
      batched.push(step);
    } else if (last?.op === 'createIndexes') {
      last.specs.push(step.spec);
      last.actions.push(...step.actions);
    } else {
      batched.push({ op: 'createIndexes', specs: [step.spec], actions: [...step.actions] });
    }
  }
  return batched;
}

function planCollection(definition, live, options = {}) {
  const plan = planCollectionSteps(definition, live, options);
  return { ...plan, steps: batchCreates(plan.steps) };
}

function planCollectionSteps(
  definition,
  live,
  { prune = false, rebuildUnique = false, capabilities = {} } = {},
) {
  const name = definition.name;
  const actions = [];
  const steps = [];
  const row = (fields) => {
    const action = { ...fields, status: 'planned' };
    actions.push(action);
    return action;
  };

  if (live.exists && live.type !== undefined && live.type !== 'collection') {
    row({
      target: 'collection',
      name,
      action: 'conflict',
      reason: `is a ${live.type}, not a regular collection`,
    });
    return { name, actions, steps };
  }

  const desired = desiredValidator(definition);
  const declaredIndexes = definition.indexes;

  if (!live.exists) {
    // Nothing worth creating an empty collection for — a definition that only
    // says "no validator" is already true of a collection that does not exist.
    if (!desired && !(declaredIndexes?.length > 0)) return { name, actions, steps };
    const linked = [row({ target: 'collection', name, action: 'create' })];
    if (desired) {
      linked.push(row({ target: 'validator', name, action: 'create', to: desired }));
    }
    steps.push({ op: 'createCollection', options: desired ? { ...desired } : {}, actions: linked });
    for (const declared of declaredIndexes ?? []) {
      const action = row({
        target: 'index',
        name: declared.name,
        action: 'create',
        to: indexValue(declared.spec),
      });
      steps.push({ op: 'createIndex', spec: declared.spec, actions: [action] });
    }
    return { name, actions, steps };
  }

  if (desired !== undefined) {
    planValidator(name, desired, liveValidator(live.options), row, steps);
  }
  if (declaredIndexes !== undefined) {
    planIndexes(declaredIndexes, live, { prune, rebuildUnique, capabilities }, row, steps);
  }
  return { name, actions, steps };
}

/** Counts over planned (or executed) collections */
function summarize(collections) {
  let changes = 0;
  let applied = 0;
  let conflicts = 0;
  let destructive = 0;
  for (const collection of collections) {
    for (const action of collection.actions) {
      if (action.action === 'conflict') conflicts += 1;
      if (!CHANGE_ACTIONS.has(action.action)) continue;
      changes += 1;
      if (action.status === 'applied') applied += 1;
      if (isDestructive(action)) destructive += 1;
    }
  }
  return { changes, applied, conflicts, destructive };
}

module.exports = {
  CHANGE_ACTIONS,
  UNIQUE_REBUILD_REASON,
  VALIDATOR_DEFAULTS,
  desiredValidator,
  indexValue,
  isDestructive,
  isEmptyValidator,
  needsConfirmation,
  liveValidator,
  planCollection,
  summarize,
};
