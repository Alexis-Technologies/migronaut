const { createLogger } = require('../../utils/logger.js');
const { emitJson, withMigrator } = require('../shared.js');
const { renderImportTable } = require('../table.js');

/** Register the `import` command (adopt a migrate-mongo changelog) */
function registerImport(program) {
  program
    .command('import')
    .description('Adopt an existing migrate-mongo changelog into the migronaut changelog')
    .option('--from <collection>', 'Source collection to read (default: changelog)')
    .option(
      '--to <collection>',
      'Target collection to write (default: config migrationsCollection)',
    )
    .option('--dry-run', 'Preview the mapping without writing anything')
    .option('--trust-hash', 'Reuse the source fileHash instead of recomputing from disk')
    .option('--force', 'Proceed even when the target changelog already has records')
    .option('--no-lock', 'Skip the concurrency lock (dev only)')
    .option('--json', 'Output machine-readable JSON instead of a table')
    .action(async (_opts, command) => {
      const opts = command.optsWithGlobals();

      await withMigrator(
        opts,
        async (migrator) => {
          const result = await migrator.import({
            noLock: opts.lock === false,
            ...(opts.from ? { from: opts.from } : {}),
            ...(opts.to ? { to: opts.to } : {}),
            ...(opts.dryRun ? { dryRun: true } : {}),
            ...(opts.trustHash ? { trustHash: true } : {}),
            ...(opts.force ? { force: true } : {}),
          });
          if (opts.json) {
            emitJson(result);
          } else if (result.rows.length > 0) {
            createLogger().info(renderImportTable(result.rows));
          }
        },
        { spinner: true, ...(opts.json ? { json: true } : {}) },
      );
    });
}

module.exports = { registerImport };
