const { ConfigInvalidError, LockAlreadyHeldError } = require('../../errors/index.js');
const { createColors } = require('../../utils/colors.js');
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
const ALL_FLAGS = new Set(Object.values(FLAGS).flat());

/** What `run --all` drives */
const RUNNABLE = new Set(['blocked', 'pending', 'running']);

/** Actions a name is required for */
const NEEDS_NAME = new Set(['pause', 'resume', 'cancel', 'retry', 'repin', 'dry-run', 'unlock']);

const flagName = (key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** A positive integer flag, or undefined when not given */
function integerFlag(opts, key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (opts[key] === undefined) return undefined;
  const value = Number(opts[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigInvalidError(`${flagName(key)} must be an integer from ${min} to ${max}`, {
      [key]: opts[key],
    });
  }
  return value;
}

/** Check the action, its name and its flags — before anything connects */
function preflight(opts, [action, name]) {
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
}

/** The controls that cannot be taken back ask first; `--json` needs `--yes` */
async function confirmed(action, state, { opts, json, logger }) {
  const asks =
    action === 'cancel' ||
    action === 'repin' ||
    action === 'unlock' ||
    (action === 'retry' && opts.fromStart);
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
}

/**
 * `watch`: the live drift watcher in the foreground — every collection with a
 * completed background migration, or the one named — until SIGINT or
 * SIGTERM, which end it cleanly (exit 0): streams closed, positions saved,
 * locks released. What it does is printed as it happens.
 */
async function watchAction(migrator, opts, collection, { logger, json }) {
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
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const handlers = ['SIGINT', 'SIGTERM'].map((signal) => [
    signal,
    () => {
      controller.abort();
      stop();
    },
  ]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const watcher = await migrator.watchBackground({
      ...(collection !== undefined ? { collections: [collection] } : {}),
      ...(opts.report ? { upgrade: false } : {}),
      signal: controller.signal,
      onError: (error, where) =>
        logger.warn(`⚠ Drift watcher${where ? ` (${where})` : ''}: ${error?.message ?? error}`),
    });
    if (!json) logger.info('Watching for old-shape writes — Ctrl-C to stop');
    await stopped;
    const rows = watcher.status();
    await watcher.stop();
    return { watch: rows };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    migrator.off('background:watch', onWatch);
    migrator.off('background:drift', onDrift);
  }
}

/** `run`: drive one background migration (or every runnable one, in order) from here */
async function runAction(migrator, opts, name, { logger }) {
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
  const handlers = ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => onSignal(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const names = [];
    if (opts.all) {
      for (const state of await migrator.backgroundStatus()) {
        if (RUNNABLE.has(state.status)) names.push(state.migration);
      }
    } else {
      names.push(name);
    }
    const results = [];
    for (const target of names) {
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
      results.push(
        await migrator.runBackground(target, {
          signal: controller.signal,
          concurrency,
          untilDone: !opts.once,
        }),
      );
    }
    return results;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

const STATUS_COLORS = {
  completed: 'green',
  running: 'cyan',
  pending: 'yellow',
  blocked: 'yellow',
  paused: 'yellow',
  failed: 'red',
  cancelled: 'dim',
};

function renderStatuses(states) {
  const colors = createColors(process.stdout);
  const rows = states.map((state) => {
    const color = colors[STATUS_COLORS[state.status]] ?? ((text) => text);
    const parts = state.partitions;
    return [
      state.migration,
      color(state.status),
      state.collection ?? '—',
      state.from !== undefined ? `${state.from} → ${state.to}` : 'step',
      String(state.pass),
      parts ? `${parts.done}/${parts.total}` : '—',
      `${state.liveLeases}/${state.maxParallel}`,
      String(state.totals.migrated ?? 0),
      state.waitsFor.length > 0
        ? `waits for ${state.waitsFor.join(', ')}`
        : (state.lastError ?? ''),
    ];
  });
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
}

function renderPartitions(partitions) {
  return renderTable(
    ['#', 'Status', 'Scope', 'Migrated', 'Lease', 'Claims', 'Error'],
    partitions.map((partition) => [
      String(partition.seq),
      partition.status,
      partition.scope.kind === 'step'
        ? 'step'
        : `${partition.scope.bracket ?? ''}${partition.group ? ` @${partition.group}` : ''}`,
      String(partition.counters.migrated ?? 0),
      partition.lease
        ? `slot ${partition.lease.slot} · ${partition.lease.host}:${partition.lease.pid}`
        : '',
      String(partition.claims),
      partition.lastError ?? '',
    ]),
  );
}

/** Register the `background` command */
function registerBackground(program) {
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
    run: async (migrator, opts, [action, name], cli) => {
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
        if (states.some((state) => state.status === 'failed')) {
          logger.error('✖ A background migration failed');
          process.exitCode = EXIT_CODES.BACKGROUND_FAILED;
        } else if (states.some((state) => state.status !== 'completed')) {
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
}

/** A dry run, for people: one line per document or step, then what the sandbox saw */
function renderDryRun(dry, logger) {
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
  }
  for (const refusal of dry.refusals ?? []) {
    logger.error(`✖ Refused ${refusal.method}: ${refusal.reason}`);
  }
  if (dry.ops) logger.info(`◎ ${dry.ops.length} operation(s), all rolled back`);
  if (dry.stoppedBy === 'deadline') logger.warn('⚠ Stopped at the deadline');
}

module.exports = { registerBackground };
