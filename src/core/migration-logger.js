const { isPlainObject } = require('../utils/canonical.js');
const { errorText } = require('../utils/error.js');
const { BOUNDS, redactBounded, redactOutbound } = require('../utils/redact.js');

/**
 * The logger a migration gets as `ctx.logger`, and the `migration:log` event.
 *
 * Every call is a line on the kit's own logger with the run's correlation
 * bound into its fields (run id, migration, direction, batch, attempt, job) —
 * a JSON sink can join it to the kit's lines, the changelog and the queue job
 * without parsing anything. A call whose fields say `userland: true` is also
 * emitted as `migration:log`, for the application to keep: migronaut stores
 * none of it. The marker is per call, so operational noise stays in the logs
 * and only what the author meant for their users reaches the event.
 *
 * Mechanism only: no kit, no decisions about where lines go — `sink` is the
 * kit's resolved logger, `emitter` its event channel.
 */

const MIGRATION_LOG_EVENT = 'migration:log';
const USERLAND = 'userland';

/** The longest message an event carries; the log line keeps the whole one */
const MAX_MESSAGE_LENGTH = 2048;

/** A counter, one per run (or lane slice): orders a run's events within one millisecond */
function sequence() {
  let next = 0;
  return () => {
    next += 1;
    return next;
  };
}

/**
 * The run-level correlation of an ordinary run, frozen — `ctx.run` in
 * `beforeAll`/`afterAll`, and what every migration's own adds to.
 * `base` holds the run id and, when the caller gave them, the job and the
 * actor: `{ id, jobId?, groupId?, requestedBy?, reason? }`.
 */
function runInfo(base, direction) {
  return Object.freeze({ id: base.id, direction, ...withoutId(base) });
}

/** `ctx.run` of one attempt of one migration — a new frozen object per attempt */
function migrationRunInfo(run, { migration, batch, attempt }) {
  return Object.freeze({
    ...run,
    migration,
    ...(batch !== undefined ? { batch } : {}),
    attempt,
  });
}

function withoutId(base) {
  const rest = {};
  for (const key of Object.keys(base)) {
    if (key !== 'id' && base[key] !== undefined) rest[key] = base[key];
  }
  return rest;
}

/** Keys of `info` a log line leaves out: who asked and why go to the event only */
const EVENT_ONLY = new Set(['requestedBy', 'reason']);

/**
 * The one mapping from a context's correlation (`ctx.run`, or a background
 * migration's `ctx.background`) to what a log line binds and what the event
 * carries — so the three can never disagree. `id` becomes `runId`, a
 * background `name` becomes `migration`; undefined values are left out.
 */
function correlationOf(kind, info, direction) {
  const event = { kind };
  const line = {};
  const put = (key, value) => {
    if (value === undefined) return;
    event[key] = value;
    if (!EVENT_ONLY.has(key)) line[key] = value;
  };
  if (kind === 'background') {
    put('runId', info.runId);
    put('migration', info.name);
    put('direction', direction);
    for (const key of Object.keys(info)) {
      if (key !== 'runId' && key !== 'name') put(key, info[key]);
    }
  } else {
    put('runId', info.id);
    for (const key of Object.keys(info)) {
      if (key !== 'id') put(key, info[key]);
    }
  }
  return { event, line };
}

/** A log message as text: an Error by its (redacted) message, anything else stringified */
function messageText(msg) {
  if (typeof msg === 'string') return msg;
  if (msg instanceof Error) return errorText(msg);
  return msg === undefined ? '' : String(msg);
}

/**
 * What a run's loggers have already said about themselves — one debug line
 * each for a call dropped and a call cut to the event's bounds, per run (or
 * lane slice), not per call: `{ dropped, truncated }`.
 */
function notices() {
  return { dropped: false, truncated: false };
}

/**
 * A logger bound to one context's correlation.
 *
 * - `sink` — the kit's resolved logger (already guarded, `null` config → silent);
 * - `kind` — `'migration'` or `'background'`, and `info` — the frozen
 *   `ctx.run` / `ctx.background` (`direction` given separately for background);
 * - `emitter` — `{ wanted(), emit(payload) }`, absent where nothing may be
 *   emitted (a dry run); `nextSeq` — the run's counter;
 * - `noticed` — the run's {@link notices}: a dropped or a cut call leaves one
 *   debug line, since an invisible one is undebuggable;
 * - `dryRun` — marks every line, and emits nothing.
 *
 * Pino's own argument order — `(fields, msg)` — is accepted too.
 */
function createMigrationLogger({
  sink,
  kind,
  info,
  direction,
  emitter,
  nextSeq,
  noticed = notices(),
  dryRun = false,
}) {
  const { event, line } = correlationOf(kind, info, direction);
  if (dryRun) line.dryRun = true;
  /** The one debug line for `what` (a key of `noticed`) — the call that caused it goes on */
  const notice = (what, text) => {
    if (noticed[what]) return;
    noticed[what] = true;
    sink.debug(text, { ...line });
  };
  const write = (level) => (first, second) => {
    // Logging must never break a migration: a getter that throws, a message
    // that cannot be stringified — the call is dropped, the run goes on.
    try {
      let msg = first;
      let fields = second;
      if (isPlainObject(first) && (second === undefined || typeof second === 'string')) {
        msg = second;
        fields = first;
      }
      const text = messageText(msg);
      const plain = isPlainObject(fields);
      if (plain) sink[level](text, { ...fields, ...line });
      else if (fields === undefined) sink[level](text, { ...line });
      else sink[level](text, { ...line, value: fields });
      if (!plain || fields[USERLAND] !== true || !emitter || dryRun || !emitter.wanted()) return;
      const data = redactBounded(fields, { omit: USERLAND });
      // The event leaves the process: the values a server error quotes (an
      // E11000's duplicate key) are masked too, as everywhere text leaves it.
      // The log line keeps them — it is what a developer debugs with.
      const message = redactOutbound(text);
      const clipped = message.length > MAX_MESSAGE_LENGTH;
      const truncated = data.truncated || clipped;
      emitter.emit({
        ...event,
        level,
        msg: clipped ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message,
        data: data.value,
        at: new Date(),
        seq: nextSeq(),
        ...(truncated ? { truncated: true } : {}),
      });
      if (truncated) {
        notice(
          'truncated',
          'A ctx.logger call was cut to the bounds of its migration:log event ' +
            `(message ${MAX_MESSAGE_LENGTH} characters; data ${BOUNDS.depth} levels, ` +
            `${BOUNDS.entries} entries, ${BOUNDS.string}-character strings)`,
        );
      }
    } catch (error) {
      // See above: dropped — but said once, at debug level.
      try {
        notice('dropped', `A ctx.logger call was dropped: ${errorText(error)}`);
      } catch {
        // Not even that: the thrown value cannot be described.
      }
    }
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  MIGRATION_LOG_EVENT,
  USERLAND,
  correlationOf,
  createMigrationLogger,
  migrationRunInfo,
  notices,
  runInfo,
  sequence,
};
