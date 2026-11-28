const { defineCommand } = require('../shared.js');
const { renderImportTable } = require('../table.js');

const registerImport = (program) => {
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
    run: (migrator, flags) => {
      return migrator.import({
        noLock: flags.noLock,
        ...(flags.from ? { from: flags.from } : {}),
        ...(flags.to ? { to: flags.to } : {}),
        ...(flags.dryRun ? { dryRun: true } : {}),
        ...(flags.trustHash ? { trustHash: true } : {}),
        ...(flags.force ? { force: true } : {}),
      });
    },
    render: (result, { logger }) => {
      if (result.rows.length > 0) logger.info(renderImportTable(result.rows));
    },
  });
};

module.exports = { registerImport };
