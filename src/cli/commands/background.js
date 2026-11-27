const { ConfigInvalidError, LockAlreadyHeldError } = require('../../errors/index.js');
const { createColors } = require('../../utils/colors.js');
const { formatError } = require('../../utils/error.js');
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

/** What `run --all` drives */
const RUNNABLE = new Set(['blocked', 'pending', 'running']);

/** Actions a name is required for */
const NEEDS_NAME = new Set(['pause', 'resume', 'cancel', 'retry', 'repin', 'dry-run', 'unlock']);

/** Controls that cannot be taken back, so they ask first (and `retry --from-start`) */
const ASKS_FIRST = new Set(['cancel', 'repin', 'unlock']);

/** The signals a foreground action ends on */
const SIGNALS = ['SIGINT', 'SIGTERM'];

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

/** Every flag of a `FLAGS`-shaped table, in table order */
const listFlags = (table) => {
  const flags = new Set();
  const actions = Object.keys(table);
  for (let i = 0; i < actions.length; i++) {
    const keys = table[actions[i]];
    for (let j = 0; j < keys.length; j++) flags.add(keys[j]);
  }
  return flags;
};

const ALL_FLAGS = listFlags(FLAGS);

const toFlagName = (key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

/** A positive integer flag, or undefined when not given */
const readIntegerFlag = (flags, key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (flags[key] === undefined) return undefined;
  const value = Number(flags[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigInvalidError(`${toFlagName(key)} must be an integer from ${min} to ${max}`, {
      context: { [key]: flags[key] },
    });
  }
  return value;
};

/** Check the action, its name and its flags — before anything connects */
const preflight = (flags, positionals) => {
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
  if (action === 'run' && (name === undefined) === !flags.all) {
    throw new ConfigInvalidError('background run takes a migration name, or --all');
  }
  if (action === 'verify' && name !== undefined) {
    throw new ConfigInvalidError('background verify checks every background migration — no name');
  }
  const allowed = new Set(FLAGS[action]);
  for (const key of ALL_FLAGS) {
    if (flags[key] !== undefined && flags[key] !== false && !allowed.has(key)) {
      throw new ConfigInvalidError(`${toFlagName(key)} does not apply to background ${action}`);
    }
  }
  readIntegerFlag(flags, 'concurrency', { max: 64 });
  readIntegerFlag(flags, 'sample', { max: 1000 });
  readIntegerFlag(flags, 'first', { max: 1000 });
  readIntegerFlag(flags, 'steps', { max: 50 });
  readIntegerFlag(flags, 'maxDocs', { max: 1000 });
  readIntegerFlag(flags, 'deadlineMs', { max: 50_000 });
  return true;
};

/** The controls that cannot be taken back ask first; `--json` needs `--yes` */
const askToConfirm = async (action, state, { flags, json, logger }) => {
  const asks = ASKS_FIRST.has(action) || (action === 'retry' && flags.fromStart);
  if (!asks || flags.yes) return true;
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
const watchAction = async (migrator, flags, collection, { logger, json }) => {
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
  const detachSignals = onSignals(() => {
    return () => {
      controller.abort();
      stop();
    };
  });
  try {
    const watcher = await migrator.watchBackground({
      ...(collection !== undefined ? { collections: [collection] } : {}),
      ...(flags.report ? { upgrade: false } : {}),
      signal: controller.signal,
      onError: (error, where) => {
        return logger.warn(`⚠ Drift watcher${where ? ` (${where})` : ''}: ${formatError(error)}`);
      },
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
const runAction = async (migrator, flags, name, { logger }) => {
  const concurrency = readIntegerFlag(flags, 'concurrency', { max: 64 }) ?? 1;
  const controller = new AbortController();
  let isStopping = false;
  const onSignal = (signal) => {
    if (isStopping) process.exit(signal === 'SIGINT' ? 130 : 143);
    isStopping = true;
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
      if (flags.once) {
        const answer = await migrator.coordinateBackground(target, {
          signal: controller.signal,
          driver: { kind: 'cli' },
        });
        if (answer.next === 'busy') {
          throw new LockAlreadyHeldError(`Another process is coordinating ${target} right now`, {
            context: { migration: target },
          });
        }
      }
      return migrator.runBackground(target, {
        signal: controller.signal,
        concurrency,
        untilDone: !flags.once,
      });
    };
    if (!flags.all) return [await runOne(name)];
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
      if (flags.once) break;
    }
    return [...results.values()];
  } finally {
    detachSignals();
  }
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
const formatScope = (partition) => {
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
      formatScope(partition),
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
        `status: exit ${EXIT_CODES.ALX_ERR_BACKGROUND_FAILED} if one failed, ${EXIT_CODES.ALX_ERR_BACKGROUND_PENDING} if one is not completed`,
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
    preflight: (flags, positionals) => preflight(flags, positionals),
    run: async (migrator, flags, positionals, cli) => {
      const action = positionals[0];
      const name = positionals[1];
      const control = {
        ...(flags.reason !== undefined ? { reason: flags.reason } : {}),
        ...(flags.wait ? { wait: true } : {}),
      };
      switch (action) {
        case 'status': {
          if (flags.partitions) {
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
          return { background: await runAction(migrator, flags, name, cli) };
        case 'pause':
          return migrator.pauseBackground(name, control);
        case 'resume':
          return migrator.resumeBackground(name, control);
        case 'cancel':
        case 'repin':
        case 'retry':
        case 'unlock': {
          const state = await migrator.backgroundStatus(name);
          if (!(await askToConfirm(action, state, { ...cli, flags }))) {
            cli.logger.info('Aborted');
            return undefined;
          }
          if (action === 'cancel') return migrator.cancelBackground(name, control);
          if (action === 'repin') return migrator.repinBackground(name, control);
          if (action === 'unlock') return migrator.unlockBackground(name);
          return migrator.retryBackground(name, {
            ...control,
            ...(flags.fromStart ? { fromStart: true } : {}),
            ...(flags.repin ? { repin: true } : {}),
          });
        }
        case 'dry-run':
          return {
            dryRun: await migrator.dryRunBackground(name, {
              ...(flags.sample !== undefined ? { sample: Number(flags.sample) } : {}),
              ...(flags.first !== undefined ? { first: Number(flags.first) } : {}),
              ...(flags.validate ? { validate: true } : {}),
              ...(flags.steps !== undefined ? { steps: Number(flags.steps) } : {}),
              ...(flags.revert ? { direction: 'revert' } : {}),
              ...(flags.maxDocs !== undefined ? { maxDocuments: Number(flags.maxDocs) } : {}),
              ...(flags.fromStart ? { fromStart: true } : {}),
              ...(flags.deadlineMs !== undefined ? { deadlineMs: Number(flags.deadlineMs) } : {}),
            }),
          };
        case 'watch':
          return watchAction(migrator, flags, name, cli);
        default:
          return {
            verify: await migrator.verifyBackground(flags.report ? { onDrift: 'report' } : {}),
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
    after: (data, { flags, logger }) => {
      if (data === undefined) return;
      const states = data.background;
      if (flags.check && Array.isArray(states)) {
        const outcome = checkOutcome(states);
        if (outcome === 'failed') {
          logger.error('✖ A background migration failed');
          process.exitCode = EXIT_CODES.ALX_ERR_BACKGROUND_FAILED;
        } else if (outcome === 'pending') {
          logger.error('✖ Background migrations are not all completed');
          process.exitCode = EXIT_CODES.ALX_ERR_BACKGROUND_PENDING;
        }
      }
      if (data.verify?.drift.length > 0) process.exitCode = EXIT_CODES.ALX_ERR_BACKGROUND_PENDING;
      const dry = data.dryRun;
      if (dry !== undefined) {
        if (dry.mode === 'step') {
          if (dry.refusals.length > 0) process.exitCode = EXIT_CODES.ALX_ERR_SANDBOX_REFUSED;
          else if (!dry.ok) process.exitCode = 1;
        } else if (dry.refusals?.length > 0) {
          process.exitCode = EXIT_CODES.ALX_ERR_SANDBOX_REFUSED;
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
