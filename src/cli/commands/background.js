const { ConfigInvalidError, LockAlreadyHeldError } = require('../../errors/index.js');
const { createColors } = require('../../utils/colors.js');
const { errorText } = require('../../utils/error.js');
const { confirm, defineCommand, EXIT_CODES } = require('../shared.js');
const { renderTable } = require('../table.js');

/**
 * `migronaut background <action> [name]` — background migrations from the
 * command line: see them, run them, control them, dry-run them, watch for
 * drift. One command with an action (the argument parser has one level of
 * subcommands); each action takes the flags it needs and refuses the others.
 */

const ACTIONS = new Set([
  'status',
  'run',
  'pause',
  'resume',
  'cancel',
  'retry',
  'repin',
  'dry-run',
  'unlock',
  'verify',
  'watch',
]);

/** Which flags each action takes (besides the global ones) */
const FLAGS = {
  status: ['partitions', 'check'],
  run: ['all', 'concurrency', 'once'],
  pause: ['wait', 'reason'],
  resume: ['reason'],
  cancel: ['wait', 'reason', 'yes'],
  retry: ['fromStart', 'repin', 'reason', 'yes'],
  repin: ['reason', 'yes'],
  'dry-run': [
    'sample',
    'first',
    'validate',
    'steps',
    'revert',
    'maxDocs',
    'fromStart',
    'deadlineMs',
  ],
  unlock: ['yes'],
  verify: ['report'],
  watch: ['report'],
};

/** Every flag of a `FLAGS`-shaped table, in table order */
const flagsOf = (table) => {
  const flags = new Set();
  const actions = Object.keys(table);
  for (let i = 0; i < actions.length; i++) {
    const keys = table[actions[i]];
    for (let j = 0; j < keys.length; j++) flags.add(keys[j]);
  }
  return flags;
};

const ALL_FLAGS = flagsOf(FLAGS);

/** What `run --all` drives */
const RUNNABLE = new Set(['blocked', 'pending', 'running']);

/** Actions a name is required for */
const NEEDS_NAME = new Set(['pause', 'resume', 'cancel', 'retry', 'repin', 'dry-run', 'unlock']);

/** Controls that cannot be taken back, so they ask first (and `retry --from-start`) */
const ASKS_FIRST = new Set(['cancel', 'repin', 'unlock']);

/** The signals a foreground action ends on */
const SIGNALS = ['SIGINT', 'SIGTERM'];

const flagName = (key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** A positive integer flag, or undefined when not given */
const integerFlag = (opts, key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (opts[key] === undefined) return undefined;
  const value = Number(opts[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigInvalidError(`${flagName(key)} must be an integer from ${min} to ${max}`, {
      [key]: opts[key],
    });
  }
  return value;
};

/** Check the action, its name and its flags — before anything connects */
const preflight = (opts, positionals) => {
  const action = positionals[0];
  const name = positionals[1];
  if (!ACTIONS.has(action)) {
    throw new ConfigInvalidError(
      `Unknown background action "${action}" (one of: ${[...ACTIONS].join(', ')})`,
    );
  }
  if (NEEDS_NAME.has(action) && name === undefined) {
    throw new ConfigInvalidError(`background ${action} needs a migration name`);
  }
  if (action === 'run' && (name === undefined) === !opts.all) {
    throw new ConfigInvalidError('background run takes a migration name, or --all');
  }
  if (action === 'verify' && name !== undefined) {
    throw new ConfigInvalidError('background verify checks every background migration — no name');
  }
  const allowed = new Set(FLAGS[action]);
  for (const key of ALL_FLAGS) {
    if (opts[key] !== undefined && opts[key] !== false && !allowed.has(key)) {
      throw new ConfigInvalidError(`${flagName(key)} does not apply to background ${action}`);
    }
  }
  integerFlag(opts, 'concurrency', { max: 64 });
  integerFlag(opts, 'sample', { max: 1000 });
  integerFlag(opts, 'first', { max: 1000 });
  integerFlag(opts, 'steps', { max: 50 });
  integerFlag(opts, 'maxDocs', { max: 1000 });
  integerFlag(opts, 'deadlineMs', { max: 50_000 });
  return true;
};

/** The controls that cannot be taken back ask first; `--json` needs `--yes` */
const confirmed = async (action, state, { opts, json, logger }) => {
  const asks = ASKS_FIRST.has(action) || (action === 'retry' && opts.fromStart);
  if (!asks || opts.yes) return true;
  if (json) {
    throw new ConfigInvalidError(
      `background ${action} needs confirmation — pass --yes in --json mode`,
    );
  }
  if (state) {
    logger.warn(
      `⚠ ${state.migration} is ${state.status} (pass ${state.pass}, ` +
        `${state.totals.migrated ?? 0} migrated, ${state.liveLeases} lane(s) working)`,
    );
  }
  const what = action === 'retry' ? 'retry from the start' : action;
  return confirm(`${what[0].toUpperCase()}${what.slice(1)} ${state?.migration ?? 'it'}? [y/N] `);
};

/** Install `handlerFor(signal)` on each of {@link SIGNALS}; returns what removes them again */
const onSignals = (handlerFor) => {
  const handlers = [];
  for (let i = 0; i < SIGNALS.length; i++) {
    const signal = SIGNALS[i];
    const handler = handlerFor(signal);
    process.on(signal, handler);
    handlers.push({ signal, handler });
  }
  return () => {
    for (let i = 0; i < handlers.length; i++) {
      const { signal, handler } = handlers[i];
      process.off(signal, handler);
    }
  };
};

/**
 * `watch`: the live drift watcher in the foreground — every collection with a
 * completed background migration, or the one named — until SIGINT or
 * SIGTERM, which end it cleanly (exit 0): streams closed, positions saved,
 * locks released. What it does is printed as it happens.
 */
const watchAction = async (migrator, opts, collection, { logger, json }) => {
  const controller = new AbortController();
  const onWatch = (event) => logger.info(`… ${event.collection}: ${event.state}`);
  const onDrift = (event) => {
    if (event.source !== 'stream') return;
    const line = `${event.collection}: ${event.action} (${event.migration})`;
    if (event.action === 'upgraded') logger.info(`✔ ${line}`);
    else logger.warn(`⚠ ${line}`);
  };
  if (!json) {
    migrator.on('background:watch', onWatch);
    migrator.on('background:drift', onDrift);
  }
  const { promise: stopped, resolve: stop } = Promise.withResolvers();
  const detachSignals = onSignals(() => () => {
    controller.abort();
    stop();
  });
  try {
    const watcher = await migrator.watchBackground({
      ...(collection !== undefined ? { collections: [collection] } : {}),
      ...(opts.report ? { upgrade: false } : {}),
      signal: controller.signal,
      onError: (error, where) =>
        logger.warn(`⚠ Drift watcher${where ? ` (${where})` : ''}: ${errorText(error)}`),
    });
    if (!json) logger.info('Watching for old-shape writes — Ctrl-C to stop');
    await stopped;
    const rows = watcher.status();
    await watcher.stop();
    return { watch: rows };
  } finally {
    detachSignals();
    migrator.off('background:watch', onWatch);
    migrator.off('background:drift', onDrift);
  }
};

/** `run`: drive one background migration (or every runnable one, in order) from here */
const runAction = async (migrator, opts, name, { logger }) => {
  const concurrency = integerFlag(opts, 'concurrency', { max: 64 }) ?? 1;
  const controller = new AbortController();
  let stopping = false;
  const onSignal = (signal) => {
    if (stopping) process.exit(signal === 'SIGINT' ? 130 : 143);
    stopping = true;
    logger.warn(
      `⚠ ${signal} received — the lanes stop at their next batch; the background migration ` +
        'goes on from there next time. Press again to exit immediately.',
    );
    controller.abort();
  };
  const detachSignals = onSignals((signal) => () => onSignal(signal));
  try {
    const runOne = async (target) => {
      const status = await migrator.backgroundStatus(target);
      if (status === null) {
        throw new ConfigInvalidError(
          `Background migration ${target} is not registered — run up first`,
        );
      }
      if (concurrency > status.maxParallel) {
        logger.warn(
          `⚠ --concurrency ${concurrency} is more than ${target}'s maxParallel ` +
            `(${status.maxParallel}) — using ${status.maxParallel}`,
        );
      }
      if (opts.once) {
        const answer = await migrator.coordinateBackground(target, {
          signal: controller.signal,
          driver: { kind: 'cli' },
        });
        if (answer.next === 'busy') {
          throw new LockAlreadyHeldError(`Another process is coordinating ${target} right now`, {
            migration: target,
          });
        }
      }
      return migrator.runBackground(target, {
        signal: controller.signal,
        concurrency,
        untilDone: !opts.once,
      });
    };
    if (!opts.all) return [await runOne(name)];
    // Round after round: one that waited for another (run later in the same
    // round) is unblocked when that one completes, and runs in the next.
    // Done when a round changes nothing, or after one with --once.
    const results = new Map();
    let previous = '';
    for (;;) {
      const runnable = [];
      for (const state of await migrator.backgroundStatus()) {
        if (RUNNABLE.has(state.status)) runnable.push(state.migration);
      }
      const key = runnable.join('\n');
      if (runnable.length === 0 || key === previous) break;
      previous = key;
      for (const target of runnable) results.set(target, await runOne(target));
      if (opts.once) break;
    }
    return [...results.values()];
  } finally {
    detachSignals();
  }
};

const STATUS_COLORS = {
  __proto__: null,
  completed: 'green',
  running: 'cyan',
  pending: 'yellow',
  blocked: 'yellow',
  paused: 'yellow',
  failed: 'red',
  cancelled: 'dim',
};

const renderStatuses = (states) => {
  const colors = createColors(process.stdout);
  const rows = [];
  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const color = colors[STATUS_COLORS[state.status]] ?? ((text) => text);
    const parts = state.partitions;
    rows.push([
      state.migration,
      color(state.status),
      state.collection ?? '—',
      state.from !== undefined ? `${state.from} → ${state.to}` : 'step',
      `${state.pass}`,
      parts ? `${parts.done}/${parts.total}` : '—',
      `${state.liveLeases}/${state.maxParallel}`,
      `${state.totals.migrated ?? 0}`,
      state.waitsFor.length > 0
        ? `waits for ${state.waitsFor.join(', ')}`
        : (state.lastError ?? ''),
    ]);
  }
  return renderTable(
    [
      'Background migration',
      'Status',
      'Collection',
      'Versions',
      'Pass',
      'Partitions',
      'Lanes',
      'Migrated',
      'Note',
    ],
    rows,
  );
};

/** A partition's scope: `step`, or its bracket and group */
const scopeText = (partition) => {
  if (partition.scope.kind === 'step') return 'step';
  const group = partition.group ? ` @${partition.group}` : '';
  return `${partition.scope.bracket ?? ''}${group}`;
};

const renderPartitions = (partitions) => {
  const rows = [];
  for (let i = 0; i < partitions.length; i++) {
    const partition = partitions[i];
    rows.push([
      `${partition.seq}`,
      partition.status,
      scopeText(partition),
      `${partition.counters.migrated ?? 0}`,
      partition.lease
        ? `slot ${partition.lease.slot} · ${partition.lease.host}:${partition.lease.pid}`
        : '',
      `${partition.claims}`,
      partition.lastError ?? '',
    ]);
  }
  return renderTable(['#', 'Status', 'Scope', 'Migrated', 'Lease', 'Claims', 'Error'], rows);
};

/** What `status --check` makes of the states: 'failed', 'pending', or '' when all completed */
const checkOutcome = (states) => {
  let outcome = '';
  for (let i = 0; i < states.length; i++) {
    const status = states[i].status;
    if (status === 'failed') return 'failed';
    if (status !== 'completed') outcome = 'pending';
  }
  return outcome;
};

/** Register the `background` command */
const registerBackground = (program) => {
  defineCommand(program, {
    name: 'background',
    description:
      'Background migrations: status, run, pause, resume, cancel, retry, repin, dry-run, unlock, ' +
      'verify, watch',
    args: [
      [
        '<action>',
        'status | run | pause | resume | cancel | retry | repin | dry-run | unlock | verify | watch',
      ],
      ['[name]', 'The background migration (its file name) — watch: a collection'],
    ],
    options: [
      ['--partitions', 'status: list the partitions of the latest generation'],
      [
        '--check',
        `status: exit ${EXIT_CODES.BACKGROUND_FAILED} if one failed, ${EXIT_CODES.BACKGROUND_PENDING} if one is not completed`,
      ],
      ['--all', 'run: every runnable background migration, in order'],
      ['--concurrency <n>', 'run: lanes in this process (at most its maxParallel; default 1)'],
      ['--once', 'run: one round, not to the end'],
      ['--wait', 'pause, cancel: wait until no lane works any more'],
      ['--from-start', 'retry: plan everything again; dry-run: from no checkpoint'],
      ['--repin', 'retry: pin the file on disk first'],
      ['--sample <n>', 'dry-run: a random sample of n documents (default 5)'],
      ['--first <n>', 'dry-run: the first n documents by _id'],
      ['--validate', 'dry-run: through the real write path, in an always-aborted transaction'],
      ['--steps <k>', 'dry-run: run k steps of a step migration (default 1)'],
      ['--revert', 'dry-run: the way back'],
      ['--max-docs <n>', 'dry-run: document images to keep (default 20)'],
      ['--deadline-ms <ms>', 'dry-run: stop the sandbox after this long (default 50000)'],
      ['--report', 'verify: only report drift, never reopen; watch: never upgrade'],
      ['--reason <text>', 'controls: why — recorded in its history'],
      ['-y, --yes', 'cancel, retry --from-start, repin, unlock: do not ask (required with --json)'],
    ],
    spinner: false,
    preflight: (opts, positionals) => preflight(opts, positionals),
    run: async (migrator, opts, positionals, cli) => {
      const action = positionals[0];
      const name = positionals[1];
      const control = {
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        ...(opts.wait ? { wait: true } : {}),
      };
      switch (action) {
        case 'status': {
          if (opts.partitions) {
            if (name === undefined) {
              throw new ConfigInvalidError('background status --partitions needs a name');
            }
            return { partitions: await migrator.backgroundPartitions(name) };
          }
          if (name !== undefined) {
            const one = await migrator.backgroundStatus(name);
            if (one === null) {
              throw new ConfigInvalidError(`Background migration ${name} is not registered`);
            }
            return { background: [one] };
          }
          return { background: await migrator.backgroundStatus() };
        }
        case 'run':
          return { background: await runAction(migrator, opts, name, cli) };
        case 'pause':
          return migrator.pauseBackground(name, control);
        case 'resume':
          return migrator.resumeBackground(name, control);
        case 'cancel':
        case 'repin':
        case 'retry':
        case 'unlock': {
          const state = await migrator.backgroundStatus(name);
          if (!(await confirmed(action, state, { ...cli, opts }))) {
            cli.logger.info('Aborted');
            return undefined;
          }
          if (action === 'cancel') return migrator.cancelBackground(name, control);
          if (action === 'repin') return migrator.repinBackground(name, control);
          if (action === 'unlock') return migrator.unlockBackground(name);
          return migrator.retryBackground(name, {
            ...control,
            ...(opts.fromStart ? { fromStart: true } : {}),
            ...(opts.repin ? { repin: true } : {}),
          });
        }
        case 'dry-run':
          return {
            dryRun: await migrator.dryRunBackground(name, {
              ...(opts.sample !== undefined ? { sample: Number(opts.sample) } : {}),
              ...(opts.first !== undefined ? { first: Number(opts.first) } : {}),
              ...(opts.validate ? { validate: true } : {}),
              ...(opts.steps !== undefined ? { steps: Number(opts.steps) } : {}),
              ...(opts.revert ? { direction: 'revert' } : {}),
              ...(opts.maxDocs !== undefined ? { maxDocuments: Number(opts.maxDocs) } : {}),
              ...(opts.fromStart ? { fromStart: true } : {}),
              ...(opts.deadlineMs !== undefined ? { deadlineMs: Number(opts.deadlineMs) } : {}),
            }),
          };
        case 'watch':
          return watchAction(migrator, opts, name, cli);
        default:
          return {
            verify: await migrator.verifyBackground(opts.report ? { onDrift: 'report' } : {}),
          };
      }
    },
    render: (data, { logger }) => {
      if (data.partitions) {
        logger.info(renderPartitions(data.partitions));
      } else if (data.background) {
        if (data.background.length === 0) logger.info('No background migrations registered');
        else logger.info(renderStatuses(data.background));
      } else if (data.dryRun) {
        renderDryRun(data.dryRun, logger);
      } else if (data.verify) {
        const { checked, skipped, drift } = data.verify;
        if (drift.length === 0) {
          logger.info(`✔ No drift (${checked} checked, ${skipped} skipped)`);
        }
        for (const entry of drift) {
          logger.warn(
            `⚠ ${entry.collection}: old-shape documents after ${entry.migration} — ${entry.action}`,
          );
        }
      } else if (data.watch) {
        let upgraded = 0;
        for (const row of data.watch) upgraded += row.counters.upgraded;
        logger.info(`✔ Stopped watching — ${upgraded} document(s) upgraded`);
      } else if (data.applied !== undefined) {
        logger.info(`✔ ${data.applied === 'changed' ? 'Done' : 'Nothing to do'} — ${data.status}`);
      } else if (data.leases !== undefined) {
        logger.info(
          `✔ Released the coordinator lock${data.lock ? '' : ' (none held)'} and ${data.leases} lease(s)`,
        );
      }
    },
    after: (data, { opts, logger }) => {
      if (data === undefined) return;
      const states = data.background;
      if (opts.check && Array.isArray(states)) {
        const outcome = checkOutcome(states);
        if (outcome === 'failed') {
          logger.error('✖ A background migration failed');
          process.exitCode = EXIT_CODES.BACKGROUND_FAILED;
        } else if (outcome === 'pending') {
          logger.error('✖ Background migrations are not all completed');
          process.exitCode = EXIT_CODES.BACKGROUND_PENDING;
        }
      }
      if (data.verify?.drift.length > 0) process.exitCode = EXIT_CODES.BACKGROUND_PENDING;
      const dry = data.dryRun;
      if (dry !== undefined) {
        if (dry.mode === 'step') {
          if (dry.refusals.length > 0) process.exitCode = EXIT_CODES.SANDBOX_REFUSED;
          else if (!dry.ok) process.exitCode = 1;
        } else if (dry.refusals?.length > 0) {
          process.exitCode = EXIT_CODES.SANDBOX_REFUSED;
        } else if (dry.migrated === 0) {
          process.exitCode = 1;
        }
      }
    },
  });
};

/** A dry run, for people: one line per document or step, then what the sandbox saw */
const renderDryRun = (dry, logger) => {
  if (dry.mode === 'step') {
    for (const step of dry.steps) {
      logger.info(
        `◎ Step ${step.step}: ${JSON.stringify(step.checkpointIn)} → ` +
          `${step.error ? `✖ ${step.error}` : JSON.stringify(step.checkpointOut)}${step.done ? ' (done)' : ''}`,
      );
    }
  } else {
    for (const row of dry.documents) {
      const id = JSON.stringify(row._id);
      if (row.error) logger.warn(`✖ ${id}: ${row.error}`);
      else logger.info(`✔ ${id}: ${JSON.stringify(row.change ?? row.after)}`);
    }
    logger.info(`◎ ${dry.migrated} of ${dry.found} would be migrated, ${dry.failed} would fail`);
    if (dry.degraded === 'sample-timeout') {
      logger.warn('⚠ The sample ran out of time — these are the first documents by _id instead');
    }
  }
  for (const refusal of dry.refusals ?? []) {
    logger.error(`✖ Refused ${refusal.method}: ${refusal.reason}`);
  }
  if (dry.ops) logger.info(`◎ ${dry.ops.length} operation(s), all rolled back`);
  if (dry.stoppedBy === 'deadline') logger.warn('⚠ Stopped at the deadline');
};

module.exports = { registerBackground };
