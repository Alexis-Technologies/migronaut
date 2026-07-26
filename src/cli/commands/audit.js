const { createColors } = require('../../utils/colors.js');
const { createLogger } = require('../../utils/logger.js');
const { emitJson, withMigrator } = require('../shared.js');

/** Symbol and color for each check outcome */
function renderStatus(status) {
  const colors = createColors(process.stdout);
  if (status === 'pass') return colors.green('✔');
  if (status === 'warn') return colors.yellow('!');
  return colors.red('✖');
}

/** Register the `audit` command (read-only diagnostics) */
function registerAudit(program) {
  program
    .command('audit')
    .description('Check the migronaut setup: config, connectivity, transactions, indexes, lock')
    .option('--json', 'Output machine-readable JSON of the report')
    .action(async (_opts, command) => {
      const opts = command.optsWithGlobals();
      await withMigrator(
        opts,
        async (migrator) => {
          const report = await migrator.audit();

          if (opts.json) {
            emitJson(report);
          } else {
            const logger = createLogger();
            for (const check of report.checks) {
              logger.info(`${renderStatus(check.status)} ${check.name.padEnd(12)} ${check.detail}`);
            }
            logger.info(
              report.ok
                ? `\nNo problems found (${report.warnings} warning(s))`
                : `\n${report.failed} check(s) failed, ${report.warnings} warning(s)`,
            );
          }

          // A failed check is what CI should act on; warnings are advisory.
          if (!report.ok) process.exitCode = 1;
        },
        // audit() connects on its own and reports the outcome as a check.
        { spinner: true, connect: false, ...(opts.json ? { json: true } : {}) },
      );
    });
}

module.exports = { registerAudit };
