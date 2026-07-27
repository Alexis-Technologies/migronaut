const { confirm, defineCommand, emitJson } = require('../shared.js');

/** Register the `unlock` command (force-release a stuck migration lock) */
function registerUnlock(program) {
  defineCommand(program, {
    name: 'unlock',
    description: 'Force-release a stuck migration lock left behind by a crashed run',
    options: [
      ['-y, --yes', 'Skip the confirmation prompt'],
      ['--json', 'Output machine-readable JSON ({ released, holder })'],
    ],
    mutating: true,
    // Owns its output: the confirmation flow branches mid-way, so the shared
    // "emit what run() returned" envelope does not fit.
    run: async (migrator, opts, _positionals, { logger, json }) => {
      const holder = await migrator.lockInfo();

      if (!holder) {
        if (json) emitJson({ released: false, holder: null });
        else logger.info('No migration lock is currently held');
        return undefined;
      }

      // Confirm before clearing — unless --yes, or --json (non-interactive).
      if (!json && !opts.yes) {
        const since = holder.lockedAt.toISOString();
        logger.warn(
          `⚠ Lock held by pid ${holder.pid} on ${holder.host} (${holder.executedBy}) since ${since}`,
        );
        const proceed = await confirm('Force-release this lock? [y/N] ');
        if (!proceed) {
          logger.info('Aborted');
          return undefined;
        }
      }

      const released = await migrator.forceUnlock();
      if (json) emitJson({ released: released !== null, holder: released });
      else logger.info('✔ Lock released');
      return undefined;
    },
  });
}

module.exports = { registerUnlock };
