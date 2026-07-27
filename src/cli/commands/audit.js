const { createColors } = require('../../utils/colors.js');
const { defineCommand } = require('../shared.js');

/** Symbol and color for each check outcome */
function renderStatus(colors, status) {
  if (status === 'pass') return colors.green('✔');
  if (status === 'warn') return colors.yellow('!');
  return colors.red('✖');
}

/** Register the `audit` command (read-only diagnostics) */
function registerAudit(program) {
  defineCommand(program, {
    name: 'audit',
    description: 'Check the migronaut setup: config, connectivity, transactions, indexes, lock',
    options: [['--json', 'Output machine-readable JSON of the report']],
    // audit() connects on its own and reports the outcome as a check.
    connect: false,
    run: (migrator) => migrator.audit(),
    render: (report, { logger }) => {
      const colors = createColors(process.stdout);
      for (const check of report.checks) {
        logger.info(
          `${renderStatus(colors, check.status)} ${check.name.padEnd(12)} ${check.detail}`,
        );
      }
      logger.info(
        report.ok
          ? `\nNo problems found (${report.warnings} warning(s))`
          : `\n${report.failed} check(s) failed, ${report.warnings} warning(s)`,
      );
    },
    // A failed check is what CI should act on; warnings are advisory.
    after: (report) => {
      if (!report.ok) process.exitCode = 1;
    },
  });
}

module.exports = { registerAudit };
