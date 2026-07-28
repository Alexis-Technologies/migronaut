const { defineCommand } = require('../shared.js');
const { renderImportTable } = require('../table.js');

/** Register the `import` command (adopt a migrate-mongo changelog) */
function registerImport(program) {
  defineCommand(program, {
    name: 'import',
    description: 'Adopt an existing migrate-mongo changelog into the migronaut changelog',
    options: [
      ['--from <collection>', 'Source collection to read (default: changelog)'],
      ['--to <collection>', 'Target collection to write (default: config migrationsCollection)'],
      ['--dry-run', 'Preview the mapping without writing anything'],
      ['--trust-hash', 'Reuse the source fileHash instead of recomputing from disk'],
      ['--force', 'Proceed even when the target changelog already has records'],
    ],
    lockable: true,
    mutating: true,
    run: (migrator, opts) =>
      migrator.import({
        noLock: opts.noLock,
        ...(opts.from ? { from: opts.from } : {}),
        ...(opts.to ? { to: opts.to } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}),
        ...(opts.trustHash ? { trustHash: true } : {}),
        ...(opts.force ? { force: true } : {}),
      }),
    render: (result, { logger }) => {
      if (result.rows.length > 0) logger.info(renderImportTable(result.rows));
    },
  });
}

module.exports = { registerImport };
