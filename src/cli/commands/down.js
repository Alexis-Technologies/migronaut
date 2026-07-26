const { emitJson, withMigrator } = require('../shared.js');

/** Register the `down` command */
function registerDown(program) {
  program
    .command('down')
    .description(
      'Rollback the last batch, a specific batch, the last N steps, or a single named file',
    )
    .argument('[file]', 'Specific migration file to revert')
    .option('--no-lock', 'Skip the concurrency lock (dev only)')
    .option('--batch <n>', 'Revert a specific batch number')
    .option('--steps <n>', 'Revert the last N migrations, regardless of batch')
    .option('--to <file>', 'Revert everything applied after this file (it stays applied)')
    .option('--json', 'Output machine-readable JSON of the run results')
    .action(async (file, _opts, command) => {
      const opts = command.optsWithGlobals();
      await withMigrator(
        opts,
        async (migrator) => {
          const results = await migrator.down(file, {
            noLock: opts.lock === false,
            // `!== undefined`, not truthiness: `--batch 0` is a mistake worth
            // reporting, not one to silently drop. Core validates the value.
            ...(opts.batch !== undefined ? { batch: Number(opts.batch) } : {}),
            ...(opts.steps !== undefined ? { steps: Number(opts.steps) } : {}),
            ...(opts.to ? { to: opts.to } : {}),
          });
          if (opts.json) {
            emitJson(results);
          }
        },
        { spinner: true, ...(opts.json ? { json: true } : {}) },
      );
    });
}

module.exports = { registerDown };
