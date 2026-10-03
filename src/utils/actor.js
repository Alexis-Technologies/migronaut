/**
 * Who asked for a run, and why: `requestedBy` and `reason`, stamped on what
 * the run writes to the changelog (and on a converge's history entry). Kept
 * apart from `executedBy` — the OS user that ran it, which on a queue worker
 * is the container's, not the person behind the request.
 *
 * The one definition of the two fields' limits, shared by the kit's options
 * and the queue's job contract, so a producer can never send what its worker
 * refuses.
 */
const ACTOR_LIMITS = Object.freeze({ requestedBy: 128, reason: 512 });

/** The problem with an actor field, or null when it is absent or valid */
function actorIssue(key, value) {
  if (value === undefined) return null;
  const max = ACTOR_LIMITS[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return `${key} must be a non-empty string of at most ${max} characters`;
  }
  return null;
}

/** Just the actor fields of `source` that are set */
function pickActor(source) {
  const actor = {};
  for (const key of Object.keys(ACTOR_LIMITS)) {
    if (source?.[key] !== undefined) actor[key] = source[key];
  }
  return actor;
}

/**
 * The actor fields of `options` as changelog fields: `requestedBy` / `reason`
 * for what a run applies, `<prefix>RequestedBy` / `<prefix>Reason` for what
 * it reverts (`prefix: 'revert'`), so a revert never overwrites who applied.
 */
function actorFields(options, prefix) {
  const fields = {};
  if (options?.requestedBy !== undefined) {
    fields[prefix ? `${prefix}RequestedBy` : 'requestedBy'] = options.requestedBy;
  }
  if (options?.reason !== undefined) {
    fields[prefix ? `${prefix}Reason` : 'reason'] = options.reason;
  }
  return fields;
}

module.exports = { ACTOR_LIMITS, actorFields, actorIssue, pickActor };
