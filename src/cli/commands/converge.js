const { needsConfirmation } = require('../../core/converge/plan.js');
const { searchBuildState } = require('../../core/converge/search-index-spec.js');
const { ConfigInvalidError, RunAbortedError } = require('../../errors/index.js');
const { confirm, defineCommand, EXIT_CODES } = require('../shared.js');
const { renderConvergeHistory, renderConvergeTable } = require('../table.js');

/**
 * Every row the operator must confirm, across all collections: a dropped or
 * rebuilt index, a dropped search index, or a validator change on a
 * collection that holds data.
 */
const listActionsToConfirm = (plan) => {
  const found = [];
  for (const collection of plan.collections) {
    for (const action of collection.actions) {
      if (needsConfirmation(action, collection.actions)) {
        found.push({ collection: collection.name, ...action });
      }
    }
  }
  return found;
};

/** Whether any row of `actions` is of the kind `kind` */
const hasAction = (actions, kind) => {
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].action === kind) return true;
  }
  return false;
};

/** Whether a plan holds a conflict — the run refuses it whatever the answer */
const hasConflict = (plan) => {
  const collections = plan.collections;
  for (let i = 0; i < collections.length; i++) {
    if (hasAction(collections[i].actions, 'conflict')) return true;
  }
  return false;
};

/** The plan-only flag a `--wait-search` came with, as the operator typed it */
const planOnlyFlag = (flags) => {
  if (flags.history) return '--history';
  if (flags.check) return '--check';
  return '--dry-run';
};

const assertNotStopped = (stopRequested) => {
  if (stopRequested()) {
    throw new RunAbortedError('Stopped by signal before anything was changed', {
      context: { results: [] },
    });
  }
};

const registerConverge = (program) => {
  defineCommand(program, {
    name: 'converge',
    description:
      'Bring declared collections (indexes, search indexes, validators) to their declared state',
    options: [
      ['--dry-run', 'Show what would change without changing anything'],
      [
        '--check',
        `Exit with code ${EXIT_CODES.ALX_ERR_COLLECTIONS_DRIFT} if anything would change (CI gate; implies --dry-run)`,
      ],
      [
        '--prune',
        'Drop undeclared indexes and search indexes (in collections whose definition does not decide)',
      ],
      ['--ordered', 'Refuse while any migration is still pending'],
      ['--reason <text>', 'Why — recorded in the converge history (who: the OS user)'],
      ['--history', 'Show the converge history instead of converging (read-only)'],
      ['--limit <n>', 'How many history entries to show (with --history; default 20)'],
      [
        '--rebuild-unique',
        'Allow rebuilding a unique index (drops the constraint until the new one is built)',
      ],
      [
        '--wait-search',
        'Wait until every declared search index is queryable (overrides waitForSearchIndexes)',
      ],
      ['--no-wait-search', 'Do not wait for search indexes, whatever waitForSearchIndexes says'],
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
    run: async (migrator, flags, _positionals, { logger, json, spinner, stopRequested }) => {
      const waitSearch = typeof flags.waitSearch === 'boolean' ? flags.waitSearch : undefined;
      if (waitSearch !== undefined && (flags.history || flags.dryRun || flags.check)) {
        throw new ConfigInvalidError(
          `--${waitSearch ? '' : 'no-'}wait-search applies to a real converge — not to ` +
            planOnlyFlag(flags),
        );
      }
      if (flags.history) {
        return migrator.convergeHistory(
          flags.limit !== undefined ? { limit: Number(flags.limit) } : {},
        );
      }
      if (flags.limit !== undefined) {
        throw new ConfigInvalidError('--limit only applies to --history');
      }
      const prune = {
        ...(flags.prune ? { prune: true } : {}),
        ...(flags.rebuildUnique ? { rebuildUnique: true } : {}),
      };
      const ordered = flags.ordered ? { ordered: true } : {};
      const isPlanOnly = Boolean(flags.dryRun || flags.check);
      if (isPlanOnly || !flags.yes) {
        spinner?.start('Comparing declared collections with the database…');
        let plan = null;
        try {
          plan = await migrator.converge({ dryRun: true, ...prune });
        } finally {
          spinner?.stop();
        }
        if (isPlanOnly) return plan;
        assertNotStopped(stopRequested);
        const destructive = listActionsToConfirm(plan);
        // A plan with a conflict is refused by the run itself — asking first
        // would be a question whose answer changes nothing.
        if (destructive.length > 0 && !hasConflict(plan)) {
          // --json is non-interactive: dropping an index the operator never
          // saw listed is exactly what the confirmation is for, so it needs an
          // explicit --yes rather than a silent go-ahead. An additive plan
          // applies without one.
          if (json) {
            throw new ConfigInvalidError(
              `converge would drop or rebuild an index, drop a search index, or change a validator ` +
                `(${destructive.length} change(s)) — pass --yes to confirm in --json mode`,
              { context: { destructive } },
            );
          }
          logger.info(renderConvergeTable(plan));
          if (flags.rebuildUnique && hasAction(destructive, 'recreate')) {
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
        return await migrator.converge({
          noLock: flags.noLock,
          ...prune,
          ...ordered,
          ...(waitSearch !== undefined ? { waitForSearchIndexes: waitSearch } : {}),
          ...(flags.reason !== undefined ? { reason: flags.reason } : {}),
        });
      } finally {
        spinner?.stop();
      }
    },
    render: (result, { logger, flags }) => {
      if (Array.isArray(result)) return void logger.info(renderConvergeHistory(result));
      // A real run's own lines (✔ Created …, the rollup) are already out.
      if (!result.dryRun) return;
      if (result.collections.length === 0) {
        return void logger.info('No collections declared — set collections or collectionsDir');
      }
      logger.info(renderConvergeTable(result, { all: Boolean(flags.verbose) }));
    },
    after: (result, { logger, flags }) => {
      if (!flags.check || result === undefined) return;
      // A search index that failed to build serves nothing, whatever its
      // definition says — the gate fails on it too, though converge cannot fix it.
      // .error writes to stderr, so JSON stdout stays a single clean document.
      let failed = 0;
      for (const index of result.search?.notReady ?? []) {
        if (searchBuildState(index) !== 'failed') continue;
        failed += 1;
        logger.error(
          `✖ Search index ${index.collection} "${index.name}" failed to build` +
            `${index.message ? `: ${index.message}` : ''}`,
        );
      }
      if (result.inSync && failed === 0) return;
      if (!result.inSync) logger.error('✖ The database differs from the declared collections');
      // A dedicated code: a CI gate must tell "out of step" (act: converge)
      // from "the check itself crashed" (act: page).
      process.exitCode = EXIT_CODES.ALX_ERR_COLLECTIONS_DRIFT;
    },
  });
};

module.exports = { registerConverge };
