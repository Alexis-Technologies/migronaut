const { randomUUID } = require('node:crypto');
const { ConfigInvalidError } = require('../errors/index.js');
const { errorText } = require('./error.js');

/**
 * Longest id migronaut accepts. Also the limit a queue worker enforces on a
 * job's group id — one constant, so a producer can never mint an id its own
 * worker would reject.
 */
const MAX_ID_LENGTH = 128;

/**
 * The default id: a random (v4) UUID. This module is the only place in `src/`
 * that mints one — everything else asks for an id through it, which is what
 * lets the `generateId` config option replace the format everywhere at once.
 */
const randomId = () => randomUUID();

/**
 * Return `value` when it is usable as an id, throw otherwise. An id is stored
 * as a string field (changelog `runId`, lock `owner`, a job's `groupId`) and
 * gated on by truthiness in the kit, so an empty or non-string value would
 * silently switch off the reentrancy guard and the owner-scoped lock release.
 */
function assertId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new ConfigInvalidError(
      `generateId must return a non-empty string of at most ${MAX_ID_LENGTH} characters`,
      typeof value === 'string' ? { length: value.length } : { returned: typeof value },
    );
  }
  return value;
}

/**
 * Turn the `generateId` config option into the function the kit mints ids
 * with. `undefined` keeps the default (`randomId`); anything else must be a
 * function, and every id it returns is checked.
 *
 * The user's function is called bare — no arguments, no receiver — so a
 * third-party generator passes straight through (`generateId: ulid`,
 * `generateId: nanoid`): their first parameter means something of its own
 * (a seed time, a size), and any argument migronaut passed would be read as it.
 *
 * It must be synchronous: the run id is minted in the same tick as the
 * reentrancy guard that checks it, and a promise would be stored as a truthy
 * non-id.
 */
function createIdGenerator(generateId) {
  if (generateId === undefined) return randomId;
  if (typeof generateId !== 'function') {
    throw new ConfigInvalidError('generateId must be a function', {
      generateId: typeof generateId,
    });
  }
  return () => {
    let value;
    try {
      value = generateId();
    } catch (error) {
      throw new ConfigInvalidError(
        'generateId threw',
        { cause: errorText(error) },
        { cause: error },
      );
    }
    if (typeof value?.then === 'function') {
      // The promise is dropped, so its rejection must not surface as an
      // unhandled one on top of the error below.
      value.then(undefined, () => {});
      throw new ConfigInvalidError('generateId must be synchronous — it returned a promise');
    }
    return assertId(value);
  };
}

module.exports = { MAX_ID_LENGTH, assertId, createIdGenerator, randomId };
