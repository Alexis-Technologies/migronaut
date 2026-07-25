const { emitJson, withMigrator } = require('../shared.js');

/** Register the `redo` command */
function registerRedo(program) {
  program
    .command('redo')
    .description('Rollback then re-apply the last applied migration, or a specific file')
    .argument('[file]', 'Specific migration file to redo')
    .option('--json', 'Output machine-readable JSON of the run results')
    .action(async (file, _opts, command) => {
      const opts = command.optsWithGlobals();
      await withMigrator(
        opts,
        async (migrator) => {
          const results = await migrator.redo(file);
          if (opts.json) {
            emitJson(results);
          }
        },
        { spinner: true, ...(opts.json ? { json: true } : {}) },
      );
    });
}

module.exports = { registerRedo };
