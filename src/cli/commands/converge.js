const { isDestructive } = require('../../core/converge-plan.js');
const { ConfigInvalidError, RunAbortedError } = require('../../errors/index.js');
const { confirm, defineCommand, EXIT_CODES } = require('../shared.js');
const { renderConvergeTable } = require('../table.js');

/** Every row a run would drop or rebuild an index for, across all collections */
function destructiveActions(plan) {
  const found = [];
  for (const collection of plan.collections) {
    for (const action of collection.actions) {
      if (isDestructive(action)) found.push({ collection: collection.name, ...action });
    }
  }
  return found;
}

function assertNotStopped(stopRequested) {
  if (stopRequested()) {
    throw new RunAbortedError('Stopped by signal before anything was changed', { results: [] });
  }
}

/** Register the `converge` command (declared indexes and validators → the database) */
function registerConverge(program) {
  defineCommand(program, {
    name: 'converge',
    description: 'Bring declared collections (indexes, validators) to their declared state',
    options: [
      ['--dry-run', 'Show what would change without changing anything'],
      [
        '--check',
        `Exit with code ${EXIT_CODES.COLLECTIONS_DRIFT} if anything would change (CI gate; implies --dry-run)`,
      ],
      ['--prune', 'Drop undeclared indexes (in collections whose definition does not decide)'],
      ['-y, --yes', 'Drop and rebuild indexes without asking (required for that with --json)'],
    ],
    lockable: true,
    mutating: true,
    // Whether a run is destructive is only known once the live database has
    // been read, so the confirmation cannot live in a preflight: plan first,
    // ask only when the plan drops or rebuilds an index, then apply — the way
    // `unlock` reads the lock before asking.
    run: async (migrator, opts, _positionals, { logger, json, spinner, stopRequested }) => {
      const prune = opts.prune ? { prune: true } : {};
      const planOnly = Boolean(opts.dryRun || opts.check);
      if (planOnly || !opts.yes) {
        spinner?.start('Comparing declared collections with the database…');
        let plan;
        try {
          plan = await migrator.converge({ dryRun: true, ...prune });
        } finally {
          spinner?.stop();
        }
        if (planOnly) return plan;
        assertNotStopped(stopRequested);
        const destructive = destructiveActions(plan);
        if (destructive.length > 0) {
          // --json is non-interactive: dropping an index the operator never
          // saw listed is exactly what the confirmation is for, so it needs an
          // explicit --yes rather than a silent go-ahead. An additive plan
          // applies without one.
          if (json) {
            throw new ConfigInvalidError(
              `converge would drop or rebuild ${destructive.length} index(es) — pass --yes to ` +
                'confirm in --json mode',
              { destructive },
            );
          }
          logger.info(renderConvergeTable(plan));
          const proceed = await confirm('Apply these changes? [y/N] ');
          if (!proceed) {
            logger.info('Aborted');
            return undefined;
          }
          assertNotStopped(stopRequested);
        }
      }
      spinner?.start('Converging…');
      try {
        return await migrator.converge({ noLock: opts.noLock, ...prune });
      } finally {
        spinner?.stop();
      }
    },
    render: (result, { logger, opts }) => {
      // A real run's own lines (✔ Created …, the rollup) are already out.
      if (!result.dryRun) return;
      if (result.collections.length === 0) {
        logger.info('No collections declared — set collections or collectionsDir');
        return;
      }
      logger.info(renderConvergeTable(result, { all: Boolean(opts.verbose) }));
    },
    after: (result, { logger, opts }) => {
      if (!opts.check || result === undefined || result.inSync) return;
      // .error writes to stderr, so JSON stdout stays a single clean document.
      logger.error('✖ The database differs from the declared collections');
      // A dedicated code: a CI gate must tell "out of step" (act: converge)
      // from "the check itself crashed" (act: page).
      process.exitCode = EXIT_CODES.COLLECTIONS_DRIFT;
    },
  });
}

module.exports = { registerConverge };
