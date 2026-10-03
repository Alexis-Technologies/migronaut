const { needsConfirmation } = require('../../core/converge-plan.js');
const { ConfigInvalidError, RunAbortedError } = require('../../errors/index.js');
const { confirm, defineCommand, EXIT_CODES } = require('../shared.js');
const { renderConvergeTable } = require('../table.js');

/**
 * Every row the operator must confirm, across all collections: a dropped or
 * rebuilt index, or a validator change on a collection that holds data.
 */
function actionsToConfirm(plan) {
  const found = [];
  for (const collection of plan.collections) {
    for (const action of collection.actions) {
      if (needsConfirmation(action, collection.actions)) {
        found.push({ collection: collection.name, ...action });
      }
    }
  }
  return found;
}

/** Whether a plan holds a conflict — the run refuses it whatever the answer */
function hasConflict(plan) {
  return plan.collections.some((collection) =>
    collection.actions.some((action) => action.action === 'conflict'),
  );
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
      ['--ordered', 'Refuse while any migration is still pending'],
      [
        '--rebuild-unique',
        'Allow rebuilding a unique index (drops the constraint until the new one is built)',
      ],
      [
        '-y, --yes',
        'Drop and rebuild indexes, and change validators, without asking (required with --json)',
      ],
    ],
    lockable: true,
    mutating: true,
    // Whether a run is destructive is only known once the live database has
    // been read, so the confirmation cannot live in a preflight: plan first,
    // ask only when the plan drops or rebuilds an index, then apply — the way
    // `unlock` reads the lock before asking.
    run: async (migrator, opts, _positionals, { logger, json, spinner, stopRequested }) => {
      const prune = {
        ...(opts.prune ? { prune: true } : {}),
        ...(opts.rebuildUnique ? { rebuildUnique: true } : {}),
      };
      const ordered = opts.ordered ? { ordered: true } : {};
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
        const destructive = actionsToConfirm(plan);
        // A plan with a conflict is refused by the run itself — asking first
        // would be a question whose answer changes nothing.
        if (destructive.length > 0 && !hasConflict(plan)) {
          // --json is non-interactive: dropping an index the operator never
          // saw listed is exactly what the confirmation is for, so it needs an
          // explicit --yes rather than a silent go-ahead. An additive plan
          // applies without one.
          if (json) {
            throw new ConfigInvalidError(
              `converge would drop or rebuild an index, or change a validator ` +
                `(${destructive.length} change(s)) — pass --yes to confirm in --json mode`,
              { destructive },
            );
          }
          logger.info(renderConvergeTable(plan));
          const uniqueRebuilds = destructive.filter(
            (action) => action.action === 'recreate' && opts.rebuildUnique,
          );
          if (uniqueRebuilds.length > 0) {
            logger.warn(
              '⚠ --rebuild-unique: a rebuilt unique index enforces nothing until it is built ' +
                'again — a duplicate written in between makes it unbuildable',
            );
          }
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
        return await migrator.converge({ noLock: opts.noLock, ...prune, ...ordered });
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
